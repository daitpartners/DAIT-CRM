import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeUser, signIn } from './factory';

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

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

async function as(role: 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER') {
  const user = await makeUser({ role });
  return { user, cookie: await signIn(app, user) };
}

const primaries = (companyId: number) => prisma.contact.findMany({ where: { companyId, isPrimary: true }, select: { id: true } });

describe('contacts API', () => {
  it('401 when signed out', async () => {
    expect((await req('GET', '/api/contacts')).statusCode).toBe(401);
    expect((await req('POST', '/api/contacts', undefined, { companyId: 1, firstName: 'A', lastName: 'B' })).statusCode).toBe(401);
  });

  it('first contact becomes primary automatically', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany({ name: 'Acme' });
    const first = await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Asha', lastName: 'Rao', isPrimary: false });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      companyId: co.id, company: { id: co.id, number: co.number, name: 'Acme' },
      firstName: 'Asha', lastName: 'Rao', contactType: 'Other', isPrimary: true,
    });
    const second = await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Ben', lastName: 'Ng' });
    expect(second.statusCode).toBe(201);
    expect(second.json().isPrimary).toBe(false);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'contact', action: 'create', entityId: String(first.json().id) } });
    expect(log.userId).toBe(admin.user.id);
  });

  it('switching primary clears the previous primary', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    const a = (await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Asha', lastName: 'Rao' })).json();
    const b = (await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Ben', lastName: 'Ng' })).json();
    const res = await req('PATCH', `/api/contacts/${b.id}`, admin.cookie, { isPrimary: true, updatedAt: b.updatedAt });
    expect(res.statusCode).toBe(200);
    expect(res.json().isPrimary).toBe(true);
    expect(await primaries(co.id)).toEqual([{ id: b.id }]);
    // A create with isPrimary: true swaps too.
    const c = await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Cy', lastName: 'Lo', isPrimary: true });
    expect(c.statusCode).toBe(201);
    expect(await primaries(co.id)).toEqual([{ id: c.json().id }]);
    expect(a.isPrimary).toBe(true);
  });

  it('cannot unset the only primary', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    const a = (await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Asha', lastName: 'Rao' })).json();
    await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Ben', lastName: 'Ng' });
    const res = await req('PATCH', `/api/contacts/${a.id}`, admin.cookie, { isPrimary: false, updatedAt: a.updatedAt });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'last_primary_contact' });
    expect(await primaries(co.id)).toEqual([{ id: a.id }]);
  });

  it('refuses a contact on a closed company', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    await prisma.company.update({ where: { id: co.id }, data: { status: 'Closed' } });
    const res = await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Asha', lastName: 'Rao' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'company_inactive' });
    expect(await prisma.contact.count()).toBe(0);
  });

  it('404 for a contact on a hidden company and 400 for an unknown contact type', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const hidden = await makeCompany({ createdById: admin.user.id });
    const res = await req('POST', '/api/contacts', rep.cookie, { companyId: hidden.id, firstName: 'A', lastName: 'B' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    const bad = await req('POST', '/api/contacts', admin.cookie, { companyId: hidden.id, firstName: 'A', lastName: 'B', contactType: 'Boss' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation');
  });

  it('normalises phone for matching', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    const res = await req('POST', '/api/contacts', admin.cookie, {
      companyId: co.id, firstName: 'Asha', lastName: 'Rao', phone: '+91 20 6710 2200', mobile: '12-34',
    });
    expect(res.statusCode).toBe(201);
    const row = await prisma.contact.findUniqueOrThrow({ where: { id: res.json().id } });
    // normalisePhone keeps the last 10 digits (the prototype phone key, Task 1 fix ddc00d1).
    expect(row.phoneNormalised).toBe('2067102200');
    expect(row.mobileNormalised).toBeNull();
    const patched = await req('PATCH', `/api/contacts/${row.id}`, admin.cookie, { mobile: '098 7654 3210', updatedAt: row.updatedAt.toISOString() });
    expect(patched.statusCode).toBe(200);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: row.id } })).mobileNormalised).toBe('9876543210');
  });

  it('lists contacts a sales rep can see only through their companies', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const mine = await makeCompany({ name: 'Rep Co', createdById: rep.user.id });
    const theirs = await makeCompany({ name: 'Admin Co', createdById: admin.user.id });
    await makeContact({ companyId: mine.id, firstName: 'Zed', lastName: 'Adams', businessEmail: 'zed@rep.co' });
    await makeContact({ companyId: mine.id, firstName: 'Amy', lastName: 'Young' });
    await makeContact({ companyId: theirs.id, firstName: 'Hidden', lastName: 'Person' });
    const list = await req('GET', '/api/contacts?sort=lastName', rep.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(list.json().items.map((c: { lastName: string }) => c.lastName)).toEqual(['Adams', 'Young']);
    expect((await req('GET', `/api/contacts?companyId=${theirs.id}`, rep.cookie)).json().total).toBe(0);
    const all = (await req('GET', '/api/contacts?sort=company&dir=desc', admin.cookie)).json();
    expect(all.total).toBe(3);
    expect(all.items[0].company.name).toBe('Rep Co');
    expect((await req('GET', '/api/contacts?q=rep co', admin.cookie)).json().total).toBe(2);
    expect((await req('GET', '/api/contacts?q=zed@', admin.cookie)).json().total).toBe(1);
    expect((await req('GET', '/api/contacts?contactType=Other', admin.cookie)).json().total).toBe(3);
    expect((await req('GET', '/api/contacts?sort=phoneNormalised', admin.cookie)).statusCode).toBe(400);
  });

  it('check-duplicates auto on email, review on phone', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    const asha = await makeContact({ companyId: co.id, businessEmail: 'asha@acme.com', phone: '+91 20 6710 2200' });
    const auto = (await req('POST', '/api/contacts/check-duplicates', admin.cookie, { businessEmail: 'ASHA@acme.com' })).json();
    expect(auto.auto).toMatchObject({ id: asha.id });
    const review = await req('POST', '/api/contacts/check-duplicates', admin.cookie, { phone: '020 6710 2200' });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ auto: null, review: [{ candidate: { id: asha.id }, how: 'phone' }] });
    const viaMobile = (await req('POST', '/api/contacts/check-duplicates', admin.cookie, { phone: '', mobile: '2067102200' })).json();
    expect(viaMobile.review).toHaveLength(1);
  });

  it('rejects a stale update', async () => {
    const admin = await as('ADMINISTRATOR');
    const contact = await makeContact();
    const stale = await req('PATCH', `/api/contacts/${contact.id}`, admin.cookie, { firstName: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale' });
    const ok = await req('PATCH', `/api/contacts/${contact.id}`, admin.cookie, { firstName: 'New', updatedAt: contact.updatedAt.toISOString() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().firstName).toBe('New');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'contact', action: 'update' } });
    expect(log.entityId).toBe(String(contact.id));
  });
});
