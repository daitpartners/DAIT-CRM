import { test, expect } from 'vitest';
import { buildApp } from '../src/app';

test('GET /api/health returns ok and release', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, release: 'dev' });
  await app.close();
});
