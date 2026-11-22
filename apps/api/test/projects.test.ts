import type { FastifyInstance } from 'fastify';
import type { Company, Lead, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { todayIn } from '../src/leads/dates';
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

type RoleKey = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER';
async function as(role: RoleKey, name?: string): Promise<{ user: User; cookie: string }> {
  const user = await makeUser({ role, name });
  return { user, cookie: await signIn(app, user) };
}

const today = () => todayIn('Europe/London');

type Row = {
  id: number; number: string; name: string; status: string; startDate: string; value: number | null; currency: string;
  company: { id: number; name: string }; lead: { id: number; number: string } | null; quotation: { id: number; number: string } | null;
  manager: { id: number; name: string }; stakeholders: { id: number; name: string; email: string | null }[];
  description: string | null; updatedAt: string; canEdit: boolean;
};

/**
 * A company (not yet a client) with contacts Asha Rao (primary), Bina Shah (the lead's contact), Chetan Iyer
 * (Decision Maker, no email) and Dev Other; a lead assigned to `assigneeId`.
 */
async function setup(assigneeId: number | null, country = 'India'): Promise<{
  company: Company; lead: Lead; asha: number; bina: number; chetan: number; dev: number;
}> {
  const company = await makeCompany({ country, name: `Acme ${country}` });
  const asha = await makeContact({ companyId: company.id, firstName: 'Asha', lastName: 'Rao', businessEmail: 'asha@acme.test' });
  await prisma.contact.update({ where: { id: asha.id }, data: { isPrimary: true } });
  const bina = await makeContact({ companyId: company.id, firstName: 'Bina', lastName: 'Shah', businessEmail: 'bina@acme.test' });
  const chetan = await makeContact({ companyId: company.id, firstName: 'Chetan', lastName: 'Iyer' });
  await prisma.contact.update({ where: { id: chetan.id }, data: { contactType: 'Decision Maker', designation: 'CEO' } });
  const dev = await makeContact({ companyId: company.id, firstName: 'Dev', lastName: 'Other', businessEmail: 'dev@acme.test' });
  const lead = await makeLead({ companyId: company.id, contactId: bina.id, assignedToId: assigneeId, status: 'Qualified' });
  return { company, lead, asha: asha.id, bina: bina.id, chetan: chetan.id, dev: dev.id };
}

let qn = 0;
/** A quotation written straight to the table (status, currency and owner as given). */
async function makeQuote(o: { companyId: number; leadId?: number | null; ownerId: number; status?: string; currency?: string; subject?: string }) {
  qn += 1;
  return prisma.quotation.create({
    data: {
      number: `Q-2026-${String(qn).padStart(3, '0')}`, companyId: o.companyId, leadId: o.leadId ?? null, ownerId: o.ownerId,
      quotationDate: new Date(`${today()}T00:00:00Z`), currency: o.currency ?? 'INR', subject: o.subject ?? `Subject ${qn}`,
      taxRate: 18, status: o.status ?? 'Draft',
    },
  });
}

const body = (companyId: number, managerId: number, extra: object = {}) => ({
  companyId, name: 'Acme · Website', status: 'Active', startDate: today(), value: 1200, currency: 'INR', managerId,
  stakeholderIds: [], description: 'Build the site', ...extra,
});

async function create(cookie: string, payload: object): Promise<Row> {
  const res = await req('POST', '/api/projects', cookie, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const edit = (cookie: string, p: Row, changes: object) => {
  const { companyId: _c, ...fields } = body(p.company.id, p.manager.id);
  return req('PATCH', `/api/projects/${p.id}`, cookie, {
    ...fields, name: p.name, status: p.status, startDate: p.startDate, value: p.value, currency: p.currency, description: p.description,
    leadId: p.lead?.id ?? null, quotationId: p.quotation?.id ?? null, stakeholderIds: p.stakeholders.map((s) => s.id),
    updatedAt: p.updatedAt, ...changes,
  });
};

const historyOf = async (id: number) =>
  ((await prisma.quotation.findUniqueOrThrow({ where: { id } })).history as { text: string }[]).map((h) => h.text);

describe('projects API — create', () => {
  it('401 when signed out; 403 without quotation rights', async () => {
    expect((await req('GET', '/api/projects')).statusCode).toBe(401);
    expect((await req('POST', '/api/projects', undefined, {})).statusCode).toBe(401);
    const research = await as('DATA_RESEARCH_USER');
    const { company } = await setup(null);
    expect((await req('POST', '/api/projects', research.cookie, body(company.id, research.user.id))).statusCode).toBe(403);
  });

  it('creates PRJ-1: Client flag, stakeholders, timeline, notification to the manager, audit row', async () => {
    const admin = await as('ADMINISTRATOR');
    const rep = await as('SALES_REPRESENTATIVE', 'Ravi Rep');
    const s = await setup(rep.user.id);
    const p = await create(admin.cookie, body(s.company.id, rep.user.id, { leadId: s.lead.id, stakeholderIds: [s.bina, s.asha] }));
    expect(p).toMatchObject({
      number: 'PRJ-1', name: 'Acme · Website', status: 'Active', startDate: today(), value: 1200, currency: 'INR',
      company: { id: s.company.id, name: s.company.name }, lead: { id: s.lead.id, number: s.lead.number }, quotation: null,
      manager: { id: rep.user.id, name: 'Ravi Rep' }, description: 'Build the site', canEdit: true,
    });
    expect(p.stakeholders).toEqual([
      { id: s.asha, name: 'Asha Rao', email: 'asha@acme.test' },
      { id: s.bina, name: 'Bina Shah', email: 'bina@acme.test' },
    ]);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: s.company.id } })).isClient).toBe(true);
    expect(await prisma.projectStakeholder.count({ where: { projectId: p.id } })).toBe(2);

    const acts = await prisma.leadActivity.findMany({ where: { leadId: s.lead.id } });
    expect(acts).toEqual([expect.objectContaining({
      title: 'Project created · PRJ-1 Acme · Website', body: 'Stakeholders: Asha Rao, Bina Shah', byUserId: admin.user.id,
      relatedType: 'project', relatedId: p.id,
    })]);
    const notes = await prisma.notification.findMany({ where: { userId: rep.user.id } });
    expect(notes).toEqual([expect.objectContaining({
      text: 'Project created · Acme · Website', detail: `${s.company.name} · from ${s.lead.number}`, link: '/projects',
    })]);
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'project', entityId: String(p.id) } });
    expect(audits).toEqual([expect.objectContaining({ action: 'create', userId: admin.user.id })]);
  });

  it('no notification when the manager creates it; no timeline without a lead; numbers run on', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const s = await setup(rep.user.id);
    await create(rep.cookie, body(s.company.id, rep.user.id, { leadId: s.lead.id }));
    const p2 = await create(rep.cookie, body(s.company.id, rep.user.id, { name: 'Second', leadId: null, value: null }));
    expect(p2).toMatchObject({ number: 'PRJ-2', lead: null, value: null });
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: s.lead.id } })).toBe(1);
  });

  it('refuses hidden leads, leads of another client, foreign stakeholders, inactive managers and unauthorised reps', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await as('SALES_REPRESENTATIVE');
    const inactive = await makeUser({ role: 'MANAGER', isActive: false });
    const mine = await setup(rep.user.id);
    const theirs = await setup(other.user.id, 'Canada');
    const post = (payload: object) => req('POST', '/api/projects', rep.cookie, payload);
    // A lead assigned to someone else is not visible to a Sales Representative.
    expect((await post(body(theirs.company.id, rep.user.id, { leadId: theirs.lead.id }))).statusCode).toBe(404);
    // A lead the rep can see (unassigned) but of another client.
    const elsewhere = await makeLead({ companyId: theirs.company.id, assignedToId: null });
    expect((await post(body(mine.company.id, rep.user.id, { leadId: elsewhere.id }))).statusCode).toBe(400);
    expect((await post(body(mine.company.id, rep.user.id, { stakeholderIds: [theirs.asha] }))).statusCode).toBe(400);
    expect((await post(body(mine.company.id, inactive.id))).statusCode).toBe(400);
    // Hidden company without a lead.
    expect((await post(body(theirs.company.id, rep.user.id))).statusCode).toBe(404);
    // An unassigned lead the rep can see: allowed only as the manager.
    const open = await makeLead({ companyId: mine.company.id, assignedToId: null });
    expect((await post(body(mine.company.id, other.user.id, { leadId: open.id }))).statusCode).toBe(403);
    expect((await post(body(mine.company.id, rep.user.id, { leadId: open.id }))).statusCode).toBe(201);
    expect(await prisma.project.count()).toBe(1);
  });

  it('Review Focus 1: a rep made manager on another rep’s lead sees and edits the project, never the lead', async () => {
    const admin = await as('ADMINISTRATOR');
    const owner = await as('SALES_REPRESENTATIVE');
    const mgr = await as('SALES_REPRESENTATIVE');
    const stranger = await as('SALES_REPRESENTATIVE');
    const s = await setup(owner.user.id);
    const p = await create(admin.cookie, body(s.company.id, mgr.user.id, { leadId: s.lead.id }));

    const list = await req('GET', '/api/projects', mgr.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((r: Row) => r.id)).toEqual([p.id]);
    expect(list.json().items[0].canEdit).toBe(true);
    expect(list.json().tiles.active).toBe(1);
    expect((await req('GET', '/api/nav-counts', mgr.cookie)).json().projects).toBe(1);
    const res = await edit(mgr.cookie, p, { name: 'Renamed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().name).toBe('Renamed');
    expect((await req('GET', `/api/leads/${s.lead.id}`, mgr.cookie)).statusCode).toBe(404);

    expect((await req('GET', '/api/projects', stranger.cookie)).json().items).toEqual([]);
    expect((await req('GET', '/api/nav-counts', stranger.cookie)).json().projects).toBe(0);
    expect((await edit(stranger.cookie, res.json(), { name: 'Nope' })).statusCode).toBe(404);
    // The lead's assignee sees it too and may edit; the owner of the lead is not the manager.
    const ownerList = (await req('GET', '/api/projects', owner.cookie)).json();
    expect(ownerList.items[0]).toMatchObject({ id: p.id, canEdit: true });
  });
});

