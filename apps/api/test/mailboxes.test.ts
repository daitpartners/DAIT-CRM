import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { MicrosoftClient } from '../src/auth/microsoft';
import { CONNECT_SCOPES } from '../src/auth/microsoft';
import { prisma } from '../src/db';
import { decrypt, encrypt } from '../src/crypto/tokens';
import { enqueue } from '../src/jobs/queue';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

const RAW_TOKEN = 'raw-refresh-token-0123456789';

function fakeMicrosoft(opts: { refreshToken?: string; email?: string } = {}) {
  const seen: { connectMode?: string; redeemScopes?: string[] } = {};
  const client: MicrosoftClient = {
    async getAuthUrl({ state }) {
      return `https://login.example.test/authorize?state=${encodeURIComponent(state)}`;
    },
    async getConnectUrl({ state, mode }) {
      seen.connectMode = mode;
      return `https://login.example.test/authorize?connect=1&state=${encodeURIComponent(state)}`;
    },
    async redeemCode({ code, codeVerifier, scopes }) {
      if (code !== 'good-code' || !codeVerifier) throw new Error('bad code');
      seen.redeemScopes = scopes;
      return {
        oid: 'oid-system',
        email: opts.email ?? 'CRM@DaitPartners.com',
        name: 'CRM Mailbox',
        refreshToken: 'refreshToken' in opts ? opts.refreshToken : RAW_TOKEN,
        expiresOn: new Date(Date.now() + 3600_000),
      };
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

async function connectSystem(a: FastifyInstance, cookie: string) {
  const start = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=system', headers: { cookie } });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const msState = start.cookies.find((c) => c.name === 'ms_state')!;
  return a.inject({
    method: 'GET',
    url: `/api/auth/microsoft/callback?code=good-code&state=${encodeURIComponent(state)}`,
    headers: { cookie: `${cookie}; ms_state=${msState.value}` },
  });
}

async function admin() {
  return makeUser({ email: 'admin@daitpartners.com', role: 'ADMINISTRATOR' });
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('system mailbox connect', () => {
  test('connect callback with mode=system stores an encrypted token', async () => {
    const { client, seen } = fakeMicrosoft();
    const a = await app(client);
    const user = await admin();
    const cookie = await signIn(a, user);

    const res = await connectSystem(a, cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/settings/mailbox?connected=1');
    expect(seen.connectMode).toBe('system');
    expect(seen.redeemScopes).toEqual(CONNECT_SCOPES);

    const accounts = await prisma.emailAccount.findMany();
    expect(accounts).toHaveLength(1);
    const acc = accounts[0]!;
    expect(acc).toMatchObject({
      address: 'crm@daitpartners.com', provider: 'microsoft', kind: 'system', userId: user.id, status: 'connected', lastError: null,
    });
    expect(acc.refreshTokenEnc).not.toBe(RAW_TOKEN);
    expect(acc.refreshTokenEnc).not.toContain(RAW_TOKEN);
    expect(decrypt(acc.refreshTokenEnc)).toBe(RAW_TOKEN);
    expect(acc.tokenExpiresAt).toBeInstanceOf(Date);

    const logs = await prisma.auditLog.findMany({ where: { entityType: 'email_account' } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toContain(RAW_TOKEN);
    expect(JSON.stringify(logs[0])).not.toContain(acc.refreshTokenEnc);
  });

  test('reconnecting replaces the existing system mailbox', async () => {
    await prisma.emailAccount.create({
      data: { address: 'old@daitpartners.com', provider: 'microsoft', kind: 'system', refreshTokenEnc: encrypt('old'), status: 'error', lastError: 'x' },
    });
    const a = await app(fakeMicrosoft().client);
    const cookie = await signIn(a, await admin());
    await connectSystem(a, cookie);
    const accounts = await prisma.emailAccount.findMany({ where: { kind: 'system' } });
    expect(accounts.map((x) => x.address)).toEqual(['crm@daitpartners.com']);
  });

  test('missing refresh token fails the connect', async () => {
    const a = await app(fakeMicrosoft({ refreshToken: undefined }).client);
    const cookie = await signIn(a, await admin());
    const res = await connectSystem(a, cookie);
    expect(res.headers.location).toBe('/settings/mailbox?error=connect-failed');
    expect(await prisma.emailAccount.count()).toBe(0);
  });

  test('connect requires manage_users', async () => {
    const a = await app(fakeMicrosoft().client);
    const manager = await makeUser({ role: 'MANAGER' });
    const cookie = await signIn(a, manager);
    const res = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=system', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    const anon = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=system' });
    expect(anon.statusCode).toBe(401);
  });

  test('connect rejects unknown modes', async () => {
    const a = await app(fakeMicrosoft().client);
    const cookie = await signIn(a, await admin());
    const res = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=other', headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });

  test('callback refuses a system connect finished by another session', async () => {
    const a = await app(fakeMicrosoft().client);
    const cookie = await signIn(a, await admin());
    const start = await a.inject({ method: 'GET', url: '/api/auth/microsoft/connect?mode=system', headers: { cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const msState = start.cookies.find((c) => c.name === 'ms_state')!;
    const res = await a.inject({
      method: 'GET',
      url: `/api/auth/microsoft/callback?code=good-code&state=${encodeURIComponent(state)}`,
      cookies: { ms_state: msState.value },
    });
    expect(res.headers.location).toBe('/settings/mailbox?error=connect-failed');
    expect(await prisma.emailAccount.count()).toBe(0);
  });
});

describe('mailbox routes', () => {
  test('GET system as Manager returns 200, as Sales Representative 403', async () => {
    const a = await app();
    const manager = await makeUser({ role: 'MANAGER' });
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const res = await a.inject({ method: 'GET', url: '/api/mailboxes/system', headers: { cookie: await signIn(a, manager) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ account: null, pendingJobs: 0, failedJobs: 0 });
    const denied = await a.inject({ method: 'GET', url: '/api/mailboxes/system', headers: { cookie: await signIn(a, rep) } });
    expect(denied.statusCode).toBe(403);
  });

  test('GET system reports the account and job counts without secrets', async () => {
    await prisma.emailAccount.create({
      data: { address: 'crm@daitpartners.com', provider: 'microsoft', kind: 'system', refreshTokenEnc: encrypt(RAW_TOKEN), status: 'error', lastError: 'graph_send_failed status=401' },
    });
    const p = { to: ['x@example.com'], subject: 's', html: 'h', text: 't' };
    await enqueue(prisma, 'send_email', p);
    const running = await enqueue(prisma, 'send_email', p);
    await prisma.job.update({ where: { id: running.id }, data: { status: 'running' } });
    const failed = await enqueue(prisma, 'send_email', p);
    await prisma.job.update({ where: { id: failed.id }, data: { status: 'failed' } });
    const done = await enqueue(prisma, 'send_email', p);
    await prisma.job.update({ where: { id: done.id }, data: { status: 'done' } });

    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/api/mailboxes/system', headers: { cookie: await signIn(a, await admin()) } });
    const body = res.json();
    expect(body).toMatchObject({
      account: { address: 'crm@daitpartners.com', status: 'error', lastError: 'graph_send_failed status=401' },
      pendingJobs: 2,
      failedJobs: 1,
    });
    expect(Object.keys(body.account).sort()).toEqual(['address', 'lastError', 'status', 'updatedAt']);
    expect(res.body).not.toContain('refresh');
  });

  test('disconnect deletes the system mailbox, audited; Manager forbidden', async () => {
    const acc = await prisma.emailAccount.create({
      data: { address: 'crm@daitpartners.com', provider: 'microsoft', kind: 'system', refreshTokenEnc: encrypt(RAW_TOKEN), status: 'connected' },
    });
    const a = await app();
    const manager = await makeUser({ role: 'MANAGER' });
    const denied = await a.inject({ method: 'POST', url: '/api/mailboxes/system/disconnect', headers: { cookie: await signIn(a, manager) } });
    expect(denied.statusCode).toBe(403);

    const res = await a.inject({ method: 'POST', url: '/api/mailboxes/system/disconnect', headers: { cookie: await signIn(a, await admin()) } });
    expect(res.statusCode).toBe(204);
    expect(await prisma.emailAccount.count()).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'email_account', entityId: String(acc.id) } });
    expect(log.action).toBe('delete');
    expect(JSON.stringify(log)).not.toContain(acc.refreshTokenEnc);
  });
});

describe('job routes', () => {
  const p = { to: ['x@example.com'], cc: ['y@example.com'], subject: 'Quote 12', html: '<p>secret body</p>', text: 'secret body' };

  test('lists jobs with a payload summary and no bodies', async () => {
    const failed = await enqueue(prisma, 'send_email', p);
    await prisma.job.update({ where: { id: failed.id }, data: { status: 'failed', attempts: 8, lastError: 'no_system_mailbox' } });
    await enqueue(prisma, 'send_email', p);

    const a = await app();
    const cookie = await signIn(a, await makeUser({ role: 'MANAGER' }));
    const res = await a.inject({ method: 'GET', url: '/api/jobs?status=failed&type=send_email', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: failed.id, type: 'send_email', status: 'failed', attempts: 8, maxAttempts: 8, lastError: 'no_system_mailbox',
      payloadSummary: { to: ['x@example.com'], subject: 'Quote 12' },
    });
    expect(res.body).not.toContain('secret body');

    const all = await a.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
    expect(all.json().items).toHaveLength(2);
    const bad = await a.inject({ method: 'GET', url: '/api/jobs?status=bogus', headers: { cookie } });
    expect(bad.statusCode).toBe(400);
  });

  test('jobs list forbidden for Sales Representative', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: await signIn(a, await makeUser()) } });
    expect(res.statusCode).toBe(403);
  });

  test('retry requeues a failed job; 404 unknown; Manager forbidden', async () => {
    const job = await enqueue(prisma, 'send_email', p);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'failed', attempts: 8, runAt: new Date(Date.now() + 3600_000) } });
    const a = await app();
    const forbidden = await a.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, headers: { cookie: await signIn(a, await makeUser({ role: 'MANAGER' })) } });
    expect(forbidden.statusCode).toBe(403);

    const cookie = await signIn(a, await admin());
    const before = Date.now();
    const res = await a.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: job.id, status: 'queued', attempts: 0 });
    expect(res.body).not.toContain('secret body');
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(0);
    expect(after.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.runAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect((await a.inject({ method: 'POST', url: '/api/jobs/999999/retry', headers: { cookie } })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/jobs/abc/retry', headers: { cookie } })).statusCode).toBe(404);
  });

  test('retry refuses a running job', async () => {
    const job = await enqueue(prisma, 'send_email', p);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'running' } });
    const a = await app();
    const res = await a.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, headers: { cookie: await signIn(a, await admin()) } });
    expect(res.statusCode).toBe(409);
  });
});
