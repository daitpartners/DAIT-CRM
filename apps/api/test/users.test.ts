import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(resetDb);

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

describe('GET /api/users', () => {
  it('401 when signed out', async () => {
    expect((await req('GET', '/api/users')).statusCode).toBe(401);
  });

  it('lists all users including inactive, ordered by name, with role labels and no secrets', async () => {
    const me = await makeUser({ name: 'Zed', role: 'DATA_RESEARCH_USER' });
    await makeUser({ name: 'Amy', role: 'MANAGER' });
    await makeUser({ name: 'Bob', isActive: false });
    const res = await req('GET', '/api/users', await signIn(app, me));
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items.map((i: { name: string }) => i.name)).toEqual(['Amy', 'Bob', 'Zed']);
    expect(items[0]).toEqual({
      id: expect.any(Number), email: expect.any(String), name: 'Amy', role: 'Manager', language: 'en',
      timezone: 'Europe/London', isActive: true, lastLoginAt: null,
    });
    expect(items[1].isActive).toBe(false);
  });
});

describe('POST /api/users', () => {
  it('403 for non-administrators', async () => {
    const m = await makeUser({ role: 'MANAGER' });
    const res = await req('POST', '/api/users', await signIn(app, m), { email: 'n@x.com', name: 'N', role: 'Manager' });
    expect(res.statusCode).toBe(403);
  });

  it('creates a user (201) with defaults and role label', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('POST', '/api/users', await signIn(app, admin), { email: ' New@X.com ', name: 'New', role: 'Manager' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'new@x.com', name: 'New', role: 'Manager', language: 'en', isActive: true });
    expect(await prisma.user.findUnique({ where: { email: 'new@x.com' } })).toMatchObject({ role: 'MANAGER' });
  });

  it('writes an audit row with after.email and the acting user', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('POST', '/api/users', await signIn(app, admin), { email: 'a@x.com', name: 'A', role: 'Manager' });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'user', action: 'create' } });
    expect(row.entityId).toBe(String(res.json().id));
    expect(row.userId).toBe(admin.id);
    expect((row.after as { email: string }).email).toBe('a@x.com');
    expect(row.after).not.toHaveProperty('passwordHash');
  });

  it('400 validation with issues on bad body', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('POST', '/api/users', await signIn(app, admin), { email: 'nope', name: '', role: 'King' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('409 email_taken on duplicate', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('POST', '/api/users', await signIn(app, admin), { email: admin.email.toUpperCase(), name: 'D', role: 'Manager' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'email_taken' });
  });
});

describe('PATCH /api/users/:id', () => {
  it('403 for non-administrators', async () => {
    const m = await makeUser({ role: 'MANAGER' });
    const res = await req('PATCH', `/api/users/${m.id}`, await signIn(app, m), { name: 'X' });
    expect(res.statusCode).toBe(403);
  });

  it('updates fields, converts role label, and audits before/after', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const t = await makeUser({ name: 'Old' });
    const res = await req('PATCH', `/api/users/${t.id}`, await signIn(app, admin), { name: 'New', role: 'Manager', isActive: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.id, name: 'New', role: 'Manager', isActive: false });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'user', action: 'update' } });
    expect(row.userId).toBe(admin.id);
    expect((row.before as { name: string }).name).toBe('Old');
    expect((row.after as { name: string }).name).toBe('New');
  });

  it('404 for unknown id', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('PATCH', '/api/users/99999', await signIn(app, admin), { name: 'X' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('400 validation on bad body', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('PATCH', `/api/users/${admin.id}`, await signIn(app, admin), { language: 'xx' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });

  it('409 email_taken when changing to an existing email', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const other = await makeUser();
    const res = await req('PATCH', `/api/users/${other.id}`, await signIn(app, admin), { email: admin.email });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'email_taken' });
  });

  it('cannot deactivate self', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('PATCH', `/api/users/${admin.id}`, await signIn(app, admin), { isActive: false });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'cannot_deactivate_self' });
  });

  it('cannot demote the last active administrator', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('PATCH', `/api/users/${admin.id}`, await signIn(app, admin), { role: 'Manager' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'last_administrator' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe('ADMINISTRATOR');
  });

  it('inactive administrators do not count towards the last-administrator rule', async () => {
    await makeUser({ role: 'ADMINISTRATOR', isActive: false });
    const actor = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('PATCH', `/api/users/${actor.id}`, await signIn(app, actor), { role: 'Manager' });
    expect(res.json()).toEqual({ error: 'last_administrator' });
  });

  it('allows demoting an administrator when another active one exists', async () => {
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const t = await makeUser({ role: 'ADMINISTRATOR' });
    const res = await req('PATCH', `/api/users/${t.id}`, await signIn(app, admin), { role: 'Manager' });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('Manager');
  });
});

describe('PATCH /api/me/preferences', () => {
  it('401 when signed out', async () => {
    expect((await req('PATCH', '/api/me/preferences', undefined, {})).statusCode).toBe(401);
  });

  it('updates preferences, returns the /api/me shape, and audits', async () => {
    const u = await makeUser({ role: 'MANAGER' });
    const cookie = await signIn(app, u);
    const res = await req('PATCH', '/api/me/preferences', cookie, { language: 'fr', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY' });
    expect(res.statusCode).toBe(200);
    const me = await req('GET', '/api/me', cookie);
    expect(res.json()).toEqual(me.json());
    expect(res.json()).toMatchObject({ language: 'fr', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY', role: 'Manager' });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'user', action: 'update' } });
    expect(row.userId).toBe(u.id);
    expect((row.after as { language: string }).language).toBe('fr');
  });

  it('400 validation on bad body', async () => {
    const u = await makeUser();
    const res = await req('PATCH', '/api/me/preferences', await signIn(app, u), { language: 'xx' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });
});
