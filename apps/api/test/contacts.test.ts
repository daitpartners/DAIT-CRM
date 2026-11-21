import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

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

  it('check-duplicates matches a mobile sent next to a different landline', async () => {
    const admin = await as('ADMINISTRATOR');
    const meera = await makeContact({ mobile: '+91 98220 41178' });
    const r = (await req('POST', '/api/contacts/check-duplicates', admin.cookie, { phone: '020 6710 9999', mobile: '98220 41178' })).json();
    expect(r).toMatchObject({ auto: null, review: [{ candidate: { id: meera.id }, how: 'phone' }] });
  });

  // contacts_one_primary_per_company is a hand-written partial unique index
  // (CREATE UNIQUE INDEX ... ON contacts (company_id) WHERE is_primary) in the 1B migration SQL.
  // schema.prisma cannot express a partial index, so a future `prisma migrate dev` may generate a
  // migration that drops it: never accept such a drop. This test fails if the index goes missing.
  it('database rejects a second primary contact for the same company', async () => {
    const co = await makeCompany();
    await prisma.contact.create({ data: { companyId: co.id, firstName: 'A', lastName: 'One', isPrimary: true } });
    await expect(
      prisma.contact.create({ data: { companyId: co.id, firstName: 'B', lastName: 'Two', isPrimary: true } }),
    ).rejects.toMatchObject({ code: 'P2002' });
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

  it('deactivated contact is hidden from pickers and cannot be primary', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany();
    const a = (await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Asha', lastName: 'Rao' })).json();
    const b = (await req('POST', '/api/contacts', admin.cookie, { companyId: co.id, firstName: 'Ben', lastName: 'Ng' })).json();
    // The primary cannot be deactivated while another active contact could take over.
    const primaryOff = await req('PATCH', `/api/contacts/${a.id}`, admin.cookie, { isActive: false, updatedAt: a.updatedAt });
    expect(primaryOff.statusCode).toBe(400);
    expect(primaryOff.json()).toEqual({ error: 'last_primary_contact' });

    const off = await req('PATCH', `/api/contacts/${b.id}`, admin.cookie, { isActive: false, updatedAt: b.updatedAt });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ isActive: false, isPrimary: false });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'contact', action: 'update', entityId: String(b.id) } });
    expect(log.after).toMatchObject({ isActive: false });

    // Pickers (GET /contacts) leave it out unless asked for inactive contacts.
    const list = (await req('GET', `/api/contacts?companyId=${co.id}`, admin.cookie)).json();
    expect(list.items.map((c: { id: number }) => c.id)).toEqual([a.id]);
    const withInactive = (await req('GET', `/api/contacts?companyId=${co.id}&inactive=1`, admin.cookie)).json();
    expect(withInactive.total).toBe(2);

    // An inactive contact cannot become primary.
    const promote = await req('PATCH', `/api/contacts/${b.id}`, admin.cookie, { isPrimary: true, updatedAt: off.json().updatedAt });
    expect(promote.statusCode).toBe(400);
    expect(promote.json()).toEqual({ error: 'contact_inactive' });
    expect(await primaries(co.id)).toEqual([{ id: a.id }]);

    // A lead on the company takes the primary, never the inactive contact; an explicit inactive contact is refused.
    const leadBody = { companyName: co.name, country: 'India', leadSource: 'Manual Entry', linkCompanyId: co.id };
    expect((await req('POST', '/api/leads', admin.cookie, { ...leadBody, contactId: b.id })).statusCode).toBe(400);
    const lead = await req('POST', '/api/leads', admin.cookie, leadBody);
    expect(lead.statusCode).toBe(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.json().id } })).contactId).toBe(a.id);

    // The last active contact may be deactivated: the company is left without a primary,
    // and reactivating a contact on a company without a primary makes it primary again.
    const lastOff = await req('PATCH', `/api/contacts/${a.id}`, admin.cookie, { isActive: false, updatedAt: a.updatedAt });
    expect(lastOff.statusCode).toBe(200);
    expect(lastOff.json()).toMatchObject({ isActive: false, isPrimary: false });
    expect(await primaries(co.id)).toEqual([]);
    const back = await req('PATCH', `/api/contacts/${b.id}`, admin.cookie, { isActive: true, updatedAt: off.json().updatedAt });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ isActive: true, isPrimary: true });
  });

  it('move contact clears primary when target has one', async () => {
    const admin = await as('ADMINISTRATOR');
    const from = await makeCompany({ name: 'From Co' });
    const to = await makeCompany({ name: 'To Co' });
    const a = (await req('POST', '/api/contacts', admin.cookie, { companyId: from.id, firstName: 'Asha', lastName: 'Rao' })).json();
    const t = (await req('POST', '/api/contacts', admin.cookie, { companyId: to.id, firstName: 'Tara', lastName: 'Lee' })).json();
    const stayLead = await makeLead({ companyId: to.id, contactId: a.id });
    const oldLead = await makeLead({ companyId: from.id, contactId: a.id });

    const stale = await req('POST', `/api/contacts/${a.id}/move`, admin.cookie, { companyId: to.id, updatedAt: '2020-01-01T00:00:00.000Z' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale' });

    const res = await req('POST', `/api/contacts/${a.id}/move`, admin.cookie, { companyId: to.id, updatedAt: a.updatedAt });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ companyId: to.id, company: { name: 'To Co' }, isPrimary: false });
    expect(await primaries(to.id)).toEqual([{ id: t.id }]);
    expect(await primaries(from.id)).toEqual([]);

    // A lead of the new company keeps the contact; a lead of another company loses it, with a note.
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: stayLead.id } })).contactId).toBe(a.id);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: oldLead.id } })).contactId).toBeNull();
    const note = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: oldLead.id } });
    expect(note).toMatchObject({ activityType: 'note', title: 'Contact moved to To Co', byUserId: admin.user.id });
    expect(await prisma.leadActivity.count({ where: { leadId: stayLead.id } })).toBe(0);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'contact', action: 'update', entityId: String(a.id) }, orderBy: { id: 'desc' },
    });
    expect(log.before).toMatchObject({ companyId: from.id });
    expect(log.after).toMatchObject({ companyId: to.id });

    // Moving to a company without a primary makes it the primary there.
    const empty = await makeCompany({ name: 'Empty Co' });
    const again = await req('POST', `/api/contacts/${a.id}/move`, admin.cookie, { companyId: empty.id, updatedAt: res.json().updatedAt });
    expect(again.statusCode).toBe(200);
    expect(again.json().isPrimary).toBe(true);
  });

  it('move refuses a closed or hidden target company', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const mine = await makeCompany({ createdById: rep.user.id });
    const closed = await makeCompany({ createdById: rep.user.id });
    await prisma.company.update({ where: { id: closed.id }, data: { status: 'Closed' } });
    const hidden = await makeCompany({ createdById: admin.user.id });
    const c = await makeContact({ companyId: mine.id });
    const body = (companyId: number) => ({ companyId, updatedAt: c.updatedAt.toISOString() });
    const toClosed = await req('POST', `/api/contacts/${c.id}/move`, rep.cookie, body(closed.id));
    expect(toClosed.statusCode).toBe(409);
    expect(toClosed.json()).toEqual({ error: 'company_inactive' });
    const toHidden = await req('POST', `/api/contacts/${c.id}/move`, rep.cookie, body(hidden.id));
    expect(toHidden.statusCode).toBe(404);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: c.id } })).companyId).toBe(mine.id);
  });

  it('partial unique index still present after 1C migration', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'contacts_one_primary_per_company'`;
    expect(rows).toHaveLength(1);
  });
  it('profile fields round-trip and default to empty arrays', async () => {
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany({ name: 'Acme' });
    const c = await makeContact({ companyId: co.id, firstName: 'Asha', lastName: 'Rao' });
    const fresh = await req('GET', `/api/contacts/${c.id}`, admin.cookie);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({
      id: c.id, company: { id: co.id, name: 'Acme' }, headline: null, location: null, about: null,
      experience: [], education: [], skills: [], languages: [],
    });
    const profile = {
      headline: 'Head of Ops', location: 'Pune, India', about: 'Runs operations.',
      experience: [
        { title: 'Head of Ops', company: 'Acme', from: '2021-04', to: null, description: 'Plants and logistics' },
        { title: 'Manager', company: 'Beta', from: '2017-01', to: '2021-03', description: null },
      ],
      education: [{ school: 'IIT Bombay', degree: 'B.Tech', from: '2010', to: '2014' }],
      skills: ['Lean', 'SAP'],
      languages: ['English', 'Hindi'],
    };
    const res = await req('PATCH', `/api/contacts/${c.id}`, admin.cookie, { ...profile, updatedAt: c.updatedAt.toISOString() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ headline: 'Head of Ops', location: 'Pune, India' });
    const got = await req('GET', `/api/contacts/${c.id}`, admin.cookie);
    expect(got.json()).toMatchObject(profile);
    const list = (await req('GET', `/api/contacts?companyId=${co.id}`, admin.cookie)).json();
    expect(list.items[0]).toMatchObject({ headline: 'Head of Ops', location: 'Pune, India' });
    expect(list.items[0].experience).toBeUndefined();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'contact', entityId: String(c.id), action: 'update' } });
    expect(log.after).toMatchObject({ headline: 'Head of Ops' });
  });

  it('GET /contacts/:id is 404 for a hidden company or unknown id', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const hidden = await makeCompany({ createdById: other.id });
    await makeLead({ companyId: hidden.id, assignedToId: other.id });
    const c = await makeContact({ companyId: hidden.id });
    expect((await req('GET', `/api/contacts/${c.id}`, rep.cookie)).statusCode).toBe(404);
    expect((await req('GET', '/api/contacts/999999', rep.cookie)).statusCode).toBe(404);
    expect((await req('GET', '/api/contacts/abc', rep.cookie)).statusCode).toBe(404);
    expect((await req('GET', `/api/contacts/${c.id}`)).statusCode).toBe(401);
  });

  it('rejects 21 experience rows', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeContact();
    const row = { title: 'T', company: 'C', from: '2020', to: null, description: null };
    const res = await req('PATCH', `/api/contacts/${c.id}`, admin.cookie, {
      experience: Array.from({ length: 21 }, () => row), updatedAt: c.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(400);
    const ok = await req('PATCH', `/api/contacts/${c.id}`, admin.cookie, {
      experience: Array.from({ length: 20 }, () => row), updatedAt: c.updatedAt.toISOString(),
    });
    expect(ok.statusCode).toBe(200);
  });
});
