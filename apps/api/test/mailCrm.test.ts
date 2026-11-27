import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { ymd } from '../src/leads/dates';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Web-mail release 2, Task 10: Follow-up, Unlink and lead suggestions from the Email screen. */

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({ graph: fakeGraph() });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb();
  await seedLookups();
});

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const personal = (userId: number, address: string) =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' } });

let n = 0;
async function msg(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Proposal', bodyText: 'Looks good', graphId: `crm-${n}`,
      threadId: `crm-conv-${n}`, isRead: false, occurredAt: new Date('2026-11-20T10:00:00Z'),
      ...(data as object),
    },
  });
}

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const ana = await makeContact({ companyId: acme.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@acme.com' });
  const lead = await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: rep.id, status: 'New', companyName: 'Acme' });
  const repBox = await personal(rep.id, 'maya@daitpartners.com');
  const m = await msg(rep.id, repBox.id, { leadId: lead.id, companyId: acme.id, contactId: ana.id });
  return {
    rep, carlos, admin, acme, ana, lead, repBox, m,
    repCookie: await signIn(app, rep), carlosCookie: await signIn(app, carlos), adminCookie: await signIn(app, admin),
  };
}

const openFollowUps = (leadId: number) => prisma.task.findMany({ where: { leadId, origin: 'follow_up', isDone: false } });

describe('POST /mail/:id/follow-up', () => {
  it('Follow-up sets the lead date and the follow-up task time; Clear removes both', async () => {
    const { m, lead, rep, repCookie } = await setup();
    const res = await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-11-30', time: '09:00' });
    expect(res.statusCode).toBe(200);
    const task = await prisma.task.findFirstOrThrow({ where: { leadId: lead.id, origin: 'follow_up', isDone: false } });
    expect(res.json()).toEqual({ leadId: lead.id, nextFollowUp: '2026-11-30', taskId: task.id });
    expect(ymd((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp)).toBe('2026-11-30');
    expect(task).toMatchObject({ dueTime: '09:00', assignedToId: rep.id, title: 'Follow up · Acme' });
    expect(ymd(task.dueDate)).toBe('2026-11-30');

    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(lead.id) }, orderBy: { id: 'desc' } });
    expect(log).toMatchObject({ action: 'update', userId: rep.id, before: {}, after: { nextFollowUp: '2026-11-30T00:00:00.000Z', dueTime: '09:00', emailMessageId: m.id } });

    // A second call moves the same task (one open follow-up task per lead).
    await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-12-02', time: '14:30' });
    const moved = await openFollowUps(lead.id);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ id: task.id, dueTime: '14:30' });
    expect(ymd(moved[0]!.dueDate)).toBe('2026-12-02');

    const cleared = await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { clear: true });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ leadId: lead.id, nextFollowUp: null, taskId: null });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp).toBeNull();
    expect(await prisma.task.count({ where: { leadId: lead.id, origin: 'follow_up', isDone: false } })).toBe(0);
  });

  it('an unassigned lead takes the date with no task', async () => {
    const { m, lead, repCookie } = await setup();
    await prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: null } });
    const res = await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-11-30', time: '09:00' });
    expect(res.json()).toEqual({ leadId: lead.id, nextFollowUp: '2026-11-30', taskId: null });
    expect(await openFollowUps(lead.id)).toHaveLength(0);
  });

  it('Follow-up on a closed lead is 400 lead_closed (Clear still works); without manage_leads 403; an Administrator in team view may set it', async () => {
    const { m, lead, admin, adminCookie, repCookie } = await setup();
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'Lost' } });
    const closed = await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-11-30', time: '09:00' });
    expect(closed.statusCode).toBe(400);
    expect(closed.json()).toEqual({ error: 'lead_closed' });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp).toBeNull();
    expect((await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { clear: true })).statusCode).toBe(200);

    // Data Research users have no Email screen: 403 forbidden.
    const researcher = await makeUser({ role: 'DATA_RESEARCH_USER' });
    const denied = await call('POST', `/api/mail/${m.id}/follow-up`, await signIn(app, researcher), { date: '2026-11-30', time: '09:00' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'forbidden' });

    // Another user's lead mail, team view: the Administrator sets the follow-up on the lead (the assignee's task).
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'New' } });
    const team = await call('POST', `/api/mail/${m.id}/follow-up`, adminCookie, { date: '2026-12-01', time: '10:15' });
    expect(team.statusCode).toBe(200);
    const [task] = await openFollowUps(lead.id);
    expect(task).toMatchObject({ dueTime: '10:15', assignedToId: lead.assignedToId });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(lead.id) }, orderBy: { id: 'desc' } });
    expect(log.userId).toBe(admin.id);
  });

  it('an archived lead is refused (as editing it on the lead page)', async () => {
    const { m, lead, repCookie } = await setup();
    await prisma.lead.update({ where: { id: lead.id }, data: { archivedAt: new Date() } });
    const res = await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-11-30', time: '09:00' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'lead_archived' });
    expect(await openFollowUps(lead.id)).toHaveLength(0);
  });

  it('no lead, or a lead the viewer cannot see, is 409 no_lead; a bad body is 400; another rep\'s message is 404', async () => {
    const { m, lead, rep, repBox, carlos, carlosCookie, repCookie } = await setup();
    const unlinked = await msg(rep.id, repBox.id, { fromAddress: 'someone@other.com' });
    const none = await call('POST', `/api/mail/${unlinked.id}/follow-up`, repCookie, { date: '2026-11-30', time: '09:00' });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: 'no_lead' });

    // The message stays linked to a lead that has moved to Carlos: Maya can no longer see it.
    await prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: carlos.id } });
    const hidden = await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-11-30', time: '09:00' });
    expect(hidden.statusCode).toBe(409);
    expect(hidden.json()).toEqual({ error: 'no_lead' });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp).toBeNull();

    expect((await call('POST', `/api/mail/${m.id}/follow-up`, repCookie, { date: '2026-11-30', time: '24:00' })).statusCode).toBe(400);
    expect((await call('POST', `/api/mail/${m.id}/follow-up`, carlosCookie, { date: '2026-11-30', time: '09:00' })).statusCode).toBe(404);
  });
});

