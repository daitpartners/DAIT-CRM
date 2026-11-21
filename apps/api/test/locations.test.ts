import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeUser, signIn } from './factory';

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

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

async function as(role: 'ADMINISTRATOR' | 'SALES_REPRESENTATIVE') {
  const user = await makeUser({ role });
  return { user, cookie: await signIn(app, user) };
}

const pune = { name: 'Pune office', locationType: 'Branch', country: 'India', city: 'Pune', lat: 18.52, lng: 73.85 };

describe('company locations API', () => {
  it('adds, updates and deletes a location with audit rows', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    const created = await req('POST', `/api/companies/${co.id}/locations`, admin.cookie, pune);
    expect(created.statusCode).toBe(201);
    const loc = created.json();
    expect(loc).toMatchObject({ companyId: co.id, name: 'Pune office', locationType: 'Branch', lat: 18.52, lng: 73.85, source: 'Manual', isVerified: false });

    const bad = await req('POST', `/api/companies/${co.id}/locations`, admin.cookie, { ...pune, locationType: 'Spaceport' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation');

    const stale = await req('PATCH', `/api/companies/${co.id}/locations/${loc.id}`, admin.cookie, { city: 'Mumbai', updatedAt: '2020-01-01T00:00:00.000Z' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale' });
    const updated = await req('PATCH', `/api/companies/${co.id}/locations/${loc.id}`, admin.cookie, { city: 'Mumbai', updatedAt: loc.updatedAt });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().city).toBe('Mumbai');

    const del = await req('DELETE', `/api/companies/${co.id}/locations/${loc.id}`, admin.cookie);
    expect(del.statusCode).toBe(204);
    expect(await prisma.companyLocation.count()).toBe(0);
    expect((await req('DELETE', `/api/companies/${co.id}/locations/${loc.id}`, admin.cookie)).statusCode).toBe(404);

    const logs = await prisma.auditLog.findMany({ where: { entityType: 'location', entityId: String(loc.id) }, orderBy: { id: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['create', 'update', 'delete']);
    expect(logs[2].before).toMatchObject({ city: 'Mumbai' });
    expect(logs[2].after).toBeNull();
  });

  it('headquarters sorts first', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    for (const [name, locationType] of [['Zeta depot', 'Warehouse'], ['Alpha branch', 'Branch'], ['Main HQ', 'Headquarters']]) {
      expect((await req('POST', `/api/companies/${co.id}/locations`, admin.cookie, { name, locationType, country: 'India' })).statusCode).toBe(201);
    }
    const res = await req('GET', `/api/companies/${co.id}/locations`, admin.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((l: { name: string }) => l.name)).toEqual(['Main HQ', 'Alpha branch', 'Zeta depot']);
  });

  it('404 for a location on a hidden company', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const hidden = await makeCompany({ createdById: admin.user.id });
    const loc = (await req('POST', `/api/companies/${hidden.id}/locations`, admin.cookie, pune)).json();
    for (const res of [
      await req('GET', `/api/companies/${hidden.id}/locations`, rep.cookie),
      await req('POST', `/api/companies/${hidden.id}/locations`, rep.cookie, pune),
      await req('PATCH', `/api/companies/${hidden.id}/locations/${loc.id}`, rep.cookie, { city: 'X', updatedAt: loc.updatedAt }),
      await req('DELETE', `/api/companies/${hidden.id}/locations/${loc.id}`, rep.cookie),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    // A location id under the wrong company is not found either.
    const other = await makeCompany();
    expect((await req('DELETE', `/api/companies/${other.id}/locations/${loc.id}`, admin.cookie)).statusCode).toBe(404);
    expect(await prisma.companyLocation.count()).toBe(1);
  });
});
