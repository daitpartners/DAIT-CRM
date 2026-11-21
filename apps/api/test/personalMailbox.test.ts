import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { MicrosoftClient } from '../src/auth/microsoft';
import { prisma } from '../src/db';
import { decrypt, encrypt } from '../src/crypto/tokens';
import { MailboxTakenError, connectPersonalMailbox } from '../src/graph/accounts';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

function fakeMicrosoft(email = 'Maya.Pillai@DaitPartners.com', refreshToken = 'personal-refresh-token') {
  const seen: { connectMode?: string } = {};
  const client: MicrosoftClient = {
    async getAuthUrl({ state }) {
      return `https://login.example.test/authorize?state=${encodeURIComponent(state)}`;
    },
    async getConnectUrl({ state, mode }) {
      seen.connectMode = mode;
      return `https://login.example.test/authorize?connect=1&state=${encodeURIComponent(state)}`;
    },
    async redeemCode({ code, codeVerifier }) {
      if (code !== 'good-code' || !codeVerifier) throw new Error('bad code');
      return { oid: 'oid-x', email, name: 'Maya Pillai', refreshToken, expiresOn: new Date(Date.now() + 3600_000) };
    },
  };
  return { client, seen };
}

const apps: FastifyInstance[] = [];
async function app(microsoft?: MicrosoftClient) {
  const a = await buildApp({ microsoft });
  apps.push(a);
  return a;
}
beforeEach(resetDb);
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const req = (a: FastifyInstance, method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  a.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

describe('personal mailboxes', () => {
  test('connectPersonalMailbox keeps one row per user; reconnecting with another address replaces it', async () => {
    const u = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    await connectPersonalMailbox({ userId: u.id, address: 'First@Daitpartners.com', refreshToken: 'tok-1' });
    const second = await connectPersonalMailbox({ userId: u.id, address: 'second@daitpartners.com', refreshToken: 'tok-2' });
    const rows = await prisma.emailAccount.findMany({ where: { userId: u.id, kind: 'personal' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe('second@daitpartners.com');
    expect(rows[0]!.id).toBe(second.id);
    expect(decrypt(rows[0]!.refreshTokenEnc)).toBe('tok-2');
  });

  test('a personal mailbox can share the system mailbox address; disconnecting it leaves the system one', async () => {
    const a = await app();
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const address = 'deepak.singh@daitpartners.com';
    await prisma.emailAccount.create({
      data: { address, provider: 'microsoft', kind: 'system', userId: admin.id, refreshTokenEnc: encrypt('sys'), status: 'connected' },
    });
    const mine = await connectPersonalMailbox({ userId: admin.id, address, refreshToken: 'mine' });
    const res = await req(a, 'POST', `/api/mailboxes/${mine.id}/disconnect`, await signIn(a, admin));
    expect(res.statusCode).toBe(204);
    const after = await prisma.emailAccount.findUnique({ where: { id: mine.id } });
    expect(after!.status).toBe('disconnected');
    expect(after!.refreshTokenEnc).toBe('');
    expect((await prisma.emailAccount.findFirst({ where: { kind: 'system' } }))!.status).toBe('connected');
  });

  test('GET /mailboxes: a rep sees only their own; an administrator sees everyone; no token in the response', async () => {
    const a = await app();
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Arjun Mehta' });
    const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Maya Pillai' });
    await connectPersonalMailbox({ userId: rep.id, address: 'arjun@daitpartners.com', refreshToken: 'r' });
    await connectPersonalMailbox({ userId: admin.id, address: 'maya@daitpartners.com', refreshToken: 'm' });

    const asRep = await req(a, 'GET', '/api/mailboxes', await signIn(a, rep));
    expect(asRep.statusCode).toBe(200);
    expect(asRep.json().mine).toMatchObject({ address: 'arjun@daitpartners.com', userName: 'Arjun Mehta', status: 'connected', syncMail: true, syncCalendar: false, sharedMailboxes: [], messageCount: 0, lastSyncAt: null });
    expect(asRep.json().all).toBeUndefined();
    expect(asRep.body).not.toContain('refreshToken');

    const asAdmin = await req(a, 'GET', '/api/mailboxes', await signIn(a, admin));
    expect(asAdmin.json().all.map((m: { address: string }) => m.address).sort()).toEqual(['arjun@daitpartners.com', 'maya@daitpartners.com']);
  });

  test('PATCH /mailboxes/:id saves options for the owner; bad addresses are refused; others get 404', async () => {
    const a = await app();
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const mine = await connectPersonalMailbox({ userId: rep.id, address: 'rep@daitpartners.com', refreshToken: 'r' });
    const cookie = await signIn(a, rep);
    const ok = await req(a, 'PATCH', `/api/mailboxes/${mine.id}`, cookie, { syncCalendar: true, sharedMailboxes: ['Hello@DaitPartners.com'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ syncCalendar: true, sharedMailboxes: ['hello@daitpartners.com'] });
    expect((await req(a, 'PATCH', `/api/mailboxes/${mine.id}`, cookie, { sharedMailboxes: ['not-an-email'] })).statusCode).toBe(400);
    const otherCookie = await signIn(a, other);
    expect((await req(a, 'PATCH', `/api/mailboxes/${mine.id}`, otherCookie, { syncMail: false })).statusCode).toBe(404);
    expect((await req(a, 'POST', `/api/mailboxes/${mine.id}/disconnect`, otherCookie)).statusCode).toBe(404);
  });

  test('connect mode=personal stores the mailbox on the user who started it and returns to Settings', async () => {
    const { client, seen } = fakeMicrosoft();
    const a = await app(client);
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const cookie = await signIn(a, rep);
    const start = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=personal', headers: { cookie } });
    expect(start.statusCode).toBe(302);
    expect(seen.connectMode).toBe('personal');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const msState = start.cookies.find((c) => c.name === 'ms_state')!;
    const back = await a.inject({
      method: 'GET',
      url: `/api/auth/microsoft/callback?code=good-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `${cookie}; ms_state=${msState.value}` },
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/settings/connections?mailbox=connected');
    const row = await prisma.emailAccount.findFirstOrThrow({ where: { kind: 'personal' } });
    expect(row).toMatchObject({ userId: rep.id, address: 'maya.pillai@daitpartners.com', status: 'connected' });
    expect(decrypt(row.refreshTokenEnc)).toBe('personal-refresh-token');
  });

  test("connecting a mailbox another user already connected is refused and leaves theirs alone", async () => {
    const owner = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const mine = await connectPersonalMailbox({ userId: owner.id, address: 'hello@daitpartners.com', refreshToken: 'owner-tok' });
    await expect(connectPersonalMailbox({ userId: other.id, address: 'Hello@DaitPartners.com', refreshToken: 'other-tok' })).rejects.toBeInstanceOf(MailboxTakenError);
    const row = await prisma.emailAccount.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.userId).toBe(owner.id);
    expect(decrypt(row.refreshTokenEnc)).toBe('owner-tok');

    // Through the callback: back to Settings with ?mailbox=taken.
    const { client } = fakeMicrosoft('hello@daitpartners.com', 'third-tok');
    const a = await app(client);
    const cookie = await signIn(a, other);
    const start = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=personal', headers: { cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const msState = start.cookies.find((c) => c.name === 'ms_state')!;
    const back = await a.inject({
      method: 'GET',
      url: `/api/auth/microsoft/callback?code=good-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: `${cookie}; ms_state=${msState.value}` },
    });
    expect(back.headers.location).toBe('/settings/connections?mailbox=taken');
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: mine.id } })).userId).toBe(owner.id);
  });

  test('a disconnected mailbox can be connected by another user', async () => {
    const a = await app();
    const owner = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const old = await connectPersonalMailbox({ userId: owner.id, address: 'shared@daitpartners.com', refreshToken: 'x' });
    await a.inject({ method: 'POST', url: `/api/mailboxes/${old.id}/disconnect`, headers: { cookie: await signIn(a, owner) } });
    const taken = await connectPersonalMailbox({ userId: other.id, address: 'shared@daitpartners.com', refreshToken: 'y' });
    expect(taken).toMatchObject({ userId: other.id, status: 'connected' });
  });

  test('a Data Research User cannot connect a personal mailbox (no use_email)', async () => {
    const { client } = fakeMicrosoft();
    const a = await app(client);
    const dr = await makeUser({ role: 'DATA_RESEARCH_USER' });
    const res = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=personal', headers: { cookie: await signIn(a, dr) } });
    expect(res.statusCode).toBe(403);
  });
});
