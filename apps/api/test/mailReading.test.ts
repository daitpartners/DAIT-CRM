import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { dateOnly, todayIn } from '../src/leads/dates';
import { resetBodyFetchBackoff } from '../src/routes/mail';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Web-mail release 2, Task 8: the reading pane's conversation and the lead panel (GET /mail/:id). */

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({ graph: fakeGraph() });
});
afterAll(() => app.close());
beforeEach(async () => {
  resetBodyFetchBackoff();
  await resetDb();
  await seedLookups();
});

const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

const personal = (userId: number, address: string) =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' } });

let n = 0;
async function msg(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Proposal', bodyText: 'Looks good', graphId: `g-${n}`,
      threadId: `conv-${n}`, isRead: true, occurredAt: new Date('2026-11-20T10:00:00Z'),
      ...(data as object),
    },
  });
}

let qn = 0;
async function quotation(o: { companyId: number; leadId: number; ownerId: number; status: string; date: string; lines: [number, number][]; taxRate?: number; currency?: string }) {
  qn += 1;
  return prisma.quotation.create({
    data: {
      number: `Q-2026-${String(qn).padStart(3, '0')}`, companyId: o.companyId, leadId: o.leadId, ownerId: o.ownerId, quotationDate: new Date(`${o.date}T00:00:00Z`),
      currency: o.currency ?? 'USD', subject: 'Website', status: o.status, taxRate: o.taxRate ?? 0,
      lines: { create: o.lines.map(([qty, unitPrice], i) => ({ sortOrder: i, item: `Item ${i}`, qty, unit: 'each', unitPrice })) },
    },
  });
}

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const acme = await makeCompany({ name: 'Acme Logistics', website: 'https://acme.com', city: 'Chicago', country: 'United States' });
  const ana = await makeContact({ companyId: acme.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@acme.com', mobile: '+1 312 555 0100' });
  await prisma.contact.update({ where: { id: ana.id }, data: { designation: 'Head of Operations' } });
  const lead = await makeLead({
    companyId: acme.id, contactId: ana.id, assignedToId: rep.id, status: 'Contacted', city: 'Chicago', country: 'United States',
    businessEmail: 'ana@acme.com', phone: '+1 312 555 0199', nextFollowUp: new Date('2026-12-30T00:00:00Z'),
  });
  const repBox = await personal(rep.id, 'maya@daitpartners.com');
  const carlosBox = await personal(carlos.id, 'carlos@daitpartners.com');
  return { rep, carlos, admin, acme, ana, lead, repBox, carlosBox };
}

/** Maya's two-message conversation with Ana on the lead: her Proposal, Ana's reply (the one opened). */
async function conversation(f: Awaited<ReturnType<typeof setup>>) {
  const sent = await msg(f.rep.id, f.repBox.id, {
    threadId: 't', folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', fromName: 'Maya Pillai', toAddresses: ['ana@acme.com'],
    ccAddresses: ['ops@acme.com'], subject: 'Proposal', bodyText: 'Hi Ana,\n\n  here is   our proposal.', leadId: f.lead.id, companyId: f.acme.id, contactId: f.ana.id,
    occurredAt: new Date('2026-11-20T10:00:00Z'),
  });
  const reply = await msg(f.rep.id, f.repBox.id, {
    threadId: 't', subject: 'Re: Proposal', bodyText: 'Thanks, looks good. '.repeat(20), attachmentNames: ['po.pdf'], isRead: false,
    leadId: f.lead.id, companyId: f.acme.id, contactId: f.ana.id, occurredAt: new Date('2026-11-21T10:00:00Z'),
  });
  return { sent, reply };
}

/** The lead's activities, oldest first; the newest is an email logged from Carlos's mailbox. */
async function activities(f: Awaited<ReturnType<typeof setup>>) {
  const carlosMail = await msg(f.carlos.id, f.carlosBox.id, { folder: 'sent', status: 'sent', fromAddress: 'carlos@daitpartners.com', subject: 'Pricing follow-up', leadId: f.lead.id });
  const at = (h: number) => new Date(Date.UTC(2026, 10, 22, h));
  await prisma.leadActivity.create({ data: { leadId: f.lead.id, activityType: 'note', title: 'Oldest note', occurredAt: at(8) } });
  await prisma.leadActivity.create({ data: { leadId: f.lead.id, activityType: 'call', title: 'Call with Ana', occurredAt: at(9) } });
  await prisma.leadActivity.create({ data: { leadId: f.lead.id, activityType: 'note', title: 'Sent the deck', byUserId: f.rep.id, occurredAt: at(10) } });
  await prisma.leadActivity.create({
    data: {
      leadId: f.lead.id, activityType: 'email', title: 'Email sent: Pricing follow-up', body: 'Our prices', relatedType: 'email_message', relatedId: carlosMail.id,
      byUserId: f.carlos.id, occurredAt: at(11),
    },
  });
}

describe('GET /mail/:id — conversation and lead panel', () => {
  it('thread items carry who, to, cc, preview, attachments, folder and read state, newest first', async () => {
    const f = await setup();
    const { sent, reply } = await conversation(f);
    const body = (await get(`/api/mail/${reply.id}`, await signIn(app, f.rep))).json();
    expect(body.thread.map((t: { subject: string }) => t.subject)).toEqual(['Re: Proposal', 'Proposal']);
    expect(body.thread[1]).toMatchObject({
      id: sent.id, fromAddress: 'maya@daitpartners.com', fromName: 'Maya Pillai', toAddresses: ['ana@acme.com'], ccAddresses: ['ops@acme.com'],
      preview: 'Hi Ana, here is our proposal.', hasAttachments: false, folder: 'sent', isRead: true,
    });
    // The open message is read on opening; its preview is cut at 120 characters, like the list's.
    expect(body.thread[0]).toMatchObject({ id: reply.id, fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz', hasAttachments: true, folder: 'inbox', isRead: true });
    expect(body.thread[0].preview).toHaveLength(120);
    // The head's count and replied state (F6): two messages, and Ana's reply is not answered yet.
    expect(body).toMatchObject({ conversationCount: 2, replied: false, leadStatus: 'Contacted' });
  });

  it('lead panel: company, contact, owner, follow-up from the open task with its time, due when today, last activity, value, recent three, link reason', async () => {
    const f = await setup();
    const { reply } = await conversation(f);
    await activities(f);
    const today = todayIn(f.rep.timezone);
    await prisma.task.create({ data: { leadId: f.lead.id, title: 'Follow up', dueDate: dateOnly(today), dueTime: '16:00', assignedToId: f.rep.id, origin: 'follow_up' } });
    // A done follow-up and a manual task do not count.
    await prisma.task.create({ data: { leadId: f.lead.id, title: 'Old', dueDate: dateOnly('2026-11-01'), assignedToId: f.rep.id, origin: 'follow_up', isDone: true } });
    // Value: the newest quotation that is not a Draft (2 × 24,000); the newer Draft and the older Sent one do not count.
    await quotation({ companyId: f.acme.id, leadId: f.lead.id, ownerId: f.rep.id, status: 'Sent', date: '2026-10-01', lines: [[1, 10000]] });
    await quotation({ companyId: f.acme.id, leadId: f.lead.id, ownerId: f.rep.id, status: 'Negotiating', date: '2026-11-10', lines: [[2, 20000], [1, 8000]] });
    await quotation({ companyId: f.acme.id, leadId: f.lead.id, ownerId: f.rep.id, status: 'Draft', date: '2026-11-20', lines: [[1, 99000]] });
    const body = (await get(`/api/mail/${reply.id}`, await signIn(app, f.rep))).json();
    expect(body.leadPanel).toMatchObject({
      company: { id: f.acme.id, name: 'Acme Logistics', site: 'acme.com', place: 'Chicago, United States' },
      contact: { name: 'Ana Ruiz', role: 'Head of Operations', email: 'ana@acme.com', phone: '+1 312 555 0100' },
      owner: 'Maya Pillai', followUp: { date: today, time: '16:00', due: true }, value: { amount: 48000, currency: 'USD' },
      lastActivity: { title: 'Email sent', occurredAt: '2026-11-22T11:00:00.000Z' },
      linkReason: { kind: 'address', value: 'ana@acme.com' },
    });
    expect(body.leadPanel.recent).toHaveLength(3);
    // Maya reads Carlos's logged email as "Email sent", no subject or body (release 1 timeline privacy).
    expect(body.leadPanel.recent.map((a: { title: string }) => a.title)).toEqual(['Email sent', 'Sent the deck', 'Call with Ana']);
    expect(body.leadPanel.recent[0]).toMatchObject({ body: null, by: { id: f.carlos.id, name: 'Carlos Mendez' } });
  });

  it("follow-up falls back to the lead's date (no time, not due when later); no value without a sent quotation; phone falls back; domain link reason", async () => {
    const f = await setup();
    await prisma.contact.update({ where: { id: f.ana.id }, data: { mobile: null, mobileNormalised: null } });
    await quotation({ companyId: f.acme.id, leadId: f.lead.id, ownerId: f.rep.id, status: 'Draft', date: '2026-11-20', lines: [[1, 99000]] });
    const m = await msg(f.rep.id, f.repBox.id, { fromAddress: 'Bo@Acme.com', fromName: 'Bo', leadId: f.lead.id, companyId: f.acme.id, contactId: f.ana.id });
    const panel = (await get(`/api/mail/${m.id}`, await signIn(app, f.rep))).json().leadPanel;
    expect(panel).toMatchObject({
      contact: { phone: '+1 312 555 0199' }, followUp: { date: '2026-12-30', time: null, due: false }, value: null, lastActivity: null, recent: [],
      linkReason: { kind: 'domain', value: 'acme.com' },
    });
    // No participant on the lead's addresses or its company domain: no reason.
    const other = await msg(f.rep.id, f.repBox.id, { fromAddress: 'someone@gmail.com', leadId: f.lead.id });
    expect((await get(`/api/mail/${other.id}`, await signIn(app, f.rep))).json().leadPanel.linkReason).toBeNull();
  });

  it('a message with no lead has no lead panel', async () => {
    const f = await setup();
    const m = await msg(f.rep.id, f.repBox.id, { fromAddress: 'mum@gmail.com' });
    expect((await get(`/api/mail/${m.id}`, await signIn(app, f.rep))).json()).toMatchObject({ leadPanel: null, restrictedLead: null });
  });

  it("a Sales rep's message on another owner's lead has no lead panel (restrictedLead only)", async () => {
    const f = await setup();
    await activities(f);
    const m = await msg(f.carlos.id, f.carlosBox.id, { threadId: 'c', leadId: f.lead.id, companyId: f.acme.id, contactId: f.ana.id, toAddresses: ['carlos@daitpartners.com'] });
    const body = (await get(`/api/mail/${m.id}`, await signIn(app, f.carlos))).json();
    expect(body.leadPanel).toBeNull();
    expect(body.restrictedLead).toEqual({ number: f.lead.number, companyName: 'Acme Logistics' });
    expect(body).toMatchObject({ leadId: null, companyId: null, leadStatus: null, lead: null, contact: null, company: null });
    // Nothing of the hidden lead leaks through the answer: no owner, follow-up, phone or activity.
    const text = JSON.stringify(body);
    for (const secret of ['Maya Pillai', '2026-12-30', '555 0199', 'Sent the deck', 'Head of Operations']) expect(text).not.toContain(secret);
  });

  it("team view: the lead panel's recent email lines show subjects (Administrator), and opening stays audited without content", async () => {
    const f = await setup();
    const { reply } = await conversation(f);
    await activities(f);
    const res = await get(`/api/mail/${reply.id}`, await signIn(app, f.admin));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ viewOnly: true, owner: { id: f.rep.id, name: 'Maya Pillai' }, leadPanel: { owner: 'Maya Pillai', company: { name: 'Acme Logistics' } } });
    expect(body.leadPanel.recent[0]).toMatchObject({ title: 'Email sent: Pricing follow-up', body: 'Our prices' });
    // Team view stays view only: Maya's unread reply is not marked read.
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: reply.id } })).isRead).toBe(false);
    const audits = await prisma.auditLog.findMany({ where: { action: 'view', entityType: 'email_message' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: String(reply.id), userId: f.admin.id, after: { ownerId: f.rep.id } });
    const logged = JSON.stringify(audits[0]);
    for (const content of ['Proposal', 'ana@acme.com', 'looks good', 'Acme']) expect(logged).not.toContain(content);
  });
});