describe('POST /mail/:id/unlink', () => {
  it('Unlink clears the message links only; another user\'s message is 403 view_only', async () => {
    const { m, lead, rep, repBox, acme, ana, adminCookie, repCookie } = await setup();
    const sibling = await msg(rep.id, repBox.id, { leadId: lead.id, companyId: acme.id, contactId: ana.id, threadId: m.threadId });

    const team = await call('POST', `/api/mail/${m.id}/unlink`, adminCookie);
    expect(team.statusCode).toBe(403);
    expect(team.json()).toEqual({ error: 'view_only' });
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).leadId).toBe(lead.id);

    const res = await call('POST', `/api/mail/${m.id}/unlink`, repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: m.id, leadId: null });
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ leadId: null, contactId: null, companyId: null });
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({ leadId: lead.id, contactId: ana.id, companyId: acme.id });
    expect(await prisma.lead.count({ where: { id: lead.id } })).toBe(1);

    // Linking again later works as in release 1 (and clears lead_deleted_at).
    await prisma.emailMessage.update({ where: { id: m.id }, data: { leadDeletedAt: new Date() } });
    const relinked = await call('POST', `/api/mail/${m.id}/link`, repCookie, { leadId: lead.id });
    expect(relinked.statusCode).toBe(200);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ leadId: lead.id, leadDeletedAt: null });
  });
});