describe('projects API — convert', () => {
  async function accepted(ownerId: number, s: Awaited<ReturnType<typeof setup>>) {
    const q = await makeQuote({ companyId: s.company.id, leadId: s.lead.id, ownerId, status: 'Accepted', currency: 'INR', subject: 'Warehouse automation advisory' });
    await prisma.quotationRevision.create({
      data: {
        quotationId: q.id, revisionNo: 1, sentAt: new Date(), sentTo: 'bina@acme.test', subtotal: 100000, discountTotal: 0,
        taxTotal: 18000, grandTotal: 118000, snapshot: {},
      },
    });
    return q;
  }

  it('refuses a quotation that is not Accepted (409)', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const s = await setup(rep.user.id);
    const q = await makeQuote({ companyId: s.company.id, leadId: s.lead.id, ownerId: rep.user.id, status: 'Sent' });
    const res = await req('POST', `/api/quotations/${q.id}/convert`, rep.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_accepted', message: 'Only an accepted quotation can become a project.' });
    expect(await prisma.project.count()).toBe(0);
  });

  it('converts an Accepted INR 1,00,000 + 18 % quotation: net value, subject, owner as manager, history and timeline', async () => {
    const admin = await as('ADMINISTRATOR');
    const rep = await as('SALES_REPRESENTATIVE');
    const s = await setup(rep.user.id);
    const q = await accepted(rep.user.id, s);
    const res = await req('POST', `/api/quotations/${q.id}/convert`, admin.cookie);
    expect(res.statusCode, res.body).toBe(201);
    const p: Row = res.json();
    expect(p).toMatchObject({
      number: 'PRJ-1', name: 'Warehouse automation advisory', value: 100000, currency: 'INR', status: 'Active', startDate: today(),
      manager: { id: rep.user.id }, lead: { id: s.lead.id }, quotation: { id: q.id, number: q.number }, company: { id: s.company.id },
    });
    // Default stakeholders: the lead's contact, then primary / Decision Maker contacts.
    expect(p.stakeholders.map((x) => x.id).sort()).toEqual([s.asha, s.bina, s.chetan].sort());
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } })).projectId).toBe(p.id);
    expect(await historyOf(q.id)).toEqual(['Converted to project PRJ-1']);
    const acts = await prisma.leadActivity.findMany({ where: { leadId: s.lead.id }, orderBy: { id: 'asc' } });
    expect(acts.map((a) => [a.title, a.body])).toEqual([
      ['Project created · PRJ-1 Warehouse automation advisory', 'Stakeholders: Asha Rao, Bina Shah, Chetan Iyer'],
      ['Converted to project PRJ-1', `From accepted quotation ${q.number}`],
    ]);
    expect(await prisma.notification.count({ where: { userId: rep.user.id, text: 'Project created · Warehouse automation advisory' } })).toBe(1);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: s.company.id } })).isClient).toBe(true);

    // The quotation's detail carries the project.
    const detail = await req('GET', `/api/quotations/${q.id}`, rep.cookie);
    expect(detail.json().project).toEqual({ id: p.id, number: 'PRJ-1', name: 'Warehouse automation advisory' });
  });

  it('Review Focus 2: a second (or concurrent) convert returns the same project, one row', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const s = await setup(rep.user.id);
    const q = await accepted(rep.user.id, s);
    const [a, b] = await Promise.all([
      req('POST', `/api/quotations/${q.id}/convert`, rep.cookie),
      req('POST', `/api/quotations/${q.id}/convert`, rep.cookie),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().id).toBe(b.json().id);
    const again = await req('POST', `/api/quotations/${q.id}/convert`, rep.cookie);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(a.json().id);
    expect(await prisma.project.count()).toBe(1);
    expect(await historyOf(q.id)).toEqual(['Converted to project PRJ-1']);
  });

  it('only users who may edit the quotation convert it; hidden quotations are 404', async () => {
    const owner = await as('SALES_REPRESENTATIVE');
    const other = await as('SALES_REPRESENTATIVE');
    const research = await as('DATA_RESEARCH_USER');
    const open = await setup(null);
    const q = await accepted(owner.user.id, open);
    // The lead is unassigned, so the other rep sees the quotation but neither owns it nor the lead.
    expect((await req('POST', `/api/quotations/${q.id}/convert`, other.cookie)).statusCode).toBe(403);
    expect((await req('POST', `/api/quotations/${q.id}/convert`, research.cookie)).statusCode).toBe(403);
    const hidden = await setup(owner.user.id);
    const hq = await accepted(owner.user.id, hidden);
    expect((await req('POST', `/api/quotations/${hq.id}/convert`, other.cookie)).statusCode).toBe(404);
  });
});

