import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { resetDb } from './helpers';
import { makeCompany, makeLead, makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(resetDb);

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

async function as(role: 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER') {
  const user = await makeUser({ role });
  return { user, cookie: await signIn(app, user) };
}

const acme = { name: 'Acme', website: 'https://www.Acme.co.uk/about', country: 'United Kingdom' };

describe('companies API', () => {
  it('401 when signed out', async () => {
    expect((await req('GET', '/api/companies')).statusCode).toBe(401);
    expect((await req('POST', '/api/companies', undefined, acme)).statusCode).toBe(401);
  });

  it('creates a company with a CO- number, domain and audit row', async () => {
    const admin = await as('ADMINISTRATOR');
    const res = await req('POST', '/api/companies', admin.cookie, acme);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toMatch(/^CO-\d{4,}$/);
    expect(body).toMatchObject({
      name: 'Acme', domain: 'acme.co.uk', country: 'United Kingdom', status: 'Active', isClient: false,
      verificationStatus: 'Unverified', createdBy: { id: admin.user.id, name: admin.user.name },
    });
    const row = await prisma.company.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.nameNormalised).toBe('acme');
    expect(row.createdById).toBe(admin.user.id);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'company', action: 'create' } });
    expect(log.entityId).toBe(String(body.id));
    expect(log.userId).toBe(admin.user.id);
  });

  it('normalises domain before the unique check', async () => {
    const admin = await as('ADMINISTRATOR');
    const first = (await req('POST', '/api/companies', admin.cookie, acme)).json();
    const res = await req('POST', '/api/companies', admin.cookie, { name: 'Acme Two', businessEmail: 'x@acme.co.uk', country: 'United Kingdom' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'domain_taken', companyId: first.id });
  });

  it('free-mail business email yields no domain', async () => {
    const admin = await as('ADMINISTRATOR');
    const a = await req('POST', '/api/companies', admin.cookie, { name: 'Solo One', businessEmail: 'x@gmail.com', country: 'India' });
    expect(a.statusCode).toBe(201);
    expect(a.json().domain).toBeNull();
    const b = await req('POST', '/api/companies', admin.cookie, { name: 'Solo Two', businessEmail: 'y@gmail.com', country: 'India' });
    expect(b.statusCode).toBe(201);
  });

  it('lists with paging, search and sort', async () => {
    const admin = await as('ADMINISTRATOR');
    for (let i = 1; i <= 29; i += 1) await makeCompany({ name: `Alpha ${String(i).padStart(2, '0')}` });
    const zenith = await makeCompany({ name: 'Zenith Works' });
    const page3 = await req('GET', '/api/companies?pageSize=10&page=3&sort=name&dir=desc', admin.cookie);
    expect(page3.statusCode).toBe(200);
    expect(page3.json()).toMatchObject({ total: 30, page: 3, pageSize: 10 });
    expect(page3.json().items).toHaveLength(10);
    expect(page3.json().items[9].name).toBe('Alpha 01');
    const page1 = (await req('GET', '/api/companies?pageSize=10&sort=name&dir=desc', admin.cookie)).json();
    expect(page1.items[0]).toEqual({
      id: zenith.id, number: zenith.number, name: 'Zenith Works', domain: null, industry: null, country: 'India',
      city: null, status: 'Active', isClient: false, primaryContact: null, contactCount: 0,
      employeeRange: null, verificationStatus: 'Unverified', leadCount: 0,
      updatedAt: zenith.updatedAt.toISOString(),
    });
    const found = (await req('GET', '/api/companies?q=zen', admin.cookie)).json();
    expect(found.total).toBe(1);
    expect(found.items.map((c: { name: string }) => c.name)).toEqual(['Zenith Works']);
    expect((await req('GET', '/api/companies?q=', admin.cookie)).json().total).toBe(30);
  });

  it('rejects an unknown sort column', async () => {
    const admin = await as('ADMINISTRATOR');
    const res = await req('GET', '/api/companies?sort=nameNormalised', admin.cookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });

  it('sales representative sees only companies they created', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    expect((await req('POST', '/api/companies', rep.cookie, { name: 'Rep Co', country: 'India' })).statusCode).toBe(201);
    expect((await req('POST', '/api/companies', admin.cookie, { name: 'Admin Co', country: 'India' })).statusCode).toBe(201);
    const list = (await req('GET', '/api/companies', rep.cookie)).json();
    expect(list.total).toBe(1);
    expect(list.items[0].name).toBe('Rep Co');
    expect((await req('GET', '/api/companies', admin.cookie)).json().total).toBe(2);
  });

  it("sales representative cannot read another user's company", async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const other = await makeCompany({ name: 'Hidden Co', createdById: admin.user.id });
    const res = await req('GET', `/api/companies/${other.id}`, rep.cookie);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    const patch = await req('PATCH', `/api/companies/${other.id}`, rep.cookie, { name: 'Mine', updatedAt: other.updatedAt.toISOString() });
    expect(patch.statusCode).toBe(404);
    expect((await req('GET', '/api/companies/abc', rep.cookie)).statusCode).toBe(404);
  });

  it('rep sees a company through an assigned lead', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const theirs = await makeCompany({ name: 'Lead Co', createdById: admin.user.id });
    const hidden = await makeCompany({ name: 'Other Co', createdById: admin.user.id });
    await makeLead({ companyId: theirs.id, assignedToId: rep.user.id });
    await makeLead({ companyId: hidden.id, assignedToId: admin.user.id });
    const list = (await req('GET', '/api/companies', rep.cookie)).json();
    expect(list.items.map((c: { name: string }) => c.name)).toEqual(['Lead Co']);
    expect((await req('GET', `/api/companies/${theirs.id}`, rep.cookie)).statusCode).toBe(200);
    expect((await req('GET', `/api/companies/${hidden.id}`, rep.cookie)).statusCode).toBe(404);
  });

  it('data research user sees every company', async () => {
    const dru = await as('DATA_RESEARCH_USER');
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ createdById: admin.user.id });
    await makeCompany();
    expect((await req('GET', '/api/companies', dru.cookie)).json().total).toBe(2);
    expect((await req('GET', `/api/companies/${c.id}`, dru.cookie)).statusCode).toBe(200);
  });

  it('rejects a stale update', async () => {
    const admin = await as('ADMINISTRATOR');
    const created = (await req('POST', '/api/companies', admin.cookie, acme)).json();
    const stale = await req('PATCH', `/api/companies/${created.id}`, admin.cookie, { name: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale' });
    const ok = await req('PATCH', `/api/companies/${created.id}`, admin.cookie, { name: 'Acme Holdings Ltd', updatedAt: created.updatedAt });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('Acme Holdings Ltd');
    const row = await prisma.company.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.nameNormalised).toBe('acme holdings');
    expect(row.domain).toBe('acme.co.uk');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'company', action: 'update' } });
    expect((log.before as { name: string }).name).toBe('Acme');
    expect((log.after as { name: string }).name).toBe('Acme Holdings Ltd');
  });

  it('clearing a field stores null', async () => {
    const admin = await as('ADMINISTRATOR');
    const created = (await req('POST', '/api/companies', admin.cookie, { ...acme, legalName: 'Acme Ltd' })).json();
    expect(created.legalName).toBe('Acme Ltd');
    const res = await req('PATCH', `/api/companies/${created.id}`, admin.cookie, { legalName: '', website: '', updatedAt: created.updatedAt });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ legalName: null, website: null, domain: null });
  });

  it('check-duplicates returns auto on domain and review on name + country', async () => {
    const admin = await as('ADMINISTRATOR');
    const acmeRow = await makeCompany({ name: 'Acme', website: 'https://acme.co.uk', createdById: admin.user.id });
    const nw = await makeCompany({ name: 'Northwind Logistics Pvt Ltd', country: 'India', createdById: admin.user.id });
    const auto = await req('POST', '/api/companies/check-duplicates', admin.cookie, { website: 'www.acme.co.uk/contact' });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().auto).toMatchObject({ id: acmeRow.id, number: acmeRow.number, domain: 'acme.co.uk' });
    const review = (await req('POST', '/api/companies/check-duplicates', admin.cookie, { name: 'Northwind Logistics', country: 'India' })).json();
    expect(review.auto).toBeNull();
    expect(review.review).toEqual([{ candidate: expect.objectContaining({ id: nw.id, country: 'India' }), how: 'name_country' }]);
    // A company the user cannot see is still reported, with id, number and name only.
    const rep = await as('SALES_REPRESENTATIVE');
    const hidden = (await req('POST', '/api/companies/check-duplicates', rep.cookie, { website: 'acme.co.uk' })).json();
    expect(hidden.auto).toEqual({ id: acmeRow.id, number: acmeRow.number, name: 'Acme' });
  });

  it('bulk-status deactivates only visible companies', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const mine = await makeCompany({ createdById: rep.user.id });
    const theirs = await makeCompany({ createdById: admin.user.id });
    const res = await req('POST', '/api/companies/bulk-status', rep.cookie, { ids: [mine.id, theirs.id], status: 'Inactive' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 1 });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('Inactive');
    expect((await prisma.company.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('Active');
    const logs = await prisma.auditLog.findMany({ where: { entityType: 'company', action: 'update' } });
    expect(logs.map((l) => l.entityId)).toEqual([String(mine.id)]);
  });
  it('sales rep cannot change isClient', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const co = await makeCompany({ createdById: rep.user.id });
    const res = await req('PATCH', `/api/companies/${co.id}`, rep.cookie, { isClient: true, updatedAt: co.updatedAt.toISOString() });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: co.id } })).isClient).toBe(false);
    // Other fields still save for the rep.
    const ok = await req('PATCH', `/api/companies/${co.id}`, rep.cookie, { city: 'Pune', updatedAt: co.updatedAt.toISOString() });
    expect(ok.statusCode).toBe(200);

    for (const role of ['ADMINISTRATOR', 'MANAGER'] as const) {
      const who = await as(role);
      const fresh = await prisma.company.findUniqueOrThrow({ where: { id: co.id } });
      const flip = await req('PATCH', `/api/companies/${co.id}`, who.cookie, { isClient: !fresh.isClient, updatedAt: fresh.updatedAt.toISOString() });
      expect(flip.statusCode).toBe(200);
      expect(flip.json().isClient).toBe(!fresh.isClient);
    }
  });
  it('data research user cannot change isClient', async () => {
    const dru = await as('DATA_RESEARCH_USER');
    const co = await makeCompany({ createdById: dru.user.id });
    const res = await req('PATCH', `/api/companies/${co.id}`, dru.cookie, { isClient: true, updatedAt: co.updatedAt.toISOString() });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: co.id } })).isClient).toBe(false);
    const ok = await req('PATCH', `/api/companies/${co.id}`, dru.cookie, { city: 'Lyon', updatedAt: co.updatedAt.toISOString() });
    expect(ok.statusCode).toBe(200);
  });
  it('tiles and tab counts respect visibility', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    // The rep sees three companies: two they created and one through an assigned lead.
    const a = await makeCompany({ name: 'Rep Alpha', createdById: rep.user.id });
    const b = await makeCompany({ name: 'Rep Beta', createdById: rep.user.id });
    const viaLead = await makeCompany({ name: 'Via Lead', createdById: admin.user.id });
    await makeLead({ companyId: viaLead.id, assignedToId: rep.user.id, status: 'New' });
    await prisma.company.update({ where: { id: a.id }, data: { verificationStatus: 'Verified', aiResearchStatus: 'Completed', isClient: true } });
    await prisma.company.update({ where: { id: b.id }, data: { verificationStatus: 'Partially Verified', aiResearchStatus: 'Processing', status: 'Inactive' } });
    await prisma.company.update({ where: { id: viaLead.id }, data: { aiResearchStatus: 'Failed' } });
    await makeLead({ companyId: b.id, assignedToId: rep.user.id, status: 'Won' });
    // Hidden from the rep: must not change any of their numbers.
    const hidden = await makeCompany({ name: 'Hidden One', createdById: admin.user.id });
    await prisma.company.update({ where: { id: hidden.id }, data: { verificationStatus: 'Verified', isClient: true } });
    await makeLead({ companyId: hidden.id, assignedToId: admin.user.id });

    const list = (await req('GET', '/api/companies', rep.cookie)).json();
    expect(list.total).toBe(3);
    expect(list.tiles).toEqual({
      total: 3, active: 2, inactive: 1, closed: 0,
      verified: 1, partiallyVerified: 1, unverified: 1,
      aiQueue: 1, aiPending: 0, aiProcessing: 1, aiFailed: 1,
      possibleDuplicates: 0,
    });
    expect(list.counts).toEqual({ all: 3, clients: 1, open: 1, verify: 2, dups: 0 });
    expect(list.tiles.total).toBe(list.total);

    const names = async (tab: string) =>
      ((await req('GET', `/api/companies?tab=${tab}`, rep.cookie)).json().items as { name: string }[]).map((c) => c.name);
    expect(await names('clients')).toEqual(['Rep Alpha']);
    expect(await names('open')).toEqual(['Via Lead']);
    expect(await names('verify')).toEqual(['Rep Beta', 'Via Lead']);
    expect((await req('GET', '/api/companies?tab=nope', rep.cookie)).statusCode).toBe(400);

    // Rows carry the prototype columns; the lead count only counts leads the user may see.
    const row = list.items.find((c: { name: string }) => c.name === 'Via Lead');
    expect(row).toMatchObject({ verificationStatus: 'Unverified', employeeRange: null, leadCount: 1, contactCount: 0 });

    const all = (await req('GET', '/api/companies', admin.cookie)).json();
    expect(all.tiles.total).toBe(4);
    expect(all.counts).toMatchObject({ all: 4, clients: 2, open: 2 });
  });

  it('dups tab lists companies sharing a normalised name', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    await makeCompany({ name: 'Acme Ltd', createdById: rep.user.id, country: 'India' });
    await makeCompany({ name: 'ACME Limited', createdById: rep.user.id, country: 'Germany' });
    await makeCompany({ name: 'Solo Co', createdById: rep.user.id });
    // Shares the name but is invisible to the rep: the rep's own pair still counts, this one does not.
    await makeCompany({ name: 'Acme', createdById: admin.user.id });
    await makeCompany({ name: 'Beta Corp', createdById: rep.user.id });
    await makeCompany({ name: 'Beta Corporation', createdById: admin.user.id });

    const repList = (await req('GET', '/api/companies?tab=dups', rep.cookie)).json();
    expect(repList.items.map((c: { name: string }) => c.name).sort()).toEqual(['ACME Limited', 'Acme Ltd']);
    expect(repList.total).toBe(2);
    expect(repList.counts.dups).toBe(2);
    expect(repList.tiles.possibleDuplicates).toBe(2);
    expect(repList.counts.all).toBe(4);

    const adminList = (await req('GET', '/api/companies?tab=dups', admin.cookie)).json();
    expect(adminList.counts.dups).toBe(adminList.total);
    expect(adminList.items.map((c: { name: string }) => c.name).sort()).toEqual(
      ['ACME Limited', 'Acme', 'Acme Ltd', 'Beta Corp', 'Beta Corporation'].sort(),
    );
  });

  it('company activities carry a per-type summary of the leads the user may see', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany({ createdById: rep.user.id });
    const mine = await makeLead({ companyId: co.id, assignedToId: rep.user.id });
    const theirs = await makeLead({ companyId: co.id, assignedToId: admin.user.id });
    const at = (d: string) => new Date(`2026-11-${d}T10:00:00Z`);
    await prisma.leadActivity.createMany({ data: [
      { leadId: mine.id, activityType: 'call', title: 'c1', occurredAt: at('01') },
      { leadId: mine.id, activityType: 'call', title: 'c2', occurredAt: at('03') },
      { leadId: mine.id, activityType: 'meeting', title: 'm', occurredAt: at('02') },
      { leadId: theirs.id, activityType: 'email', title: 'hidden', occurredAt: at('09') },
      // A planned meeting next week counts as a meeting but is not the last touch yet.
      { leadId: mine.id, activityType: 'meeting', title: 'planned', occurredAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
    ] });
    const res = (await req('GET', `/api/companies/${co.id}/activities`, rep.cookie)).json();
    expect(res.summary).toEqual({ call: 2, email: 0, meeting: 2, quote: 0, lastAt: at('03').toISOString() });
  });
  it('company pipeline respects lead visibility', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const admin = await as('ADMINISTRATOR');
    const co = await makeCompany({ createdById: rep.user.id });
    await makeLead({ companyId: co.id, assignedToId: rep.user.id, status: 'New' });
    await makeLead({ companyId: co.id, assignedToId: rep.user.id, status: 'Contacted' });
    await makeLead({ companyId: co.id, assignedToId: rep.user.id, status: 'Won' });
    await makeLead({ companyId: co.id, assignedToId: null, status: 'Lost' });
    await makeLead({ companyId: co.id, assignedToId: rep.user.id, status: 'New', archivedAt: new Date() });
    // Someone else's leads: hidden from the rep, counted for the administrator.
    await makeLead({ companyId: co.id, assignedToId: admin.user.id, status: 'New' });
    await makeLead({ companyId: co.id, assignedToId: admin.user.id, status: 'Won' });

    const mine = (await req('GET', `/api/companies/${co.id}/pipeline`, rep.cookie)).json();
    expect(mine).toEqual({
      byStatus: [{ status: 'Contacted', count: 1 }, { status: 'Lost', count: 1 }, { status: 'New', count: 1 }, { status: 'Won', count: 1 }],
      open: 2, won: 1, lost: 1,
    });
    const all = (await req('GET', `/api/companies/${co.id}/pipeline`, admin.cookie)).json();
    expect(all).toMatchObject({ open: 3, won: 2, lost: 1 });

    const hidden = await makeCompany({ createdById: admin.user.id });
    expect((await req('GET', `/api/companies/${hidden.id}/pipeline`, rep.cookie)).statusCode).toBe(404);
    expect((await req('GET', `/api/companies/${co.id}/pipeline`)).statusCode).toBe(401);
  });
});
