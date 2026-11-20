import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { MicrosoftClient } from '../src/auth/microsoft';
import { hashPassword } from '../src/auth/local';
import { requireRight, requireUser } from '../src/plugins/auth';
import { prisma } from '../src/db';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

type Identity = { oid: string; email: string; name: string };

function fakeMicrosoft(identity: Identity): MicrosoftClient {
  return {
    async getAuthUrl({ state, codeChallenge }) {
      return `https://login.example.test/authorize?state=${encodeURIComponent(state)}&code_challenge=${codeChallenge}`;
    },
    async getConnectUrl({ state }) {
      return `https://login.example.test/authorize?connect=1&state=${encodeURIComponent(state)}`;
    },
    async redeemCode({ code, codeVerifier }) {
      if (code !== 'good-code' || !codeVerifier) throw new Error('bad code');
      return identity;
    },
  };
}

/** Runs the full redirect → callback flow and returns the callback response. */
async function microsoftSignIn(app: FastifyInstance) {
  const start = await app.inject({ method: 'GET', url: '/api/auth/microsoft' });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const msState = start.cookies.find((c) => c.name === 'ms_state')!;
  expect(msState.httpOnly).toBe(true);
  return app.inject({
    method: 'GET',
    url: `/api/auth/microsoft/callback?code=good-code&state=${encodeURIComponent(state)}`,
    cookies: { ms_state: msState.value },
  });
}

const apps: FastifyInstance[] = [];
async function app(opts: Parameters<typeof buildApp>[0] = {}) {
  const a = await buildApp(opts);
  apps.push(a);
  return a;
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (apps.length) await apps.pop()!.close();
});

describe('microsoft sign-in', () => {
  test('callback creates session for registered user', async () => {
    const user = await makeUser({ email: 'manager@daitpartners.com', role: 'MANAGER' });
    const a = await app({ microsoft: fakeMicrosoft({ oid: 'oid-1', email: 'Manager@DaitPartners.com', name: 'M' }) });

    const res = await microsoftSignIn(a);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = res.cookies.find((c) => c.name === 'crm_session')!;
    expect(cookie).toBeTruthy();
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');

    const me = await a.inject({ method: 'GET', url: '/api/me', cookies: { crm_session: cookie.value } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body).toMatchObject({ id: user.id, email: 'manager@daitpartners.com', role: 'Manager' });
    expect(body.rights).toContain('view_all_leads');
    expect(body.rights).not.toContain('manage_users');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.microsoftOid).toBe('oid-1');
    expect(stored.lastLoginAt).not.toBeNull();
  });

  test('rejects unknown microsoft identity', async () => {
    const a = await app({ microsoft: fakeMicrosoft({ oid: 'oid-x', email: 'stranger@example.com', name: 'S' }) });
    const before = await prisma.user.count();
    const res = await microsoftSignIn(a);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/sign-in?error=not-registered');
    expect(res.cookies.find((c) => c.name === 'crm_session' && c.value)).toBeUndefined();
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.session.count()).toBe(0);
  });

  test('rejects inactive user', async () => {
    await makeUser({ email: 'gone@daitpartners.com', isActive: false });
    const a = await app({ microsoft: fakeMicrosoft({ oid: 'oid-2', email: 'gone@daitpartners.com', name: 'G' }) });
    const res = await microsoftSignIn(a);
    expect(res.headers.location).toBe('/sign-in?error=not-registered');
    expect(await prisma.session.count()).toBe(0);
  });

  test('callback with tampered state is rejected', async () => {
    await makeUser({ email: 'a@daitpartners.com' });
    const a = await app({ microsoft: fakeMicrosoft({ oid: 'o', email: 'a@daitpartners.com', name: 'A' }) });
    const start = await a.inject({ method: 'GET', url: '/api/auth/microsoft' });
    const msState = start.cookies.find((c) => c.name === 'ms_state')!;
    const res = await a.inject({
      method: 'GET',
      url: '/api/auth/microsoft/callback?code=good-code&state=wrong',
      cookies: { ms_state: msState.value },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/sign-in\?error=/);
    expect(await prisma.session.count()).toBe(0);
  });

  test('microsoft returns 503 when not configured', async () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/api/auth/microsoft' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'microsoft_not_configured' });
  });
});

describe('production settings', () => {
  test('production with an https PUBLIC_URL sets a Secure session cookie', async () => {
    await makeUser({ email: 'manager@daitpartners.com', role: 'MANAGER' });
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PUBLIC_URL', 'https://x');
    const a = await app({ microsoft: fakeMicrosoft({ oid: 'oid-p', email: 'manager@daitpartners.com', name: 'M' }) });
    const res = await microsoftSignIn(a);
    expect(res.headers.location).toBe('/');
    const setCookie = [res.headers['set-cookie']].flat().find((c) => String(c).startsWith('crm_session='));
    expect(setCookie).toMatch(/;\s*Secure/);
    expect(res.cookies.find((c) => c.name === 'crm_session')!.secure).toBe(true);
  });

  test('production refuses to start with an http PUBLIC_URL or none', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PUBLIC_URL', 'http://x');
    await expect(buildApp()).rejects.toThrow(/PUBLIC_URL must be set to the https:\/\/ origin/);
    vi.stubEnv('PUBLIC_URL', '');
    await expect(buildApp()).rejects.toThrow(/PUBLIC_URL/);
  });
});

