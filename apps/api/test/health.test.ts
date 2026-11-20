import { test, expect } from 'vitest';
import { buildApp } from '../src/app';

test('GET /api/health returns ok and release', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, release: 'dev' });
  await app.close();
});

test('X-Forwarded-For is honoured from the loopback proxy only', async () => {
  const app = await buildApp();
  app.get('/__ip', async (req) => req.ip);
  const viaProxy = await app.inject({ method: 'GET', url: '/__ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } });
  expect(viaProxy.body).toBe('203.0.113.9');
  const direct = await app.inject({ method: 'GET', url: '/__ip', remoteAddress: '198.51.100.7', headers: { 'x-forwarded-for': '203.0.113.9' } });
  expect(direct.body).toBe('198.51.100.7');
  await app.close();
});