describe('GET /mail/:id/lead-suggestions', () => {
  it('suggestions: address matches first, then the company domain, visible leads only, never free mail, at most 5', async () => {
    const { rep, repBox, carlos, acme, ana, lead, adminCookie, repCookie } = await setup();
    // A lead whose own address is a participant (archived: still suggested, after open ones).
    const byAddress = await makeLead({ companyId: null, businessEmail: 'Bo@Beta.io ', assignedToId: rep.id, companyName: 'Beta direct' });
    // The contact's lead is `lead` (linked already, so excluded below). Another lead with Ana as contact, closed.
    const contactClosed = await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: null, status: 'Lost', companyName: 'Acme old' });
    // Leads of the company whose domain is a participant's domain.
    const domain1 = await makeLead({ companyId: acme.id, assignedToId: rep.id, companyName: 'Acme two' });
    const domain2 = await makeLead({ companyId: acme.id, assignedToId: null, companyName: 'Acme three' });
    const domainArchived = await makeLead({ companyId: acme.id, assignedToId: rep.id, companyName: 'Acme archived', archivedAt: new Date() });
    const domain3 = await makeLead({ companyId: acme.id, assignedToId: rep.id, companyName: 'Acme four' });
    // Hidden from Maya: Carlos's lead at the same company, and Carlos's lead at Ana's address.
    const hidden = await makeLead({ companyId: acme.id, assignedToId: carlos.id, companyName: 'Acme Carlos' });
    const hiddenAddress = await makeLead({ companyId: null, businessEmail: 'bo@beta.io', assignedToId: carlos.id, companyName: 'Beta Carlos' });
    // Free mail and our own domain never suggest: a company at gmail.com (should never exist, but) and at daitpartners.com.
    const gmailCo = await prisma.company.create({ data: { name: 'Gmail Co', nameNormalised: 'gmail co', domain: 'gmail.com', country: 'India' } });
    const gmailLead = await makeLead({ companyId: gmailCo.id, assignedToId: rep.id, companyName: 'Gmail lead' });
    const ownCo = await prisma.company.create({ data: { name: 'Own Co', nameNormalised: 'own co', domain: 'daitpartners.com', country: 'India' } });
    const ownLead = await makeLead({ companyId: ownCo.id, assignedToId: rep.id, companyName: 'Own lead' });

    // Stagger updatedAt so the order is deterministic: newer first within a group.
    const at = (id: number, iso: string) => prisma.lead.update({ where: { id }, data: { updatedAt: new Date(iso) } });
    await at(byAddress.id, '2026-11-01T00:00:00Z');
    await at(contactClosed.id, '2026-11-26T00:00:00Z');
    await at(domain1.id, '2026-11-10T00:00:00Z');
    await at(domain2.id, '2026-11-20T00:00:00Z');
    await at(domainArchived.id, '2026-11-25T00:00:00Z');
    await at(domain3.id, '2026-11-05T00:00:00Z');
    await prisma.lead.update({ where: { id: byAddress.id }, data: { archivedAt: new Date('2026-11-02T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z') } });

    const m = await msg(rep.id, repBox.id, {
      leadId: lead.id, fromAddress: 'ana@acme.com', toAddresses: ['maya@daitpartners.com', 'friend@gmail.com'], ccAddresses: ['bo@beta.io'],
    });
    const res = await call('GET', `/api/mail/${m.id}/lead-suggestions`, repCookie);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: number; number: string; companyName: string; status: string }[];
    // Address matches (contactClosed is closed, byAddress archived: both after an open one — none open here — newest first),
    // then the domain's leads: open first, newest first; at most 5.
    expect(items.map((i) => i.companyName)).toEqual(['Acme old', 'Beta direct', 'Acme three', 'Acme two', 'Acme four']);
    const ids = items.map((i) => i.id);
    for (const never of [lead.id, hidden.id, hiddenAddress.id, gmailLead.id, ownLead.id, domainArchived.id]) expect(ids).not.toContain(never);
    expect(items[0]).toEqual({ id: contactClosed.id, number: contactClosed.number, companyName: 'Acme old', status: 'Lost' });

    // A message with only free-mail participants suggests nothing.
    const free = await msg(rep.id, repBox.id, { fromAddress: 'friend@gmail.com' });
    expect((await call('GET', `/api/mail/${free.id}/lead-suggestions`, repCookie)).json()).toEqual({ items: [] });

    // Another user's mailbox: view only.
    const team = await call('GET', `/api/mail/${m.id}/lead-suggestions`, adminCookie);
    expect(team.statusCode).toBe(403);
    expect(team.json()).toEqual({ error: 'view_only' });
  });

  it('the archived domain lead appears once fewer than 5 open ones exist', async () => {
    const { rep, repBox, acme, repCookie } = await setup();
    const archived = await makeLead({ companyId: acme.id, assignedToId: rep.id, companyName: 'Acme archived', archivedAt: new Date() });
    const m = await msg(rep.id, repBox.id, { fromAddress: 'someone@acme.com' });
    const items = (await call('GET', `/api/mail/${m.id}/lead-suggestions`, repCookie)).json().items as { id: number }[];
    expect(items.map((i) => i.id)).toEqual([expect.any(Number), archived.id]);
  });
});
