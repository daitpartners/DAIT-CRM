import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { pickAssignee } from '../src/allocation/pick';
import { resetDb } from './helpers';
import { makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(resetDb);

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
const pick = (country: string) => prisma.$transaction((tx) => pickAssignee(tx, country));
const rule = (data: { name?: string; matchCountries: string[]; assignTo: number | number[]; priority: number }) =>
  prisma.allocationRule.create({ data: { name: data.name ?? 'r', ...data } });

describe('pickAssignee', () => {
  it('single assignee', async () => {
    const u = await makeUser();
    await rule({ matchCountries: ['India'], assignTo: u.id, priority: 1 });
    expect(await pick('India')).toBe(u.id);
  });

  it('round robin starts at first and advances', async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    const r = await rule({ matchCountries: ['India'], assignTo: [u1.id, u2.id], priority: 1 });
    expect([await pick('India'), await pick('India'), await pick('India')]).toEqual([u1.id, u2.id, u1.id]);
    expect((await prisma.allocationRule.findUniqueOrThrow({ where: { id: r.id } })).roundRobinPos).toBe(3);
  });

  it('concurrent picks do not duplicate', async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    await rule({ matchCountries: ['India'], assignTo: [u1.id, u2.id], priority: 1 });
    const got = await Promise.all([pick('India'), pick('India'), pick('India'), pick('India')]);
    expect(got.filter((x) => x === u1.id)).toHaveLength(2);
    expect(got.filter((x) => x === u2.id)).toHaveLength(2);
  });

  it('wildcard last by priority', async () => {
    const [u1, u2] = [await makeUser(), await makeUser()];
    await rule({ name: 'all', matchCountries: ['*'], assignTo: u2.id, priority: 9 });
    await rule({ name: 'uk', matchCountries: ['United Kingdom'], assignTo: u1.id, priority: 1 });
    expect(await pick('United Kingdom')).toBe(u1.id);
    expect(await pick('Spain')).toBe(u2.id);
  });

  it('no rule -> null; inactive rules and case mismatch are skipped', async () => {
    const u = await makeUser();
    expect(await pick('India')).toBeNull();
    const r = await rule({ matchCountries: ['India'], assignTo: u.id, priority: 1 });
    expect(await pick('india')).toBeNull();
    await prisma.allocationRule.update({ where: { id: r.id }, data: { isActive: false } });
    expect(await pick('India')).toBeNull();
  });
});

describe('allocation rules API', () => {
  it('GET needs view_admin_settings, lists by priority', async () => {
    const u = await makeUser();
    await rule({ name: 'b', matchCountries: ['*'], assignTo: [u.id], priority: 2 });
    await rule({ name: 'a', matchCountries: ['India'], assignTo: u.id, priority: 1 });
    const rep = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    expect((await req('GET', '/api/allocation-rules', rep)).statusCode).toBe(403);
    const mgr = await signIn(app, await makeUser({ role: 'MANAGER' }));
    const res = await req('GET', '/api/allocation-rules', mgr);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { name: string }) => i.name)).toEqual(['a', 'b']);
    expect(res.json().items[0].assignTo).toBe(u.id);
  });

  it('create, update, delete are audited', async () => {
    const u = await makeUser();
    const c = await signIn(app, await makeUser({ role: 'ADMINISTRATOR' }));
    const created = await req('POST', '/api/allocation-rules', c, { name: 'IN', matchCountries: ['India'], assignTo: [u.id], priority: 1 });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const patched = await req('PATCH', `/api/allocation-rules/${id}`, c, { isActive: false, priority: 4 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ isActive: false, priority: 4 });
    expect((await req('DELETE', `/api/allocation-rules/${id}`, c)).statusCode).toBe(204);
    expect((await req('DELETE', `/api/allocation-rules/${id}`, c)).statusCode).toBe(404);
    expect(await prisma.auditLog.count({ where: { entityType: 'allocation_rule', entityId: String(id) } })).toBe(3);
  });

  it('unknown user 400 (missing or inactive), on create and patch', async () => {
    const gone = await makeUser({ isActive: false });
    const u = await makeUser();
    const c = await signIn(app, await makeUser({ role: 'ADMINISTRATOR' }));
    for (const assignTo of [999999, gone.id, [u.id, gone.id]]) {
      const res = await req('POST', '/api/allocation-rules', c, { name: 'x', matchCountries: ['*'], assignTo, priority: 1 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unknown_user' });
    }
    const ok = await req('POST', '/api/allocation-rules', c, { name: 'x', matchCountries: ['*'], assignTo: u.id, priority: 1 });
    const bad = await req('PATCH', `/api/allocation-rules/${ok.json().id}`, c, { assignTo: gone.id });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'unknown_user' });
  });
});
