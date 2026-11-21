import type { FastifyInstance } from 'fastify';
import type { Lead, User } from '@prisma/client';
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
async function as(role: RoleKey, timezone?: string): Promise<{ user: User; cookie: string }> {
  let user = await makeUser({ role });
  if (timezone) user = await prisma.user.update({ where: { id: user.id }, data: { timezone } });
  return { user, cookie: await signIn(app, user) };
}

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const shift = (s: string, days: number) => new Date(day(s).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const stamp = (l: Lead) => l.updatedAt.toISOString();
const reload = (id: number) => prisma.lead.findUniqueOrThrow({ where: { id } });
const followUp = (leadId: number, assignedToId: number, due: string) =>
  prisma.task.create({ data: { leadId, assignedToId, title: 'Follow up', dueDate: day(due), origin: 'follow_up' } });

describe('leads API', () => {
  it('401 when signed out', async () => {
    expect((await req('GET', '/api/leads')).statusCode).toBe(401);
    expect((await req('POST', '/api/leads', undefined, { companyName: 'X', country: 'India', leadSource: 'Manual Entry' })).statusCode).toBe(401);
    expect((await req('GET', '/api/leads/1')).statusCode).toBe(401);
    expect((await req('POST', '/api/leads/bulk', undefined, { ids: [1], action: 'archive' })).statusCode).toBe(401);
  });

  it('creates a lead with LD- number, links company on domain and audits', async () => {
    const admin = await as('ADMINISTRATOR');
    const acme = await makeCompany({ name: 'Acme', website: 'https://acme.co.uk', country: 'United Kingdom' });
    const res = await req('POST', '/api/leads', admin.cookie, {
      companyName: 'Acme Holdings', website: 'https://www.acme.co.uk/contact', country: 'United Kingdom', leadSource: 'Manual Entry',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.number).toMatch(/^LD-\d{4,}$/);
    expect(body).toMatchObject({ companyId: acme.id, company: { id: acme.id }, status: 'New', leadType: 'Lead', createdBy: { id: admin.user.id } });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', action: 'create' } });
    expect(log).toMatchObject({ entityId: String(body.id), userId: admin.user.id });
    expect(await prisma.auditLog.count({ where: { entityType: 'company' } })).toBe(0);

    // No match: a new company is created and audited too.
    const fresh = await req('POST', '/api/leads', admin.cookie, { companyName: 'Brand New Ltd', country: 'India', leadSource: 'Manual Entry' });
    expect(fresh.statusCode).toBe(201);
    const companyId = fresh.json().companyId as number;
    expect(companyId).not.toBe(acme.id);
    const companyLog = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'company', action: 'create' } });
    expect(companyLog.entityId).toBe(String(companyId));

    // Assignee rules: a rep may assign only to self.
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await makeUser();
    const refused = await req('POST', '/api/leads', rep.cookie, { companyName: 'Other Co', country: 'India', leadSource: 'Manual Entry', assignedToId: other.id });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'cannot_assign_hidden' });
    const self = await req('POST', '/api/leads', rep.cookie, { companyName: 'Self Co', country: 'India', leadSource: 'Manual Entry', assignedToId: rep.user.id });
    expect(self.statusCode).toBe(201);
    expect(self.json().assignedTo).toEqual({ id: rep.user.id, name: rep.user.name });
    const inactive = await makeUser({ isActive: false });
    const gone = await req('POST', '/api/leads', admin.cookie, { companyName: 'Gone Co', country: 'India', leadSource: 'Manual Entry', assignedToId: inactive.id });
    expect(gone.json()).toEqual({ error: 'cannot_assign_hidden' });
  });

  it('rep sees unassigned and own only', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const otherRep = await makeUser();
    const mine = await makeLead({ assignedToId: rep.user.id });
    const theirs = await makeLead({ assignedToId: otherRep.id });
    const open = await makeLead();
    const list = await req('GET', '/api/leads', rep.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
    expect(list.json().items.map((i: { id: number }) => i.id).sort()).toEqual([mine.id, open.id].sort());
    expect(list.json().counts.all).toBe(2);
    expect((await req('GET', `/api/leads/${theirs.id}`, rep.cookie)).statusCode).toBe(404);
    expect((await req('GET', `/api/leads/${mine.id}`, rep.cookie)).statusCode).toBe(200);
    const patch = await req('PATCH', `/api/leads/${theirs.id}`, rep.cookie, { notes: 'x', updatedAt: stamp(theirs) });
    expect(patch.statusCode).toBe(404);
  });

  it('data research user sees prospects and own leads', async () => {
    const dru = await as('DATA_RESEARCH_USER');
    const other = await makeUser();
    const prospect = await makeLead({ leadType: 'Prospect', assignedToId: other.id });
    const own = await makeLead({ assignedToId: dru.user.id });
    await makeLead({ assignedToId: other.id });
    await makeLead();
    const list = (await req('GET', '/api/leads', dru.cookie)).json();
    expect(list.total).toBe(2);
    expect(list.items.map((i: { id: number }) => i.id).sort()).toEqual([prospect.id, own.id].sort());
  });

  it('list tabs and tiles count correctly', async () => {
    const mgr = await as('MANAGER', 'Europe/London');
    const other = await makeUser();
    const today = todayIn('Europe/London');
    const contact = await makeContact({ firstName: 'Zelda', lastName: 'Quixote' });
    const web = await makeLead({ leadSource: 'Website Contact Form', companyId: contact.companyId, contactId: contact.id });
    const prospect = await makeLead({ leadType: 'Prospect', assignedToId: mgr.user.id });
    const old = await makeLead({ assignedToId: mgr.user.id, createdAt: new Date(Date.now() - 10 * 86_400_000), nextFollowUp: day(shift(today, -1)) });
    await followUp(old.id, mgr.user.id, shift(today, -1));
    const due = await makeLead({ assignedToId: other.id, nextFollowUp: day(today) });
    await followUp(due.id, other.id, today);
    await makeLead({ archivedAt: new Date() });

    const res = await req('GET', '/api/leads', mgr.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 4, page: 1, pageSize: 25 });
    expect(body.counts).toEqual({ all: 4, leads: 3, prospects: 1, mine: 2, overdue: 1, unassigned: 1 });
    expect(body.tiles).toEqual({ newThisWeek: 3, newThisWeekFromWebsite: 1, followUpsDueToday: 1, overdue: 1, unassigned: 1 });
    // Newest first by default.
    expect(body.items[0].id).toBe(due.id);

    const ids = async (qs: string) => (await req('GET', `/api/leads?${qs}`, mgr.cookie)).json().items.map((i: { id: number }) => i.id);
    expect(await ids('tab=overdue')).toEqual([old.id]);
    expect(await ids('tab=prospects')).toEqual([prospect.id]);
    expect(await ids('tab=unassigned')).toEqual([web.id]);
    expect((await ids('tab=mine')).sort()).toEqual([prospect.id, old.id].sort());
    expect(await ids('q=quixote')).toEqual([web.id]);
    expect(await ids(`q=${encodeURIComponent(due.number.toLowerCase())}`)).toEqual([due.id]);
    expect(await ids(`assignedTo=${other.id}`)).toEqual([due.id]);
    expect((await ids('archived=1')).length).toBe(5);

    // A rep sees only own + unassigned in tiles too, and may not ask for archived leads.
    const rep = await as('SALES_REPRESENTATIVE');
    // A stray follow-up task of the rep's on a lead they cannot see is not counted.
    await followUp(due.id, rep.user.id, today);
    const repBody = (await req('GET', '/api/leads', rep.cookie)).json();
    expect(repBody.counts).toEqual({ all: 1, leads: 1, prospects: 0, mine: 0, overdue: 0, unassigned: 1 });
    expect(repBody.tiles).toEqual({ newThisWeek: 1, newThisWeekFromWebsite: 1, followUpsDueToday: 0, overdue: 0, unassigned: 1 });
    expect((await req('GET', '/api/leads?archived=1', rep.cookie)).statusCode).toBe(403);
  });

  it('overdue tab uses the user\'s timezone', async () => {
    const east = await as('MANAGER', 'Pacific/Kiritimati');
    const west = await as('MANAGER', 'Pacific/Pago_Pago');
    const lead = await makeLead({ assignedToId: east.user.id });
    // Yesterday in UTC+14 is today or tomorrow in UTC-11.
    await followUp(lead.id, east.user.id, shift(todayIn('Pacific/Kiritimati'), -1));
    expect((await req('GET', '/api/leads?tab=overdue', east.cookie)).json().total).toBe(1);
    expect((await req('GET', '/api/leads?tab=overdue', west.cookie)).json().total).toBe(0);
    expect((await req('GET', '/api/leads', west.cookie)).json().counts.overdue).toBe(0);
  });

  it('status change to Won via route flags client', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const company = await makeCompany();
    const lead = await makeLead({ companyId: company.id, assignedToId: rep.user.id, status: 'Contacted' });
    const lost = await req('POST', `/api/leads/${lead.id}/status`, rep.cookie, { status: 'Lost', updatedAt: stamp(lead) });
    expect(lost.statusCode).toBe(400);
    expect(lost.json()).toEqual({ error: 'reason_required' });
    const bad = await req('POST', `/api/leads/${lead.id}/status`, rep.cookie, { status: 'Bogus', updatedAt: stamp(lead) });
    expect(bad.json()).toEqual({ error: 'invalid_status' });
    const res = await req('POST', `/api/leads/${lead.id}/status`, rep.cookie, { status: 'Won', updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'Won', convertedTo: 'client', company: { isClient: true } });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: company.id } })).isClient).toBe(true);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(lead.id), action: 'update' } });
    expect(log.after).toMatchObject({ status: 'Won' });
  });

  it('log call with status and follow-up in one go', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const tomorrow = shift(todayIn(rep.user.timezone), 1);
    const res = await req('POST', `/api/leads/${lead.id}/log-call`, rep.cookie, {
      outcome: 'Connected', minutes: 5, body: 'Spoke to the owner', statusAfter: 'Interested', nextFollowUp: tomorrow, updatedAt: stamp(lead),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'Interested', nextFollowUp: tomorrow });
    const call = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'call' } });
    expect(call).toMatchObject({ title: 'Call · Connected', body: '5 min · Spoke to the owner', byUserId: rep.user.id });
    const st = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'status' } });
    expect(st).toMatchObject({ statusTo: 'Interested', body: 'Log call' });
    const tasks = await prisma.task.findMany({ where: { leadId: lead.id, isDone: false } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ origin: 'follow_up', assignedToId: rep.user.id, dueDate: day(tomorrow) });
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', entityId: String(lead.id) } })).toBe(1);

    const detail = (await req('GET', `/api/leads/${lead.id}`, rep.cookie)).json();
    expect(detail.activityTotal).toBe(2);
    expect(detail.activities[0].activityType).toBe('status');
    expect(detail.tasks).toHaveLength(1);
    expect(detail.assignments).toEqual([]);
  });

  it('switch contact refuses contact of another company', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const company = await makeCompany();
    const elsewhere = await makeContact();
    const retired = await makeContact({ companyId: company.id });
    await prisma.contact.update({ where: { id: retired.id }, data: { isActive: false } });
    const good = await makeContact({ companyId: company.id, firstName: 'Ada', lastName: 'Lovelace' });
    const lead = await makeLead({ companyId: company.id, assignedToId: rep.user.id });
    const url = `/api/leads/${lead.id}/contact`;
    expect((await req('POST', url, rep.cookie, { contactId: elsewhere.id, updatedAt: stamp(lead) })).statusCode).toBe(400);
    expect((await req('POST', url, rep.cookie, { contactId: retired.id, updatedAt: stamp(lead) })).statusCode).toBe(400);
    const res = await req('POST', url, rep.cookie, { contactId: good.id, updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(200);
    expect(res.json().contact).toMatchObject({ id: good.id, name: 'Ada Lovelace' });
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(act).toMatchObject({ activityType: 'assign', title: 'Contact switched to Ada Lovelace' });
  });

  it('archive hides the lead and refuses edits', async () => {
    const mgr = await as('MANAGER');
    const lead = await makeLead();
    const res = await req('POST', `/api/leads/${lead.id}/archive`, mgr.cookie, { updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedAt).not.toBeNull();
    expect((await req('GET', '/api/leads', mgr.cookie)).json().total).toBe(0);
    const archived = await reload(lead.id);
    const patch = await req('PATCH', `/api/leads/${lead.id}`, mgr.cookie, { notes: 'x', updatedAt: stamp(archived) });
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toEqual({ error: 'lead_archived' });
    const status = await req('POST', `/api/leads/${lead.id}/status`, mgr.cookie, { status: 'Contacted', updatedAt: stamp(archived) });
    expect(status.json()).toEqual({ error: 'lead_archived' });
    const back = await req('POST', `/api/leads/${lead.id}/unarchive`, mgr.cookie, { updatedAt: stamp(archived) });
    expect(back.statusCode).toBe(200);
    expect(back.json().archivedAt).toBeNull();
    expect((await req('GET', '/api/leads', mgr.cookie)).json().total).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', entityId: String(lead.id) } })).toBe(2);
  });

  it('bulk assign writes assignment rows and requires a note', async () => {
    const mgr = await as('MANAGER');
    const repA = await makeUser();
    const repB = await makeUser();
    const free = await makeLead();
    const held = await makeLead({ assignedToId: repA.id });
    const ids = [free.id, held.id];
    const noNote = await req('POST', '/api/leads/bulk', mgr.cookie, { ids, action: 'assign', toUserId: repB.id });
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json()).toEqual({ error: 'transfer_note_required' });
    const ok = await req('POST', '/api/leads/bulk', mgr.cookie, { ids, action: 'assign', toUserId: repB.id, note: 'Territory change' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ updated: 2 });
    expect((await reload(free.id)).assignedToId).toBe(repB.id);
    expect((await reload(held.id)).assignedToId).toBe(repB.id);
    const rows = await prisma.leadAssignment.findMany({ where: { leadId: { in: ids } }, orderBy: { leadId: 'asc' } });
    expect(rows.map((r) => [r.fromUserId, r.toUserId, r.byUserId, r.note])).toEqual([
      [null, repB.id, mgr.user.id, 'Territory change'], [repA.id, repB.id, mgr.user.id, 'Territory change'],
    ]);
    expect(await prisma.auditLog.count({ where: { entityType: 'lead' } })).toBe(2);

    // A rep may bulk-assign only to self, and only leads they can see.
    const rep = await as('SALES_REPRESENTATIVE');
    const repFree = await makeLead();
    const hidden = await req('POST', '/api/leads/bulk', rep.cookie, { ids: [repFree.id], action: 'assign', toUserId: repB.id });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json()).toEqual({ error: 'forbidden' });
    const claim = await req('POST', '/api/leads/bulk', rep.cookie, { ids: [repFree.id, held.id], action: 'assign', toUserId: rep.user.id });
    expect(claim.json()).toEqual({ updated: 1 });

    const archive = await req('POST', '/api/leads/bulk', mgr.cookie, { ids, action: 'archive' });
    expect(archive.json()).toEqual({ updated: 2 });
    expect((await reload(free.id)).archivedAt).not.toBeNull();
    const unarchive = await req('POST', '/api/leads/bulk', mgr.cookie, { ids, action: 'unarchive' });
    expect(unarchive.json()).toEqual({ updated: 2 });
  });

  it('creates lead without company when a review match exists', async () => {
    const admin = await as('ADMINISTRATOR');
    const meridian = await makeCompany({ name: 'Meridian Textiles', country: 'India' });
    const res = await req('POST', '/api/leads', admin.cookie, { companyName: 'Meridian Textiles', country: 'India', leadSource: 'Manual Entry' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ companyId: null, company: null, companyName: 'Meridian Textiles' });
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'company' } })).toBe(0);

    // The lead page's Choose company links the existing one.
    const linked = await req('POST', `/api/leads/${body.id}/resolve-company`, admin.cookie, { companyId: meridian.id, updatedAt: body.updatedAt });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ companyId: meridian.id });
    expect(await prisma.company.count()).toBe(1);
  });

  it('data research user cannot bulk-assign to self', async () => {
    const dru = await as('DATA_RESEARCH_USER');
    const lead = await makeLead({ leadType: 'Prospect' });
    const res = await req('POST', '/api/leads/bulk', dru.cookie, { ids: [lead.id], action: 'assign', toUserId: dru.user.id });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect((await reload(lead.id)).assignedToId).toBeNull();
    expect(await prisma.leadAssignment.count()).toBe(0);
  });

  it('sales rep bulk-claims only unassigned leads', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await makeUser();
    const [a, b] = [await makeLead(), await makeLead()];
    const mine = await makeLead({ assignedToId: rep.user.id });
    const ok = await req('POST', '/api/leads/bulk', rep.cookie, { ids: [a.id, b.id, mine.id], action: 'assign', toUserId: rep.user.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ updated: 2 });
    expect((await reload(a.id)).assignedToId).toBe(rep.user.id);
    expect((await reload(b.id)).assignedToId).toBe(rep.user.id);

    // Assigning to anyone else is refused, even with a note.
    const c = await makeLead();
    const toOther = await req('POST', '/api/leads/bulk', rep.cookie, { ids: [c.id], action: 'assign', toUserId: other.id, note: 'Yours' });
    expect(toOther.statusCode).toBe(403);
    expect(toOther.json()).toEqual({ error: 'forbidden' });
    expect((await reload(c.id)).assignedToId).toBeNull();
  });

  it('sales rep cannot bulk-unassign', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const res = await req('POST', '/api/leads/bulk', rep.cookie, { ids: [lead.id], action: 'assign', toUserId: null, note: 'Release' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect((await reload(lead.id)).assignedToId).toBe(rep.user.id);
    // A manager may.
    const mgr = await as('MANAGER');
    const ok = await req('POST', '/api/leads/bulk', mgr.cookie, { ids: [lead.id], action: 'assign', toUserId: null, note: 'Release' });
    expect(ok.json()).toEqual({ updated: 1 });
    expect((await reload(lead.id)).assignedToId).toBeNull();
  });

  it('refuses a follow-up on a closed lead', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id, status: 'Won' });
    const tomorrow = shift(todayIn(rep.user.timezone), 1);
    const res = await req('PATCH', `/api/leads/${lead.id}`, rep.cookie, { nextFollowUp: tomorrow, updatedAt: stamp(lead) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'lead_closed' });
    expect(await prisma.task.count({ where: { leadId: lead.id } })).toBe(0);
    const clear = await req('PATCH', `/api/leads/${lead.id}`, rep.cookie, { nextFollowUp: null, notes: 'done', updatedAt: stamp(lead) });
    expect(clear.statusCode).toBe(200);
  });

  it('bulk assign locks rows', async () => {
    const mgr = await as('MANAGER');
    const [repA, repB] = [await makeUser(), await makeUser()];
    const lead = await makeLead();
    // A concurrent transaction holds the row and assigns it to repA while the bulk call is waiting.
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const racer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${lead.id} FOR UPDATE`;
      locked();
      await new Promise((r) => setTimeout(r, 200));
      await tx.lead.update({ where: { id: lead.id }, data: { assignedToId: repA.id } });
    });
    await isLocked;
    const bulk = req('POST', '/api/leads/bulk', mgr.cookie, { ids: [lead.id], action: 'assign', toUserId: repB.id });
    const [res] = await Promise.all([bulk, racer]);
    // The bulk call saw repA's assignment after the lock, so this is now a transfer needing a note.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'transfer_note_required' });
    expect(await prisma.leadAssignment.count({ where: { leadId: lead.id } })).toBe(0);

    const ok = await req('POST', '/api/leads/bulk', mgr.cookie, { ids: [lead.id, lead.id], action: 'assign', toUserId: repB.id, note: 'Rebalance' });
    expect(ok.json()).toEqual({ updated: 1 });
    expect(await prisma.leadAssignment.findFirstOrThrow({ where: { leadId: lead.id } }))
      .toMatchObject({ fromUserId: repA.id, toUserId: repB.id, note: 'Rebalance' });
    const archive = await req('POST', '/api/leads/bulk', mgr.cookie, { ids: [lead.id], action: 'archive' });
    expect(archive.json()).toEqual({ updated: 1 });
  });

  it('rejects a stale update', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const first = await req('PATCH', `/api/leads/${lead.id}`, rep.cookie, { notes: 'first', priority: 'High', updatedAt: stamp(lead) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ notes: 'first', priority: 'High' });
    const second = await req('PATCH', `/api/leads/${lead.id}`, rep.cookie, { notes: 'second', updatedAt: stamp(lead) });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'stale' });
    const call = await req('POST', `/api/leads/${lead.id}/log-call`, rep.cookie, { outcome: 'No answer', updatedAt: stamp(lead) });
    expect(call.statusCode).toBe(409);
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, activityType: 'call' } })).toBe(0);
  });

  it('sort whitelist 400', async () => {
    const mgr = await as('MANAGER');
    await makeLead({ companyName: 'Beta' });
    await makeLead({ companyName: 'Alpha' });
    expect((await req('GET', '/api/leads?sort=secret', mgr.cookie)).statusCode).toBe(400);
    const sorted = (await req('GET', '/api/leads?sort=companyName&dir=asc', mgr.cookie)).json();
    expect(sorted.items.map((i: { companyName: string }) => i.companyName)).toEqual(['Alpha', 'Beta']);
    expect((await req('GET', '/api/leads?sort=assignedTo&dir=desc', mgr.cookie)).statusCode).toBe(200);
    expect((await req('GET', '/api/leads?sort=contact', mgr.cookie)).statusCode).toBe(200);
  });

  it('check-duplicates redacts companies the user cannot see', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const hidden = await makeCompany({ name: 'Hidden Corp', website: 'https://hidden.example' });
    const res = await req('POST', '/api/leads/check-duplicates', rep.cookie, { website: 'https://hidden.example' });
    expect(res.statusCode).toBe(200);
    expect(res.json().auto).toEqual({ id: hidden.id, number: hidden.number, name: 'Hidden Corp' });
  });
  it('filters by companyId', async () => {
    const mgr = await as('MANAGER');
    const acme = await makeCompany({ name: 'Acme' });
    const a = await makeLead({ companyId: acme.id });
    const b = await makeLead({ companyId: acme.id });
    await makeLead();
    const list = (await req('GET', `/api/leads?companyId=${acme.id}`, mgr.cookie)).json();
    expect(list.total).toBe(2);
    expect(list.items.map((i: { id: number }) => i.id).sort()).toEqual([a.id, b.id].sort());
    expect((await req('GET', '/api/leads?companyId=abc', mgr.cookie)).statusCode).toBe(400);
  });

  it('company activities respect lead visibility', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await makeUser();
    const acme = await makeCompany({ name: 'Acme' });
    const mine = await makeLead({ companyId: acme.id, assignedToId: rep.user.id });
    const theirs = await makeLead({ companyId: acme.id, assignedToId: other.id });
    const elsewhere = await makeLead({ assignedToId: rep.user.id });
    const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 9, min));
    await prisma.leadActivity.create({ data: { leadId: mine.id, activityType: 'note', title: 'Older mine', occurredAt: at(1) } });
    await prisma.leadActivity.create({ data: { leadId: mine.id, activityType: 'call', title: 'Newer mine', occurredAt: at(2), byUserId: rep.user.id } });
    await prisma.leadActivity.create({ data: { leadId: theirs.id, activityType: 'note', title: 'Hidden', occurredAt: at(3) } });
    await prisma.leadActivity.create({ data: { leadId: elsewhere.id, activityType: 'note', title: 'Other company', occurredAt: at(4) } });

    const res = await req('GET', `/api/companies/${acme.id}/activities`, rep.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(['Newer mine', 'Older mine']);
    expect(body.items[0]).toMatchObject({ activityType: 'call', lead: { id: mine.id, number: mine.number }, by: { id: rep.user.id } });

    const paged = (await req('GET', `/api/companies/${acme.id}/activities?page=2&pageSize=1`, rep.cookie)).json();
    expect(paged.items.map((i: { title: string }) => i.title)).toEqual(['Older mine']);

    const mgr = await as('MANAGER');
    expect((await req('GET', `/api/companies/${acme.id}/activities`, mgr.cookie)).json().total).toBe(3);

    // A company the rep cannot see is a 404.
    const hidden = await makeCompany({ name: 'Hidden' });
    await makeLead({ companyId: hidden.id, assignedToId: other.id });
    expect((await req('GET', `/api/companies/${hidden.id}/activities`, rep.cookie)).statusCode).toBe(404);
    expect((await req('GET', `/api/companies/${acme.id}/activities`)).statusCode).toBe(401);
  });
  it('lead detail includes contact profile', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const co = await makeCompany({ createdById: rep.user.id });
    const c = await makeContact({ companyId: co.id, firstName: 'Asha', lastName: 'Rao', businessEmail: 'asha@acme.test' });
    await prisma.contact.update({
      where: { id: c.id },
      data: { headline: 'Head of Ops', location: 'Pune', about: 'Ops lead', skills: ['Lean'], languages: ['Hindi'] },
    });
    const lead = await makeLead({ companyId: co.id, contactId: c.id, assignedToId: rep.user.id });
    const res = await req('GET', `/api/leads/${lead.id}`, rep.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().contact).toMatchObject({
      id: c.id, name: 'Asha Rao', email: 'asha@acme.test', businessEmail: 'asha@acme.test', company: { id: co.id },
      headline: 'Head of Ops', location: 'Pune', about: 'Ops lead', experience: [], education: [], skills: ['Lean'], languages: ['Hindi'],
    });
  });

  it('lead detail carries the company card fields, call count and last contact', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const co = await makeCompany({ createdById: rep.user.id });
    await prisma.company.update({
      where: { id: co.id },
      data: { legalName: 'Acme Private Limited', website: 'https://acme-card.test', businessCategory: '3PL', timezone: 'Asia/Kolkata' },
    });
    const lead = await makeLead({ companyId: co.id, assignedToId: rep.user.id });
    const empty = (await req('GET', `/api/leads/${lead.id}`, rep.cookie)).json();
    expect(empty).toMatchObject({ callCount: 0, lastContact: null });
    expect(empty.company).toMatchObject({
      legalName: 'Acme Private Limited', website: 'https://acme-card.test', businessCategory: '3PL', timezone: 'Asia/Kolkata',
    });
    const at = new Date(Date.now() - 3_600_000);
    await prisma.leadActivity.createMany({
      data: [
        { leadId: lead.id, activityType: 'call', title: 'Call', occurredAt: new Date(Date.now() - 7_200_000) },
        { leadId: lead.id, activityType: 'meeting', title: 'Meeting', occurredAt: at },
        { leadId: lead.id, activityType: 'research', title: 'Research', occurredAt: new Date() },
      ],
    });
    const res = (await req('GET', `/api/leads/${lead.id}`, rep.cookie)).json();
    expect(res.callCount).toBe(1);
    expect(res.lastContact).toEqual({ type: 'meeting', at: at.toISOString() });
  });
  it('research note writes a research activity with url', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const res = await req('POST', `/api/leads/${lead.id}/research`, rep.cookie, {
      title: 'Annual report 2025', url: 'acme.test/ar-2025', body: 'Revenue up 12%', updatedAt: stamp(lead),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      leadId: lead.id, activityType: 'research', title: 'Annual report 2025', url: 'https://acme.test/ar-2025',
      body: 'Revenue up 12%', by: { id: rep.user.id },
    });
    const row = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'research' } });
    expect(row).toMatchObject({ url: 'https://acme.test/ar-2025', byUserId: rep.user.id });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(lead.id), action: 'update' } });
    expect(log.after).toMatchObject({ research: 'Annual report 2025' });
    // The lead was touched: the old stamp is stale now.
    const again = await req('POST', `/api/leads/${lead.id}/research`, rep.cookie, { title: 'Again', updatedAt: stamp(lead) });
    expect(again.statusCode).toBe(409);
    const bad = await req('POST', `/api/leads/${lead.id}/research`, rep.cookie, {
      title: 'X', url: 'javascript:alert(1)', updatedAt: stamp(await reload(lead.id)),
    });
    expect(bad.statusCode).toBe(400);
    const blank = await req('POST', `/api/leads/${lead.id}/research`, rep.cookie, { title: ' ', updatedAt: stamp(await reload(lead.id)) });
    expect(blank.statusCode).toBe(400);
    expect((await req('POST', `/api/leads/${lead.id}/research`, undefined, { title: 'X', updatedAt: stamp(lead) })).statusCode).toBe(401);
  });

  it('meeting note writes a meeting activity', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const res = await req('POST', `/api/leads/${lead.id}/meeting`, rep.cookie, {
      title: 'Intro call with CFO', occurredAt: '2026-11-20T10:30:00.000Z', body: 'Wants a quote', updatedAt: stamp(lead),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      leadId: lead.id, activityType: 'meeting', title: 'Intro call with CFO', body: 'Wants a quote',
      occurredAt: '2026-11-20T10:30:00.000Z', by: { id: rep.user.id },
    });
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', entityId: String(lead.id) } })).toBe(1);
    const missing = await req('POST', `/api/leads/${lead.id}/meeting`, rep.cookie, { title: 'No date', updatedAt: stamp(await reload(lead.id)) });
    expect(missing.statusCode).toBe(400);
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const hidden = await makeLead({ assignedToId: other.id });
    const denied = await req('POST', `/api/leads/${hidden.id}/meeting`, rep.cookie, {
      title: 'X', occurredAt: '2026-11-20T10:30:00.000Z', updatedAt: stamp(hidden),
    });
    expect(denied.statusCode).toBe(404);
  });
});