describe('sessions', () => {
  test('deactivated user loses session', async () => {
    const user = await makeUser();
    const a = await app();
    const cookie = await signIn(a, user);
    expect((await a.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    const res = await a.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthenticated' });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  test('session survives restart', async () => {
    const user = await makeUser();
    const a = await app();
    const cookie = await signIn(a, user);
    const b = await app();
    const res = await b.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(user.email);
  });

  test('logout clears session', async () => {
    const user = await makeUser();
    const a = await app();
    const cookie = await signIn(a, user);
    const out = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === 'crm_session')!;
    expect(cleared.value).toBe('');
    expect(await prisma.session.count()).toBe(0);
    expect((await a.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  test('expired session is rejected and removed', async () => {
    const user = await makeUser();
    const a = await app();
    const cookie = await signIn(a, user);
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await a.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  test('session slides when last seen over 5 minutes ago', async () => {
    const user = await makeUser();
    const a = await app();
    const cookie = await signIn(a, user);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.session.updateMany({ data: { lastSeenAt: old, expiresAt: soon } });
    expect((await a.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    const s = await prisma.session.findFirstOrThrow();
    expect(s.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  test('me requires a session', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  test('requireRight blocks manager from manage_users', async () => {
    const manager = await makeUser({ role: 'MANAGER' });
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const a = await app();
    a.get('/api/test/users-admin', { preHandler: [requireUser, requireRight('manage_users')] }, async () => ({ ok: true }));
    const asManager = await a.inject({ method: 'GET', url: '/api/test/users-admin', headers: { cookie: await signIn(a, manager) } });
    expect(asManager.statusCode).toBe(403);
    expect(asManager.json()).toEqual({ error: 'forbidden' });
    const asAdmin = await a.inject({ method: 'GET', url: '/api/test/users-admin', headers: { cookie: await signIn(a, admin) } });
    expect(asAdmin.statusCode).toBe(200);
  });
});

describe('test login', () => {
  test('test-login refused when TEST_LOGIN unset', async () => {
    const user = await makeUser();
    vi.stubEnv('TEST_LOGIN', '');
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/auth/test-login', payload: { email: user.email } });
    expect(res.statusCode).toBe(404);
    expect(await prisma.session.count()).toBe(0);
  });

  test('test-login refused in production even with flag', async () => {
    const user = await makeUser();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PUBLIC_URL', 'https://crm.example.test');
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/auth/test-login', payload: { email: user.email } });
    expect(res.statusCode).toBe(404);
  });

  test('test-login 404 for unknown user', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/auth/test-login', payload: { email: 'nobody@x.com' } });
    expect(res.statusCode).toBe(404);
  });

  test('auth options reflect flags', async () => {
    vi.stubEnv('LOCAL_ADMIN_LOGIN', '1');
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/api/auth/options' })).json()).toEqual({ localLogin: true, testLogin: true });
    vi.stubEnv('LOCAL_ADMIN_LOGIN', '');
    vi.stubEnv('TEST_LOGIN', '');
    const b = await app();
    expect((await b.inject({ method: 'GET', url: '/api/auth/options' })).json()).toEqual({ localLogin: false, testLogin: false });
  });
});

describe('local admin login', () => {
  async function makeLocalAdmin() {
    const u = await makeUser({ email: 'root@daitpartners.com', role: 'ADMINISTRATOR' });
    await prisma.user.update({
      where: { id: u.id },
      data: { isLocalAdmin: true, passwordHash: await hashPassword('correct horse battery') },
    });
    return u;
  }

  test('local login refused when flag unset', async () => {
    await makeLocalAdmin();
    vi.stubEnv('LOCAL_ADMIN_LOGIN', '');
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/local',
      payload: { email: 'root@daitpartners.com', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(404);
  });

  test('local login works for local admin', async () => {
    await makeLocalAdmin();
    vi.stubEnv('LOCAL_ADMIN_LOGIN', '1');
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/auth/local',
      payload: { email: 'Root@DaitPartners.com', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(204);
    const c = res.cookies.find((x) => x.name === 'crm_session')!;
    const me = await a.inject({ method: 'GET', url: '/api/me', cookies: { crm_session: c.value } });
    expect(me.json().role).toBe('Administrator');
  });

  test('local login rejects wrong password, non-local user and rate-limits', async () => {
    await makeLocalAdmin();
    const plain = await makeUser({ email: 'plain@daitpartners.com' });
    vi.stubEnv('LOCAL_ADMIN_LOGIN', '1');
    const a = await app();
    const post = (email: string, password: string) =>
      a.inject({ method: 'POST', url: '/api/auth/local', payload: { email, password } });
    const wrong = await post('root@daitpartners.com', 'nope');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' });
    const notLocal = await post(plain.email, 'whatever');
    expect(notLocal.json()).toEqual({ error: 'invalid_credentials' });
    await post('x@y.com', 'a');
    await post('x@y.com', 'a');
    await post('x@y.com', 'a');
    const sixth = await post('root@daitpartners.com', 'correct horse battery');
    expect(sixth.statusCode).toBe(429);
    expect(await prisma.session.count()).toBe(0);
    // other routes are not rate-limited
    for (let i = 0; i < 7; i++) expect((await a.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});