describe('projects API — linked quotation', () => {
  it('refuses a Draft, another client’s or an already linked quotation (400)', async () => {
    const admin = await as('ADMINISTRATOR');
    const s = await setup(null);
    const t = await setup(null, 'Canada');
    const draft = await makeQuote({ companyId: s.company.id, ownerId: admin.user.id, status: 'Draft' });
    const foreign = await makeQuote({ companyId: t.company.id, ownerId: admin.user.id, status: 'Accepted' });
    const ok = await makeQuote({ companyId: s.company.id, ownerId: admin.user.id, status: 'Accepted' });
    const post = (quotationId: number) => req('POST', '/api/projects', admin.cookie, body(s.company.id, admin.user.id, { quotationId }));
    expect((await post(draft.id)).statusCode).toBe(400);
    expect((await post(foreign.id)).statusCode).toBe(400);
    expect((await post(ok.id)).statusCode).toBe(201);
    expect((await post(ok.id)).statusCode).toBe(400);
    expect(await prisma.project.count()).toBe(1);
  });

  it('Review Focus 3: swapping the quotation clears the old link; history on both; value unchanged', async () => {
    const admin = await as('ADMINISTRATOR');
    const s = await setup(null);
    const qa = await makeQuote({ companyId: s.company.id, ownerId: admin.user.id, status: 'Accepted', currency: 'USD' });
    const qb = await makeQuote({ companyId: s.company.id, ownerId: admin.user.id, status: 'Accepted', currency: 'USD' });
    const p = await create(admin.cookie, body(s.company.id, admin.user.id, { quotationId: qa.id, value: 500, currency: 'INR' }));
    expect(p).toMatchObject({ quotation: { id: qa.id }, value: 500, currency: 'INR' });
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: qa.id } })).projectId).toBe(p.id);
    expect(await historyOf(qa.id)).toEqual(['Linked to project PRJ-1']);

    const res = await edit(admin.cookie, p, { quotationId: qb.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ quotation: { id: qb.id }, value: 500, currency: 'INR' });
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: qa.id } })).projectId).toBeNull();
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: qb.id } })).projectId).toBe(p.id);
    expect(await historyOf(qa.id)).toEqual(['Linked to project PRJ-1', 'Unlinked from project PRJ-1']);
    expect(await historyOf(qb.id)).toEqual(['Linked to project PRJ-1']);

    const none = await edit(admin.cookie, res.json(), { quotationId: null });
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json().quotation).toBeNull();
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: qb.id } })).projectId).toBeNull();
    expect(await historyOf(qb.id)).toEqual(['Linked to project PRJ-1', 'Unlinked from project PRJ-1']);
    // Unlinked, it can be converted again.
    expect((await req('POST', `/api/quotations/${qb.id}/convert`, admin.cookie)).statusCode).toBe(201);
  });
});

