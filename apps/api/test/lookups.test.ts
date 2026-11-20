import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb();
  await seedLookups();
});

const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
const admin = async () => signIn(app, await makeUser({ role: 'ADMINISTRATOR' }));

describe('lookups', () => {
  it('401 when signed out', async () => {
    expect((await req('GET', '/api/lookups')).statusCode).toBe(401);
  });

  it('inactive value hidden from options but readable', async () => {
    const c = await admin();
    const neg = await prisma.lookupValue.findUniqueOrThrow({ where: { group_value: { group: 'lead_status', value: 'Negotiation' } } });
    const res = await req('PATCH', `/api/lookups/${neg.id}`, c, { isActive: false });
    expect(res.statusCode).toBe(200);
    const active = (await req('GET', '/api/lookups?group=lead_status', c)).json().items;
    expect(active.map((i: { value: string }) => i.value)).not.toContain('Negotiation');
    const all = (await req('GET', '/api/lookups?group=lead_status&all=1', c)).json().items;
    expect(all.find((i: { value: string }) => i.value === 'Negotiation').isActive).toBe(false);
    const grouped = (await req('GET', '/api/lookups', c)).json().groups;
    expect(grouped.lead_status.map((i: { value: string }) => i.value)).not.toContain('Negotiation');
    expect(grouped.currency).toHaveLength(5);
    expect(await prisma.auditLog.count({ where: { entityType: 'lookup_value', entityId: String(neg.id) } })).toBe(1);
  });

  it('create defaults sortOrder to max+1; duplicate value 409', async () => {
    const c = await admin();
    const res = await req('POST', '/api/lookups', c, { group: 'currency', value: 'JPY', label: 'JPY' });
    expect(res.statusCode).toBe(201);
    expect(res.json().sortOrder).toBe(5);
    const dup = await req('POST', '/api/lookups', c, { group: 'currency', value: 'JPY', label: 'Yen' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'duplicate_value' });
  });

  it('manager cannot create lookup', async () => {
    const c = await signIn(app, await makeUser({ role: 'MANAGER' }));
    expect((await req('POST', '/api/lookups', c, { group: 'currency', value: 'JPY', label: 'JPY' })).statusCode).toBe(403);
  });

  it('patch ignores nothing unknown: 404 for missing id', async () => {
    const c = await admin();
    expect((await req('PATCH', '/api/lookups/999999', c, { label: 'x' })).statusCode).toBe(404);
  });

  it('patch cannot change value or group (400, row unchanged)', async () => {
    const c = await admin();
    const row = await prisma.lookupValue.findUniqueOrThrow({ where: { group_value: { group: 'currency', value: 'GBP' } } });
    for (const payload of [{ value: 'EUR' }, { value: 'X' }, { group: 'priority' }]) {
      expect((await req('PATCH', `/api/lookups/${row.id}`, c, payload)).statusCode).toBe(400);
    }
    const after = await prisma.lookupValue.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ value: 'GBP', group: 'currency' });
  });

  it('reorder renumbers, unlisted keep relative order after listed', async () => {
    const c = await admin();
    const rows = (await req('GET', '/api/lookups?group=currency', c)).json().items as { id: number; value: string }[];
    const [a, b, cc, d, e] = rows;
    const res = await req('PUT', '/api/lookups/currency/order', c, { ids: [e.id, cc.id] });
    expect(res.statusCode).toBe(204);
    const after = (await req('GET', '/api/lookups?group=currency', c)).json().items as { id: number; sortOrder: number }[];
    expect(after.map((i) => i.id)).toEqual([e.id, cc.id, a.id, b.id, d.id]);
    expect(after.map((i) => i.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reorder rejects ids from another group', async () => {
    const c = await admin();
    const other = await prisma.lookupValue.findFirstOrThrow({ where: { group: 'priority' } });
    const res = await req('PUT', '/api/lookups/currency/order', c, { ids: [other.id] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_ids' });
  });
});
