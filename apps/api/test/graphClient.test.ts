import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const msalState = vi.hoisted(() => ({
  refreshTokensSeen: [] as string[],
  scopes: [] as string[][],
  rotated: 'rotated-refresh-token' as string | undefined,
  error: undefined as Error | undefined,
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class {
    async acquireTokenByRefreshToken(req: { refreshToken: string; scopes: string[] }) {
      msalState.refreshTokensSeen.push(req.refreshToken);
      msalState.scopes.push(req.scopes);
      if (msalState.error) throw msalState.error;
      return { accessToken: 'access-token-xyz', expiresOn: new Date(Date.now() + 3600_000) };
    }
    getTokenCache() {
      return {
        serialize: () =>
          JSON.stringify({ RefreshToken: msalState.rotated ? { k: { secret: msalState.rotated } } : {} }),
      };
    }
  },
}));

import { prisma } from '../src/db';
import { decrypt, encrypt } from '../src/crypto/tokens';
import { createGraphClient, GRAPH_SEND_SCOPES, GraphError, isAuthFailure } from '../src/graph/client';
import { resetDb } from './helpers';

const env = { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' };
const msg = { to: ['a@example.com'], cc: ['b@example.com'], subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' };

async function account() {
  return prisma.emailAccount.create({
    data: { address: 'crm@daitpartners.com', provider: 'microsoft', kind: 'system', refreshTokenEnc: encrypt('original-rt'), status: 'connected' },
  });
}

beforeEach(async () => {
  await resetDb();
  msalState.refreshTokensSeen = [];
  msalState.scopes = [];
  msalState.rotated = 'rotated-refresh-token';
  msalState.error = undefined;
});

afterEach(() => vi.unstubAllGlobals());

describe('graph client', () => {
  test('sends mail with the access token and stores a rotated refresh token encrypted', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const acc = await account();

    await createGraphClient(env).sendMail(acc, msg);

    expect(msalState.refreshTokensSeen).toEqual(['original-rt']);
    expect(msalState.scopes[0]).toEqual(GRAPH_SEND_SCOPES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-xyz');
    expect(JSON.parse(init.body as string)).toEqual({
      message: {
        subject: 'Hello',
        body: { contentType: 'HTML', content: '<p>Hi</p>' },
        toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
        ccRecipients: [{ emailAddress: { address: 'b@example.com' } }],
      },
      saveToSentItems: true,
    });

    const stored = await prisma.emailAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(stored.refreshTokenEnc).not.toContain('rotated-refresh-token');
    expect(decrypt(stored.refreshTokenEnc)).toBe('rotated-refresh-token');
    expect(stored.tokenExpiresAt).toBeInstanceOf(Date);
  });

  test('leaves the stored token alone when MSAL does not rotate it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
    msalState.rotated = undefined;
    const acc = await account();
    await createGraphClient(env).sendMail(acc, msg);
    const stored = await prisma.emailAccount.findUniqueOrThrow({ where: { id: acc.id } });
    expect(stored.refreshTokenEnc).toBe(acc.refreshTokenEnc);
  });

  test('429 error carries status and Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'TooManyRequests' } }), {
      status: 429, headers: { 'Retry-After': '30' },
    })));
    const err = await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).message).toBe('graph_send_failed status=429 retry-after=30 code=TooManyRequests');
    expect(isAuthFailure(err)).toBe(false);
  });

  test('401 is an auth failure and never echoes the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 401 })));
    const err = (await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('graph_send_failed status=401');
    expect(isAuthFailure(err)).toBe(true);
    expect(err.message).not.toContain('access-token-xyz');
  });

  test('invalid_grant from MSAL is an auth failure', async () => {
    msalState.error = Object.assign(new Error('AADSTS70000: invalid_grant'), { errorCode: 'invalid_grant' });
    const err = await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e);
    expect(isAuthFailure(err)).toBe(true);
  });

  test('a timed-out request is retryable and the fetch carries a timeout signal', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = await createGraphClient(env).sendMail(await account(), msg).catch((e: unknown) => e);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(504);
    expect((err as GraphError).message).toBe('graph_send_failed timeout');
    expect(isAuthFailure(err)).toBe(false);
  });

  test('missing Microsoft settings fail the send clearly', async () => {
    const err = (await createGraphClient({}).sendMail(await account(), msg).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('microsoft_not_configured');
  });
});