describe('projects API — edit', () => {
  it('ignores companyId, checks the lead, sets / clears completedAt, 409 when stale', async () => {
    const admin = await as('ADMINISTRATOR');
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await as('SALES_REPRESENTATIVE');
    const s = await setup(rep.user.id);
    const t = await setup(null, 'Canada');
    const hiddenLead = await makeLead({ companyId: s.company.id, assignedToId: other.user.id });
    const p = await create(admin.cookie, body(s.company.id, rep.user.id, { leadId: s.lead.id }));

    const moved = await edit(rep.cookie, p, { companyId: t.company.id, name: 'Kept client' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ company: { id: s.company.id }, name: 'Kept client' });
    let cur: Row = moved.json();

    expect((await edit(rep.cookie, cur, { leadId: t.lead.id })).statusCode).toBe(400);
    expect((await edit(rep.cookie, cur, { leadId: hiddenLead.id })).statusCode).toBe(400);
    expect((await edit(rep.cookie, cur, { stakeholderIds: [t.asha] })).statusCode).toBe(400);
    const noLead = await edit(rep.cookie, cur, { leadId: null, stakeholderIds: [s.dev] });
    expect(noLead.statusCode, noLead.body).toBe(200);
    expect(noLead.json()).toMatchObject({ lead: null, stakeholders: [{ id: s.dev, name: 'Dev Other' }] });
    cur = noLead.json();
    // Changing the lead writes no new timeline entries.
    expect(await prisma.leadActivity.count({ where: { leadId: s.lead.id } })).toBe(1);

    const done = await edit(rep.cookie, cur, { status: 'Completed' });
    expect(done.statusCode).toBe(200);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).completedAt).toBeInstanceOf(Date);
    const back = await edit(rep.cookie, done.json(), { status: 'Active' });
    expect(back.statusCode).toBe(200);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).completedAt).toBeNull();

    // Stale: the version the dialog loaded has moved on.
    const stale = await edit(rep.cookie, done.json(), { name: 'Late' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale' });
    expect(await prisma.auditLog.count({ where: { entityType: 'project', action: 'update' } })).toBeGreaterThanOrEqual(4);
  });

  it('only the manager, the lead’s assignee or view_all_leads may edit', async () => {
    const mgrUser = await as('MANAGER');
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await as('SALES_REPRESENTATIVE');
    const s = await setup(null);
    // Unassigned lead: both reps see it; only the manager of the project (rep) may edit.
    const p = await create(rep.cookie, body(s.company.id, rep.user.id, { leadId: s.lead.id }));
    const seen = (await req('GET', '/api/projects', other.cookie)).json();
    expect(seen.items[0]).toMatchObject({ id: p.id, canEdit: false });
    expect((await edit(other.cookie, p, { name: 'x' })).statusCode).toBe(403);
    expect((await edit(mgrUser.cookie, p, { name: 'By manager role' })).statusCode).toBe(200);
  });
});

