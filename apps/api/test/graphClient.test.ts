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
import { createGraphClient, deltaStartUrl, GRAPH_MAIL_SCOPES, GRAPH_SEND_SCOPES, GraphError, isAuthFailure } from '../src/graph/client';
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
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/crm%40daitpartners.com/sendMail');
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

  test('sends through the shared mailbox named in sendAs', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const acc = await prisma.emailAccount.update({ where: { id: (await account()).id }, data: { sendAs: 'hello@daitpartners.com' } });
    await createGraphClient(env).sendMail(acc, msg);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/users/hello%40daitpartners.com/sendMail');
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/hello%40daitpartners.com/sendMail');
    expect(msalState.scopes[0]).toContain('https://graph.microsoft.com/Mail.Send.Shared');
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

describe('graph client — mail sync and actions (2B-2)', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const call = (m: ReturnType<typeof vi.fn>, i = 0) => m.mock.calls[i] as unknown as [string, RequestInit];
  const headers = (init: RequestInit) => init.headers as Record<string, string>;

  test('deltaStartUrl asks one folder for the messages since a date, with the fields sync stores', () => {
    const url = deltaStartUrl('inbox', new Date('2026-08-24T00:00:00.000Z'));
    expect(url.startsWith('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('$filter')).toBe('receivedDateTime ge 2026-08-24T00:00:00.000Z');
    expect(q.get('$select')!.split(',')).toEqual(expect.arrayContaining(['subject', 'from', 'toRecipients', 'ccRecipients', 'receivedDateTime', 'isRead', 'conversationId', 'hasAttachments', 'body', 'isDraft']));
  });

  test('deltaPage maps messages, removals and links, with immutable ids, text bodies and pages of 50', async () => {
    const fetchMock = vi.fn(async () => json({
      value: [
        {
          id: 'g1', subject: 'Re: Proposal', from: { emailAddress: { name: 'Ana Ruiz', address: 'Ana@Acme.com' } },
          toRecipients: [{ emailAddress: { address: 'maya@daitpartners.com' } }], ccRecipients: [{ emailAddress: { address: 'cc@acme.com' } }],
          receivedDateTime: '2026-11-20T10:00:00Z', sentDateTime: '2026-11-20T09:59:00Z', isRead: false, isDraft: false,
          conversationId: 'conv-1', internetMessageId: '<m1@acme.com>', hasAttachments: true, body: { contentType: 'text', content: 'Hello' },
        },
        { id: 'g2', '@removed': { reason: 'deleted' } },
      ],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const page = await createGraphClient(env).deltaPage(await account(), 'https://graph.microsoft.com/v1.0/x');
    expect(page).toEqual({
      messages: [{
        id: 'g1', subject: 'Re: Proposal', from: { name: 'Ana Ruiz', address: 'ana@acme.com' }, to: ['maya@daitpartners.com'], cc: ['cc@acme.com'],
        receivedAt: '2026-11-20T10:00:00Z', sentAt: '2026-11-20T09:59:00Z', isRead: false, isDraft: false, conversationId: 'conv-1',
        internetMessageId: '<m1@acme.com>', hasAttachments: true, bodyText: 'Hello',
      }],
      removed: ['g2'],
      nextLink: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=abc',
      deltaLink: undefined,
    });
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://graph.microsoft.com/v1.0/x');
    expect(headers(init).Prefer).toContain('IdType="ImmutableId"');
    expect(headers(init).Prefer).toContain('odata.maxpagesize=50');
    expect(headers(init).Prefer).toContain('outlook.body-content-type="text"');
    expect(msalState.scopes[0]).toEqual(GRAPH_MAIL_SCOPES);
  });

  test('deltaPage refuses a link that is not Graph (never sends the token elsewhere)', async () => {
    const fetchMock = vi.fn(async () => json({ value: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await createGraphClient(env).deltaPage(await account(), 'https://evil.example/delta').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('an expired delta link is a GraphError with status 410', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'SyncStateNotFound' } }, 410)));
    const err = await createGraphClient(env).deltaPage(await account(), 'https://graph.microsoft.com/v1.0/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(410);
    expect((err as GraphError).message).toBe('graph_request_failed status=410 code=SyncStateNotFound');
  });

  test('markRead, moveTo, reply and attachmentNames call the message endpoints', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/attachments?$select=name') ? json({ value: [{ name: 'quote.pdf' }, { name: 'logo.png' }] }) : json({}, url.endsWith('/reply') ? 202 : 200));
    vi.stubGlobal('fetch', fetchMock);
    const g = createGraphClient(env);
    const acc = await account();
    await g.markRead(acc, 'id/1', true);
    await g.moveTo(acc, 'id/1', 'archive');
    await g.reply(acc, 'id/1', { to: ['ana@acme.com'], cc: ['cc@acme.com'], html: '<div>Thanks</div>' });
    expect(await g.attachmentNames(acc, 'id/1')).toEqual(['quote.pdf', 'logo.png']);

    expect(call(fetchMock, 0)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1');
    expect(call(fetchMock, 0)[1].method).toBe('PATCH');
    expect(JSON.parse(call(fetchMock, 0)[1].body as string)).toEqual({ isRead: true });
    expect(call(fetchMock, 1)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/move');
    expect(JSON.parse(call(fetchMock, 1)[1].body as string)).toEqual({ destinationId: 'archive' });
    expect(call(fetchMock, 2)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/reply');
    expect(JSON.parse(call(fetchMock, 2)[1].body as string)).toEqual({
      comment: '<div>Thanks</div>',
      message: { toRecipients: [{ emailAddress: { address: 'ana@acme.com' } }], ccRecipients: [{ emailAddress: { address: 'cc@acme.com' } }] },
    });
    expect(call(fetchMock, 3)[0]).toBe('https://graph.microsoft.com/v1.0/me/messages/id%2F1/attachments?$select=name');
    for (let i = 0; i < 4; i++) expect(headers(call(fetchMock, i)[1]).Prefer).toContain('IdType="ImmutableId"');
  });
});
