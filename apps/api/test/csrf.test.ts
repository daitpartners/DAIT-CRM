import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, isPublicPath } from '../src/app';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

const apps: FastifyInstance[] = [];
async function app() {
  const a = await buildApp();
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

// PUBLIC_URL is http://localhost:5173 in vitest.config.ts.
describe('same-site CSRF guard', () => {
  test('a POST with a foreign Origin is refused before reaching the route', async () => {
    const a = await app();
    const cookie = await signIn(a, await makeUser());
    const res = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'bad_origin' });
    const me = await a.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  test('a POST with the PUBLIC_URL origin reaches the route', async () => {
    const a = await app();
    const cookie = await signIn(a, await makeUser());
    const res = await a.inject({
      method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.statusCode).toBe(204);
  });

  test('no Origin with Sec-Fetch-Site cross-site is refused; same-origin and none pass', async () => {
    const a = await app();
    const user = await makeUser();
    const post = (site?: string) =>
      a.inject({ method: 'POST', url: '/api/auth/test-login', payload: { email: user.email }, headers: site ? { 'sec-fetch-site': site } : {} });
    const cross = await post('cross-site');
    expect(cross.statusCode).toBe(403);
    expect(cross.json()).toEqual({ error: 'bad_origin' });
    expect((await post('same-site')).statusCode).toBe(403);
    expect((await post('same-origin')).statusCode).toBe(204);
    expect((await post('none')).statusCode).toBe(204);
    // Non-browser clients send neither header.
    expect((await post()).statusCode).toBe(204);
  });

  test('Origin: null is refused', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'null' } });
    expect(res.statusCode).toBe(403);
  });

  test('safe methods are not checked', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(200);
  });

  test('without PUBLIC_URL (development) the Origin must match the Host header', async () => {
    vi.stubEnv('PUBLIC_URL', '');
    const a = await app();
    const ok = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } });
    expect(ok.statusCode).toBe(204);
    const bad = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: 'localhost:5173', origin: 'http://evil.example' } });
    expect(bad.statusCode).toBe(403);
  });

  test('text/plain bodies are not parsed (415), so a simple cross-site form post cannot reach a route', async () => {
    const a = await app();
    const user = await makeUser();
    const res = await a.inject({
      method: 'POST', url: '/api/auth/test-login', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify({ email: user.email }),
    });
    expect(res.statusCode).toBe(415);
  });

  test('public paths are exempt (allow-list for public forms)', async () => {
    const a = await app();
    a.post('/api/public/ping', async () => ({ ok: true }));
    const res = await a.inject({ method: 'POST', url: '/api/public/ping', headers: { origin: 'https://www.daitpartners.com' } });
    expect(res.statusCode).toBe(200);
    expect(isPublicPath('/api/public/enquiry')).toBe(true);
    expect(isPublicPath('/api/publicity')).toBe(false);
    expect(isPublicPath('/api/users')).toBe(false);
  });
});