describe('projects API — list, company tab, form options', () => {
  it('tiles over all visible projects; filters by company and status; newest first', async () => {
    const admin = await as('ADMINISTRATOR');
    const s = await setup(null);
    const t = await setup(null, 'United States');
    await setup(null, 'Canada'); // not a client: not counted
    const a = await create(admin.cookie, body(s.company.id, admin.user.id, { name: 'A', value: 450000, currency: 'INR' }));
    const b = await create(admin.cookie, body(t.company.id, admin.user.id, { name: 'B', value: 12000, currency: 'USD', status: 'On hold' }));
    const c = await create(admin.cookie, body(t.company.id, admin.user.id, { name: 'C', value: null, currency: 'USD' }));
    const d = await create(admin.cookie, body(s.company.id, admin.user.id, { name: 'D', value: 50000, currency: 'INR' }));
    expect((await edit(admin.cookie, d, { status: 'Completed' })).statusCode).toBe(200);
    const old = await create(admin.cookie, body(s.company.id, admin.user.id, { name: 'Old', value: 0.5, currency: 'INR' }));
    await prisma.project.update({ where: { id: old.id }, data: { status: 'Completed', completedAt: new Date('2020-06-01T00:00:00Z') } });

    const all = (await req('GET', '/api/projects', admin.cookie)).json();
    expect(all.items.map((r: Row) => r.name)).toEqual(['Old', 'D', 'C', 'B', 'A']);
    expect(all.total).toBe(5);
    expect(all.tiles).toEqual({
      active: 2, clients: 2, onHold: 1, completedThisYear: 1,
      totals: [{ currency: 'USD', amount: 12000 }, { currency: 'INR', amount: 500000.5 }],
    });

    const filtered = (await req('GET', `/api/projects?company=${t.company.id}&status=On%20hold`, admin.cookie)).json();
    expect(filtered.items.map((r: Row) => r.id)).toEqual([b.id]);
    expect(filtered.total).toBe(1);
    expect(filtered.tiles.active).toBe(2);
    expect((await req('GET', `/api/projects?company=${s.company.id}`, admin.cookie)).json().items.map((r: Row) => r.id)).toEqual([old.id, d.id, a.id]);
    expect((await req('GET', '/api/projects?status=Done', admin.cookie)).statusCode).toBe(400);
    void c;
  });

  it('company projects tab: the client’s visible projects and the Client flag', async () => {
    const admin = await as('ADMINISTRATOR');
    const s = await setup(null);
    const t = await setup(null, 'Canada');
    expect((await req('GET', `/api/companies/${s.company.id}/projects`, admin.cookie)).json()).toEqual({ items: [], isClient: false });
    const p = await create(admin.cookie, body(s.company.id, admin.user.id));
    await create(admin.cookie, body(t.company.id, admin.user.id));
    const res = (await req('GET', `/api/companies/${s.company.id}/projects`, admin.cookie)).json();
    expect(res.isClient).toBe(true);
    expect(res.items.map((r: Row) => r.id)).toEqual([p.id]);
    const rep = await as('SALES_REPRESENTATIVE');
    expect((await req('GET', `/api/companies/${s.company.id}/projects`, rep.cookie)).statusCode).toBe(404);
  });

  it('form options: visible leads, Accepted unlinked quotations, contacts, active users', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Ravi Rep');
    const other = await as('SALES_REPRESENTATIVE');
    await makeUser({ role: 'MANAGER', isActive: false, name: 'Gone' });
    const s = await setup(rep.user.id);
    await makeLead({ companyId: s.company.id, assignedToId: other.user.id });
    const acc = await makeQuote({ companyId: s.company.id, leadId: s.lead.id, ownerId: rep.user.id, status: 'Accepted' });
    await makeQuote({ companyId: s.company.id, leadId: s.lead.id, ownerId: rep.user.id, status: 'Draft' });
    const linked = await makeQuote({ companyId: s.company.id, leadId: s.lead.id, ownerId: rep.user.id, status: 'Accepted' });
    await create(rep.cookie, body(s.company.id, rep.user.id, { quotationId: linked.id }));

    const res = await req('GET', `/api/projects/form-options?company=${s.company.id}`, rep.cookie);
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json();
    expect(o.leads).toEqual([expect.objectContaining({ id: s.lead.id, number: s.lead.number, contactId: s.bina, contactName: 'Bina Shah', status: 'Qualified' })]);
    expect(o.quotations).toEqual([expect.objectContaining({ id: acc.id, number: acc.number, status: 'Accepted' })]);
    expect(o.contacts).toEqual([
      { id: s.asha, name: 'Asha Rao', designation: null, contactType: 'Other', email: 'asha@acme.test', isPrimary: true },
      { id: s.bina, name: 'Bina Shah', designation: null, contactType: 'Other', email: 'bina@acme.test', isPrimary: false },
      { id: s.chetan, name: 'Chetan Iyer', designation: 'CEO', contactType: 'Decision Maker', email: null, isPrimary: false },
      { id: s.dev, name: 'Dev Other', designation: null, contactType: 'Other', email: 'dev@acme.test', isPrimary: false },
    ]);
    expect(o.users.map((u: { name: string }) => u.name)).toContain('Ravi Rep');
    expect(o.users.map((u: { name: string }) => u.name)).not.toContain('Gone');
    expect(o.company).toMatchObject({ id: s.company.id, isClient: true, defaultCurrency: 'INR' });
    expect((await req('GET', '/api/projects/form-options', rep.cookie)).statusCode).toBe(400);
    const hidden = await setup(other.user.id, 'Canada');
    expect((await req('GET', `/api/projects/form-options?company=${hidden.company.id}`, rep.cookie)).statusCode).toBe(404);
  });
});
