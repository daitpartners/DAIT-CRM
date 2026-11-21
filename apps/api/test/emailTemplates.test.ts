import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(resetDb);

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload } : {}) });

describe('email templates API', () => {
  it('401 signed out', async () => {
    expect((await call('GET', '/api/email-templates')).statusCode).toBe(401);
  });

  it('create, list (your language first), update with concurrency, delete', async () => {
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Arjun Mehta' });
    const spanish = await makeUser({ role: 'SALES_REPRESENTATIVE', language: 'es' });
    const cookie = await signIn(app, rep);
    const en = await call('POST', '/api/email-templates', cookie, { name: 'Follow-up', language: 'en', subject: 'Following up', body: 'Hi {first_name}' });
    expect(en.statusCode).toBe(201);
    expect(en.json()).toMatchObject({ name: 'Follow-up', language: 'en', sourceType: 'manual', createdBy: { name: 'Arjun Mehta' } });
    const es = await call('POST', '/api/email-templates', cookie, {
      name: 'Primer contacto', language: 'es', subject: '¿Una llamada esta semana?', body: '', sourceType: 'oft', fileName: 'Primer.oft', fileSize: 9216,
    });
    expect(es.statusCode).toBe(201);
    expect(es.json()).toMatchObject({ sourceType: 'oft', fileName: 'Primer.oft', fileSize: 9216 });

    const forSpanish = await call('GET', '/api/email-templates', await signIn(app, spanish));
    expect(forSpanish.json().items.map((t: { name: string }) => t.name)).toEqual(['Primer contacto', 'Follow-up']);

    const loaded = en.json() as { id: number; updatedAt: string };
    const ok = await call('PATCH', `/api/email-templates/${loaded.id}`, cookie, { subject: 'Following up again', updatedAt: loaded.updatedAt });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().subject).toBe('Following up again');
    const stale = await call('PATCH', `/api/email-templates/${loaded.id}`, cookie, { subject: 'Old copy', updatedAt: loaded.updatedAt });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stale');

    expect((await call('DELETE', `/api/email-templates/${loaded.id}`, cookie)).statusCode).toBe(204);
    expect(await prisma.emailTemplate.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'email_template' } })).toBe(4);
  });

  it('validation: missing subject and an unknown language are refused; unknown id is 404', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    expect((await call('POST', '/api/email-templates', cookie, { name: 'X', language: 'de', subject: 'Hi' })).statusCode).toBe(400);
    expect((await call('POST', '/api/email-templates', cookie, { name: 'X', language: 'en', subject: '' })).statusCode).toBe(400);
    expect((await call('DELETE', '/api/email-templates/99999', cookie)).statusCode).toBe(404);
    // A file size beyond what an upload can be (10 MB) is refused rather than overflowing the column.
    expect((await call('POST', '/api/email-templates', cookie, { name: 'X', language: 'en', subject: 'Hi', sourceType: 'oft', fileName: 'x.oft', fileSize: 3_000_000_000 })).statusCode).toBe(400);
  });
});
