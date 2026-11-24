import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { resetDb } from './helpers';
import { setBodyWorkerMemoryForTests } from '../src/mail/bodies';
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

  it('formatted templates: the HTML is sanitised on create and on update; null makes the template plain', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const xss = '<p onmouseover="alert(1)">Hi <b>{first_name}</b></p><script>alert(document.cookie)</script>'
      + '<a href="javascript:alert(1)">x</a><a href="https://dait.example">site</a><img src="cid:image001.png"><iframe src="https://evil.example"></iframe>';
    const created = await call('POST', '/api/email-templates', cookie, {
      name: 'Formatted', language: 'en', subject: 'Hi', body: 'Hi {first_name}', bodyHtml: xss, sourceType: 'oft', fileName: 'f.oft', fileSize: 10,
    });
    expect(created.statusCode).toBe(201);
    const t = created.json() as { id: number; updatedAt: string; bodyHtml: string };
    expect(t.bodyHtml).toContain('<b>{first_name}</b>');
    expect(t.bodyHtml).toContain('href="https://dait.example"');
    for (const bad of ['onmouseover', '<script', 'javascript:', 'cid:', '<iframe', 'alert(']) expect(t.bodyHtml).not.toContain(bad);
    expect((await prisma.emailTemplate.findUniqueOrThrow({ where: { id: t.id } })).bodyHtml).toBe(t.bodyHtml);
    // The audit record says the template is formatted, without the HTML.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'email_template', action: 'create' } });
    expect(JSON.stringify(log)).not.toContain('dait.example');
    expect(log.after).toMatchObject({ name: 'Formatted', formatted: true });

    const updated = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { bodyHtml: '<p>New <i>copy</i><svg onload="alert(1)"></svg></p>', updatedAt: t.updatedAt });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().bodyHtml).toBe('<p>New <i>copy</i></p>');
    // A change without bodyHtml keeps it; null makes the template plain text.
    const renamed = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { name: 'Renamed', updatedAt: updated.json().updatedAt });
    expect(renamed.json().bodyHtml).toBe('<p>New <i>copy</i></p>');
    const plain = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { bodyHtml: null, updatedAt: renamed.json().updatedAt });
    expect(plain.json().bodyHtml).toBeNull();
    // A manual template without HTML stays plain.
    const manual = await call('POST', '/api/email-templates', cookie, { name: 'Plain', language: 'en', subject: 'Hi', body: 'Hi' });
    expect(manual.json().bodyHtml).toBeNull();
  });

  it('sanitize: an uploaded .oft\'s HTML comes back safe before the editor shows it; needs manage_leads', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const res = await call('POST', '/api/email-templates/sanitize', cookie, { html: '<html><body><p style="color:red">Hi <b>{first_name}</b></p><img src=x onerror=alert(1)><script>x()</script></body></html>' });
    expect(res.statusCode).toBe(200);
    // The relative picture goes too (security review I1).
    expect(res.json()).toEqual({ html: '<p style="color:red">Hi <b>{first_name}</b></p>', text: 'Hi {first_name}' });
    expect((await call('POST', '/api/email-templates/sanitize', cookie, { html: '<script>x()</script>' })).json()).toEqual({ html: null, text: '' });
  });

  it('size (security review I2): a template over its cap is refused as message_too_long, never cut; the plain body is derived (M5)', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const big = '<p>' + 'x'.repeat(150_001) + '</p>';
    const res = await call('POST', '/api/email-templates', cookie, { name: 'Big', language: 'en', subject: 'Hi', bodyHtml: big });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'message_too_long' });
    expect(await prisma.emailTemplate.count()).toBe(0);
    expect((await call('POST', '/api/email-templates/sanitize', cookie, { html: big })).json()).toEqual({ error: 'message_too_long' });
    // With HTML the plain body is neither required nor limited to 20,000: the server derives it.
    const ok = await call('POST', '/api/email-templates', cookie, { name: 'Long', language: 'en', subject: 'Hi', body: 'z'.repeat(30_000), bodyHtml: '<p>Hi <b>there</b></p>' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ body: 'Hi there', bodyHtml: '<p>Hi <b>there</b></p>' });
    // Without HTML the 20,000 limit stays.
    expect((await call('POST', '/api/email-templates', cookie, { name: 'P', language: 'en', subject: 'Hi', body: 'z'.repeat(20_001) })).statusCode).toBe(400);
  });

  it('a worker that gives up while saving is 409 try_again, never a silent plain-text template (M3)', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    setBodyWorkerMemoryForTests(16);
    try {
      const res = await call('POST', '/api/email-templates', cookie, { name: 'Busy', language: 'en', subject: 'Hi', bodyHtml: '<p>big</p>'.repeat(90_000) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'try_again' });
    } finally {
      setBodyWorkerMemoryForTests(null);
    }
    expect(await prisma.emailTemplate.count()).toBe(0);
  });

  it('sanitize is limited per user (security review M2)', async () => {
    // Its own app: the limiter's counts live in the app, and user ids repeat after each test's database reset.
    const fresh = await buildApp();
    try {
      const cookie = await signIn(fresh, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
      const codes: number[] = [];
      for (let i = 0; i < 21; i++) {
        codes.push((await fresh.inject({ method: 'POST', url: '/api/email-templates/sanitize', headers: { cookie }, payload: { html: '<p>x</p>' } })).statusCode);
      }
      expect(codes.slice(0, 20)).toEqual(Array(20).fill(200));
      expect(codes[20]).toBe(429);
    } finally {
      await fresh.close();
    }
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
