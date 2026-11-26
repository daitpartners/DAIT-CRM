import type { FastifyInstance } from 'fastify';
import type { Lead, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roleLabel, type LeadDeletePreview } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { encrypt } from '../src/crypto/tokens';
import type { AuthUser } from '../src/plugins/auth';
import { deleteLeads } from '../src/leads/delete';
import { checkRecipients, sendBlock } from '../src/mailer/rules';
import { importCommitHandler } from '../src/jobs/handlers/importCommit';
import { runOnce } from '../src/jobs/runner';
import { makeCompany, makeContact, makeLead, makeProject, makeUser, signIn } from './factory';
import { fakeGraph, resetDb, seedLookups } from './helpers';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());

let admin: User;
let manager: User;
let rep: User;
let cookie: string;
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Admin' });
  manager = await makeUser({ role: 'MANAGER', name: 'Mona Manager' });
  rep = await makeUser({ name: 'Ravi Rep' });
  cookie = await signIn(app, admin);
});

const authOf = (u: User): AuthUser => ({
  id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat,
});
const preview = (ids: number[], c = cookie) => app.inject({ method: 'POST', url: '/api/leads/delete/preview', headers: { cookie: c }, payload: { ids } });
const confirm = (ids: number[], plan: LeadDeletePreview['plan'], c = cookie, word = 'delete') =>
  app.inject({ method: 'POST', url: '/api/leads/delete', headers: { cookie: c }, payload: { ids, plan, confirm: word } });
async function planOf(ids: number[]): Promise<LeadDeletePreview> {
  const res = await preview(ids);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as LeadDeletePreview;
}
/** Preview then confirm, as the dialog does. */
async function del(ids: number[]): Promise<LeadDeletePreview> {
  const p = await planOf(ids);
  const res = await confirm(ids, p.plan);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as LeadDeletePreview;
}
const exists = {
  lead: async (id: number) => (await prisma.lead.count({ where: { id } })) > 0,
  company: async (id: number) => (await prisma.company.count({ where: { id } })) > 0,
  contact: async (id: number) => (await prisma.contact.count({ where: { id } })) > 0,
};
let qn = 0;
const quotation = (o: { companyId: number; leadId?: number | null; contactId?: number | null; status?: string }) => {
  qn += 1;
  return prisma.quotation.create({
    data: {
      number: `Q-2026-${String(qn).padStart(3, '0')}`, companyId: o.companyId, leadId: o.leadId ?? null, contactId: o.contactId ?? null,
      ownerId: admin.id, quotationDate: new Date('2026-11-24'), currency: 'INR', subject: 'Website', status: o.status ?? 'Draft',
    },
  });
};
/** A lead with its own company and contact (the contact linked to the lead). */
async function leadWithContact(o: { name?: string; archived?: boolean } = {}) {
  const company = await makeCompany({ name: o.name ?? 'Acme Dyes' });
  const contact = await makeContact({ companyId: company.id, firstName: 'Ana', lastName: 'Secretname', businessEmail: 'ana@acme.test' });
  const lead = await makeLead({
    companyId: company.id, contactId: contact.id, companyName: company.name, assignedToId: rep.id, notes: 'Private note text',
    archivedAt: o.archived ? new Date() : null,
  });
  return { company, contact, lead };
}

describe('delete leads: permissions and limits', () => {
  it('Managers and Sales Reps get 403 on preview and confirm; nothing is removed', async () => {
    const { lead } = await leadWithContact();
    for (const u of [manager, rep]) {
      const c = await signIn(app, u);
      expect((await preview([lead.id], c)).statusCode).toBe(403);
      expect((await confirm([lead.id], { leads: [lead.id], companies: [], contacts: [], quotations: [] }, c)).statusCode).toBe(403);
    }
    expect(await exists.lead(lead.id)).toBe(true);
  });

  it('refuses more than 500 leads at once and a confirm without the word "delete"', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    expect((await preview(ids)).statusCode).toBe(400);
    expect((await preview(ids.slice(0, 500))).statusCode).toBe(200);
    const { lead } = await leadWithContact();
    const p = await planOf([lead.id]);
    expect((await confirm([lead.id], p.plan, cookie, 'Delete')).statusCode).toBe(400);
    expect((await confirm([lead.id], p.plan, cookie, '')).statusCode).toBe(400);
    expect(await exists.lead(lead.id)).toBe(true);
  });
});

describe('delete leads: what goes and what stays', () => {
  it('removes the lead with its company, contacts, locations, research, tasks, notes and timeline when nothing else uses them', async () => {
    const { company, contact, lead } = await leadWithContact();
    const other = await makeContact({ companyId: company.id, firstName: 'Bo', lastName: 'Extra' });
    await prisma.companyLocation.create({ data: { companyId: company.id, name: 'HQ', locationType: 'Head office', country: 'India' } });
    const run = await prisma.enrichmentRun.create({ data: { companyId: company.id, leadId: lead.id, trigger: 'Manual', engine: 'Website reader', status: 'Completed' } });
    await prisma.enrichmentSuggestion.create({
      data: { runId: run.id, companyId: company.id, field: 'industry', label: 'Industry', value: 'Dyes', confidence: 80, sourceUrl: 'https://x.test', sourceLabel: 'x' },
    });
    await prisma.sourceRecord.create({ data: { companyId: company.id, leadId: lead.id, title: 'Site', sourceType: 'website', collectedBy: 'Enrichment worker' } });
    await prisma.leadActivity.create({ data: { leadId: lead.id, activityType: 'note', title: 'Note', body: 'Secret body', byUserId: rep.id } });
    await prisma.leadAssignment.create({ data: { leadId: lead.id, toUserId: rep.id } });
    await prisma.task.create({ data: { leadId: lead.id, title: 'Call back', dueDate: new Date('2026-11-30'), assignedToId: rep.id, origin: 'manual', kind: 'call', dueTime: '10:00' } });
    await prisma.notification.create({ data: { userId: rep.id, text: 'Lead assigned', link: `/leads/${lead.id}` } });
    await prisma.notification.create({ data: { userId: rep.id, text: 'Research done', link: `/companies/${company.id}#ai` } });
    const keepNote = await prisma.notification.create({ data: { userId: rep.id, text: 'Other', link: `/leads/${lead.id}0` } });

    const p = await planOf([lead.id]);
    expect(p.remove.leads).toEqual([{ id: lead.id, number: lead.number, companyName: 'Acme Dyes' }]);
    expect(p.remove.companies).toEqual([{ id: company.id, number: company.number, name: 'Acme Dyes' }]);
    expect(p.remove.contacts).toEqual([{ id: contact.id, name: 'Ana Secretname' }, { id: other.id, name: 'Bo Extra' }]);
    expect(p.remove.tasks).toBe(1);
    expect(p.keep).toEqual([]);
    expect(p.notFound).toBe(0);
    expect(p.plan).toEqual({ leads: [lead.id], companies: [company.id], contacts: [contact.id, other.id], quotations: [] });
    // The preview changes nothing.
    expect(await exists.lead(lead.id)).toBe(true);

    const done = await del([lead.id]);
    expect(done.remove.leads.map((l) => l.id)).toEqual([lead.id]);
    expect(await exists.lead(lead.id)).toBe(false);
    expect(await exists.company(company.id)).toBe(false);
    expect(await exists.contact(contact.id)).toBe(false);
    expect(await exists.contact(other.id)).toBe(false);
    expect(await prisma.companyLocation.count()).toBe(0);
    expect(await prisma.enrichmentRun.count()).toBe(0);
    expect(await prisma.enrichmentSuggestion.count()).toBe(0);
    expect(await prisma.sourceRecord.count()).toBe(0);
    expect(await prisma.leadActivity.count()).toBe(0);
    expect(await prisma.leadAssignment.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
    expect((await prisma.notification.findMany()).map((n) => n.id)).toEqual([keepNote.id]);
  });

  it('keeps a company that has another lead (archived included) with ALL its contacts, the lead’s own contact included', async () => {
    const { company, contact, lead } = await leadWithContact();
    const otherContact = await makeContact({ companyId: company.id });
    const sibling = await makeLead({ companyId: company.id, contactId: otherContact.id, archivedAt: new Date() });
    const run = await prisma.enrichmentRun.create({ data: { companyId: company.id, leadId: lead.id, trigger: 'New lead', engine: 'Website reader' } });

    const p = await planOf([lead.id]);
    expect(p.remove.companies).toEqual([]);
    expect(p.keep).toEqual([{ kind: 'company', id: company.id, label: `${company.number} · Acme Dyes`, reason: 'other_leads' }]);
    expect(p.plan.contacts).toEqual([]);
    expect(p.remove.contacts).toEqual([]);

    await del([lead.id]);
    expect(await exists.lead(lead.id)).toBe(false);
    expect(await exists.company(company.id)).toBe(true);
    expect(await exists.contact(contact.id)).toBe(true);
    expect(await exists.contact(otherContact.id)).toBe(true);
    expect(await exists.lead(sibling.id)).toBe(true);
    // Research on a company kept stays; only its lead link is cleared.
    expect(await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ companyId: company.id, leadId: null });
  });

  it('keeps a contact another lead uses (and so its company)', async () => {
    const { company, contact, lead } = await leadWithContact();
    const elsewhere = await makeCompany({ name: 'Other Co' });
    const other = await makeLead({ companyId: elsewhere.id, contactId: contact.id });

    const p = await planOf([lead.id]);
    expect(p.keep).toEqual(expect.arrayContaining([
      { kind: 'contact', id: contact.id, label: 'Ana Secretname', reason: 'other_leads' },
      { kind: 'company', id: company.id, label: `${company.number} · Acme Dyes`, reason: 'contact_in_use' },
    ]));
    await del([lead.id]);
    expect(await exists.lead(lead.id)).toBe(false);
    expect(await exists.contact(contact.id)).toBe(true);
    expect(await exists.company(company.id)).toBe(true);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ contactId: contact.id });
  });

  it('deleting every lead of a shared company together removes the company', async () => {
    const { company, lead } = await leadWithContact();
    const second = await makeLead({ companyId: company.id });
    const p = await del([second.id, lead.id]);
    expect(p.remove.leads.map((l) => l.id)).toEqual([lead.id, second.id]);
    expect(p.remove.companies.map((c) => c.id)).toEqual([company.id]);
    expect(await exists.company(company.id)).toBe(false);
  });

  it('deletes archived leads, and leads with no company', async () => {
    const { company, lead } = await leadWithContact({ archived: true });
    const loose = await makeLead({ companyId: null });
    await del([lead.id, loose.id]);
    expect(await exists.lead(lead.id)).toBe(false);
    expect(await exists.lead(loose.id)).toBe(false);
    expect(await exists.company(company.id)).toBe(false);
  });

  it('emails and calendar events are unlinked, never deleted, and stay in their owner’s mailbox and calendar', async () => {
    const { company, contact, lead } = await leadWithContact();
    const box = await prisma.emailAccount.create({
      data: { userId: rep.id, address: rep.email, provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'), status: 'connected', syncCalendar: true },
    });
    const mail = await prisma.emailMessage.create({
      data: {
        userId: rep.id, accountId: box.id, leadId: lead.id, contactId: contact.id, companyId: company.id, folder: 'inbox', status: 'received',
        source: 'sync', fromAddress: 'ana@acme.test', subject: 'Proposal', graphId: 'g-1',
      },
    });
    const byContact = await prisma.emailMessage.create({
      data: { userId: rep.id, accountId: box.id, contactId: contact.id, folder: 'sent', status: 'sent', fromAddress: rep.email, subject: 'Hello' },
    });
    const event = await prisma.calendarEvent.create({
      data: {
        userId: rep.id, accountId: box.id, graphId: 'e-1', subject: 'Intro call', startsAt: new Date('2026-12-01T10:00:00Z'),
        endsAt: new Date('2026-12-01T11:00:00Z'), leadId: lead.id, companyId: company.id,
      },
    });

    const p = await planOf([lead.id]);
    expect(p.keep).toEqual([]);
    await del([lead.id]);
    expect(await exists.company(company.id)).toBe(false);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: mail.id } })).toMatchObject({ userId: rep.id, leadId: null, contactId: null, companyId: null });
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: byContact.id } })).toMatchObject({ contactId: null });
    expect(await prisma.calendarEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ userId: rep.id, leadId: null, companyId: null });
    // Still in the owner's mailbox list, and nobody else's.
    const repCookie = await signIn(app, rep);
    const inbox = (await app.inject({ method: 'GET', url: '/api/mail?view=inbox', headers: { cookie: repCookie } })).json();
    expect(inbox.items.map((i: { id: number; leadId: number | null }) => [i.id, i.leadId])).toEqual([[mail.id, null]]);
    const adminInbox = (await app.inject({ method: 'GET', url: '/api/mail?view=inbox', headers: { cookie } })).json();
    expect(adminInbox.items).toEqual([]);
  });

  it('draft quotations go with the lead; a sent one blocks it (archive instead)', async () => {
    const a = await leadWithContact({ name: 'Draft Co' });
    const draft = await quotation({ companyId: a.company.id, leadId: a.lead.id, contactId: a.contact.id });
    await prisma.quotationLine.create({ data: { quotationId: draft.id, sortOrder: 1, item: 'Site', qty: 1, unit: 'job', unitPrice: 100 } });
    const draftTask = await prisma.task.create({
      data: { quotationId: draft.id, title: 'Chase quote', dueDate: new Date('2026-11-30'), assignedToId: rep.id, origin: 'quotation' },
    });
    const b = await leadWithContact({ name: 'Sent Co' });
    const sent = await quotation({ companyId: b.company.id, leadId: b.lead.id, status: 'Sent' });

    const p = await planOf([a.lead.id, b.lead.id]);
    expect(p.remove.leads.map((l) => l.id)).toEqual([a.lead.id]);
    expect(p.remove.draftQuotations).toBe(1);
    expect(p.remove.companies.map((c) => c.id)).toEqual([a.company.id]);
    expect(p.keep).toEqual([{ kind: 'lead', id: b.lead.id, label: `${b.lead.number} · Sent Co`, reason: 'quotations' }]);

    expect(p.plan.quotations).toEqual([draft.id]);
    await prisma.notification.create({ data: { userId: rep.id, text: 'Quote', link: `/quotations/${draft.id}` } });

    await del([a.lead.id, b.lead.id]);
    expect(await prisma.notification.count()).toBe(0);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'delete', entityType: 'lead', entityId: String(a.lead.id) } });
    expect(entry.after).toMatchObject({ removed: { draftQuotations: 1, quotationNumbers: [draft.number] } });
    expect(await prisma.quotation.count({ where: { id: draft.id } })).toBe(0);
    expect(await prisma.quotationLine.count()).toBe(0);
    expect(await prisma.task.count({ where: { id: draftTask.id } })).toBe(0);
    expect(await exists.company(a.company.id)).toBe(false);
    expect(await exists.lead(b.lead.id)).toBe(true);
    expect(await prisma.quotation.count({ where: { id: sent.id } })).toBe(1);
  });

  it('a project blocks the lead; a company with a project or a quotation of its own stays', async () => {
    const a = await leadWithContact({ name: 'Project Co' });
    await makeProject({ companyId: a.company.id, managerId: admin.id, leadId: a.lead.id });
    const b = await leadWithContact({ name: 'Client Co' });
    await makeProject({ companyId: b.company.id, managerId: admin.id });
    const c = await leadWithContact({ name: 'Quoted Co' });
    await quotation({ companyId: c.company.id, status: 'Accepted' });

    const p = await planOf([a.lead.id, b.lead.id, c.lead.id]);
    expect(p.remove.leads.map((l) => l.id)).toEqual([b.lead.id, c.lead.id]);
    expect(p.keep).toEqual(expect.arrayContaining([
      { kind: 'lead', id: a.lead.id, label: `${a.lead.number} · Project Co`, reason: 'projects' },
      { kind: 'company', id: b.company.id, label: `${b.company.number} · Client Co`, reason: 'projects' },
      { kind: 'company', id: c.company.id, label: `${c.company.number} · Quoted Co`, reason: 'quotations' },
    ]));
    await del([a.lead.id, b.lead.id, c.lead.id]);
    expect(await exists.lead(a.lead.id)).toBe(true);
    expect(await exists.lead(b.lead.id)).toBe(false);
    expect(await exists.company(b.company.id)).toBe(true);
    expect(await exists.company(c.company.id)).toBe(true);
  });

  it('Mailer recipients and import rows keep their history with the lead link cleared', async () => {
    const { contact, lead } = await leadWithContact();
    const campaign = await prisma.emailCampaign.create({
      data: {
        name: 'Nov', templateName: 'T', subject: 'S', body: 'B', senderId: rep.id, senderAddress: rep.email, intervalMinutes: 5,
        lawfulBasis: 'Legitimate interest', status: 'Completed',
      },
    });
    const recipient = await prisma.emailCampaignRecipient.create({
      data: { campaignId: campaign.id, leadId: lead.id, contactId: contact.id, toAddress: 'ana@acme.test', timezoneSource: 'company', status: 'Sent', position: 1 },
    });
    const batch = await prisma.importBatch.create({ data: { number: 'IMPORT-2026-11-25', language: 'en', leadType: 'Lead', status: 'Imported' } });
    const file = await prisma.importFile.create({ data: { batchId: batch.id, name: 'a.xlsx', ext: 'xlsx', size: 1, storagePath: '' } });
    const row = await prisma.importRow.create({
      data: {
        batchId: batch.id, fileId: file.id, position: 1, originKind: 'row', originN: 2, status: 'Ready', include: true,
        leadId: lead.id, companyId: lead.companyId, contactId: contact.id, outcome: 'Imported',
      },
    });
    await del([lead.id]);
    expect(await prisma.emailCampaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } }))
      .toMatchObject({ leadId: null, contactId: null, status: 'Sent', toAddress: 'ana@acme.test' });
    expect(await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ leadId: null, companyId: null, contactId: null, outcome: 'Imported' });
  });
});

describe('delete leads: concurrency and audit', () => {
  it('re-plans on confirm: a lead added to the company since the preview keeps the company', async () => {
    const { company, contact, lead } = await leadWithContact();
    const p = await planOf([lead.id]);
    expect(p.plan.companies).toEqual([company.id]);
    await makeLead({ companyId: company.id });
    const res = await confirm([lead.id], p.plan);
    expect(res.statusCode, res.body).toBe(200);
    const done = res.json() as LeadDeletePreview;
    expect(done.remove.companies).toEqual([]);
    expect(done.keep).toEqual([{ kind: 'company', id: company.id, label: `${company.number} · Acme Dyes`, reason: 'other_leads' }]);
    expect(await exists.lead(lead.id)).toBe(false);
    expect(await exists.company(company.id)).toBe(true);
    expect(await exists.contact(contact.id)).toBe(true);
  });

  it('re-plans on confirm: a quotation sent since the preview blocks the lead', async () => {
    const { lead, company } = await leadWithContact();
    const p = await planOf([lead.id]);
    await quotation({ companyId: company.id, leadId: lead.id, status: 'Sent' });
    const done = (await confirm([lead.id], p.plan)).json() as LeadDeletePreview;
    expect(done.remove.leads).toEqual([]);
    expect(done.keep).toEqual(expect.arrayContaining([{ kind: 'lead', id: lead.id, label: `${lead.number} · Acme Dyes`, reason: 'quotations' }]));
    expect(await exists.lead(lead.id)).toBe(true);
    expect(await exists.company(company.id)).toBe(true);
  });

  it('never removes more than the preview showed: a contact added since keeps the company; a company freed since stays', async () => {
    const a = await leadWithContact({ name: 'Grown Co' });
    const p1 = await planOf([a.lead.id]);
    const newcomer = await makeContact({ companyId: a.company.id });
    const d1 = (await confirm([a.lead.id], p1.plan)).json() as LeadDeletePreview;
    expect(d1.keep).toEqual([{ kind: 'company', id: a.company.id, label: `${a.company.number} · Grown Co`, reason: 'changed' }]);
    expect(await exists.company(a.company.id)).toBe(true);
    expect(await exists.contact(newcomer.id)).toBe(true);
    expect(await exists.contact(a.contact.id)).toBe(true);

    const b = await leadWithContact({ name: 'Freed Co' });
    const sibling = await makeLead({ companyId: b.company.id });
    const p2 = await planOf([b.lead.id]);
    expect(p2.plan.companies).toEqual([]);
    await prisma.lead.delete({ where: { id: sibling.id } });
    await confirm([b.lead.id], p2.plan);
    expect(await exists.lead(b.lead.id)).toBe(false);
    expect(await exists.company(b.company.id)).toBe(true);
  });

  it('a lead edited in another transaction waits for it, then is planned again on what it wrote', async () => {
    const { company, lead } = await leadWithContact();
    const p = await planOf([lead.id]);
    const other = await makeCompany({ name: 'Moved To' });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    // Another user's edit holds the lead and moves it to another company while Delete waits.
    const edit = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${lead.id} FOR UPDATE`;
      locked();
      await held;
      await tx.lead.update({ where: { id: lead.id }, data: { companyId: other.id } });
    });
    await isLocked;
    const deleting = deleteLeads(authOf(admin), [lead.id], p.plan);
    await new Promise((r) => setTimeout(r, 200));
    release();
    await edit;
    const done = await deleting;
    expect(done.remove.leads.map((l) => l.id)).toEqual([lead.id]);
    // The company the preview offered is no longer the lead's: it is not touched, nor is the one it moved to.
    expect(await exists.company(company.id)).toBe(true);
    expect(await exists.company(other.id)).toBe(true);
    expect(await exists.lead(lead.id)).toBe(false);
  });

  it('writes one audit entry per deleted lead and company, with numbers and counts but no deleted content', async () => {
    const { company, lead } = await leadWithContact();
    await prisma.leadActivity.create({ data: { leadId: lead.id, activityType: 'note', title: 'Note', body: 'Secret body', byUserId: rep.id } });
    const kept: Lead = await makeLead({ companyId: null, companyName: 'Untouched' });
    await del([lead.id]);
    const entries = await prisma.auditLog.findMany({ where: { action: 'delete' }, orderBy: { id: 'asc' } });
    expect(entries.map((e) => [e.entityType, e.entityId, e.userId])).toEqual([
      ['lead', String(lead.id), admin.id], ['company', String(company.id), admin.id],
    ]);
    expect(entries[0]!.after).toMatchObject({ number: lead.number, companyName: 'Acme Dyes', removed: { activities: 1, tasks: 0, draftQuotations: 0, quotationNumbers: [] } });
    expect(entries[1]!.after).toMatchObject({ number: company.number, name: 'Acme Dyes', removed: { contacts: 1 } });
    const text = JSON.stringify(entries);
    for (const secret of ['Secretname', 'ana@acme.test', 'Private note text', 'Secret body']) expect(text).not.toContain(secret);
    expect(entries.every((e) => e.before === null)).toBe(true);
    expect(await exists.lead(kept.id)).toBe(true);
  });
});

describe('delete leads: review round (contacts, drafts, unknown ids, opt-outs)', () => {
  it('a Draft quotation made after the preview keeps its lead (changed)', async () => {
    const { company, lead } = await leadWithContact();
    const p = await planOf([lead.id]);
    expect(p.plan.quotations).toEqual([]);
    const late = await quotation({ companyId: company.id, leadId: lead.id });
    const done = (await confirm([lead.id], p.plan)).json() as LeadDeletePreview;
    expect(done.remove.leads).toEqual([]);
    expect(done.keep).toEqual(expect.arrayContaining([{ kind: 'lead', id: lead.id, label: `${lead.number} · Acme Dyes`, reason: 'changed' }]));
    expect(await prisma.quotation.count({ where: { id: late.id } })).toBe(1);
    expect(await exists.lead(lead.id)).toBe(true);
  });

  it('reports ids that are not in the CRM instead of dropping them silently', async () => {
    const { lead } = await leadWithContact();
    const p = await planOf([lead.id, lead.id, 999_999]);
    expect(p.notFound).toBe(1);
    expect(p.remove.leads.map((l) => l.id)).toEqual([lead.id]);
  });

  it('an unsubscribed contact deleted with its company is suppressed; a re-import is flagged; the Mailer skips it', async () => {
    const { company, contact, lead } = await leadWithContact();
    await prisma.contact.update({ where: { id: contact.id }, data: { unsubscribedAt: new Date(), businessEmail: 'Ana@Acme.test' } });
    const p = await del([lead.id]);
    expect(p.remove.companies.map((c) => c.id)).toEqual([company.id]);
    const rows = await prisma.emailSuppression.findMany();
    expect(rows.map((r) => ({ email: r.email, reason: r.reason, source: r.source, createdById: r.createdById })))
      .toEqual([{ email: 'ana@acme.test', reason: 'unsubscribed', source: 'lead_deleted', createdById: admin.id }]);

    // Re-imported: the new contact is unsubscribed and the new lead Do not email from the start.
    const batch = await prisma.importBatch.create({ data: { number: 'IMPORT-2026-11-26', language: 'en', leadType: 'Lead', status: 'Waiting for review', createdById: admin.id } });
    const file = await prisma.importFile.create({ data: { batchId: batch.id, name: 'Again.xlsx', ext: 'xlsx', size: 1, storagePath: '', status: 'Read' } });
    await prisma.importRow.create({
      data: {
        batchId: batch.id, fileId: file.id, position: 1, originKind: 'row', originN: 2, status: 'Ready', include: true,
        fields: { companyName: 'Acme Dyes Again', country: 'India', email: 'ana@acme.test', contactName: 'Ana Secretname' },
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/imports/batches/${batch.id}/import`, headers: { cookie },
      payload: { acceptHigh: false, noContactRows: 'import', notify: false },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await runOnce({ types: ['import_commit'], handlers: { import_commit: importCommitHandler }, graph: fakeGraph() })).toBe(true);
    const row = await prisma.importRow.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(row.leadId).not.toBeNull();
    const again = await prisma.lead.findUniqueOrThrow({ where: { id: row.leadId! }, include: { contact: true } });
    expect(again.doNotEmail).toBe(true);
    expect(again.contact?.unsubscribedAt).not.toBeNull();

    // Even with both flags cleared by hand behind the list's back, the Mailer still skips the address.
    await prisma.lead.update({ where: { id: again.id }, data: { doNotEmail: false } });
    await prisma.contact.update({ where: { id: again.contactId! }, data: { unsubscribedAt: null } });
    const [check] = await checkRecipients(prisma, authOf(admin), [again.id]);
    expect(check!.block).toBe('Unsubscribed');
    expect(await sendBlock(prisma, authOf(admin), again.id, new Date(0))).toBe('Unsubscribed');
  });

  it('a lead marked Do not email is suppressed when deleted (its addresses only); only an Administrator’s real untick lifts it', async () => {
    const { company, contact, lead } = await leadWithContact();
    await prisma.lead.update({ where: { id: lead.id }, data: { doNotEmail: true, businessEmail: 'info@acme.test' } });
    await makeLead({ companyId: company.id });
    await del([lead.id]);
    expect(await exists.contact(contact.id)).toBe(true);
    const rows = await prisma.emailSuppression.findMany({ orderBy: { email: 'asc' } });
    expect(rows.map((r) => [r.email, r.reason])).toEqual([['ana@acme.test', 'do_not_email'], ['info@acme.test', 'do_not_email']]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'createdById', 'email', 'id', 'reason', 'source']);

    const fresh = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: rep.id });
    const [check] = await checkRecipients(prisma, authOf(admin), [fresh.id]);
    expect(check!.block).toBe('Marked do not email');
    const untick = (c: string, updatedAt: Date) => app.inject({
      method: 'POST', url: `/api/leads/${fresh.id}/do-not-email`, headers: { cookie: c }, payload: { doNotEmail: false, updatedAt: updatedAt.toISOString() },
    });
    const repCookie = await signIn(app, rep);
    // Nothing to untick (Do not email already off): the list stays as it is.
    expect((await untick(repCookie, fresh.updatedAt)).statusCode).toBe(200);
    expect(await prisma.emailSuppression.count()).toBe(2);

    // A real untick of a listed address: a Sales Rep is refused, nothing changes.
    const marked = await prisma.lead.update({ where: { id: fresh.id }, data: { doNotEmail: true } });
    const refused = await untick(repCookie, marked.updatedAt);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'address_suppressed' });
    expect(await prisma.emailSuppression.count()).toBe(2);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: fresh.id } })).doNotEmail).toBe(true);

    // An Administrator lifts it: the flag and the list entry go, audited (a count) and on the timeline.
    const lifted = await untick(cookie, marked.updatedAt);
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect((await prisma.emailSuppression.findMany()).map((r) => r.email)).toEqual(['info@acme.test']);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(fresh.id), action: 'update' }, orderBy: { id: 'desc' } });
    expect(entry.after).toEqual({ doNotEmail: false, suppressionLifted: 1 });
    expect(JSON.stringify(entry)).not.toContain('ana@acme.test');
    expect(await prisma.leadActivity.count({ where: { leadId: fresh.id, title: 'Removed from the opt-out list' } })).toBe(1);
    expect((await checkRecipients(prisma, authOf(admin), [fresh.id]))[0]!.block).toBeNull();
  });

  it('a suppressed address is flagged wherever it reaches a contact or lead: new contact, contact edit, lead edit, Switch contact', async () => {
    await prisma.emailSuppression.create({ data: { email: 'gone@optout.test', reason: 'unsubscribed', source: 'lead_deleted' } });
    const { company, lead } = await leadWithContact();
    const post = (url: string, payload: object, method: 'POST' | 'PATCH' = 'POST') => app.inject({ method, url, headers: { cookie }, payload });

    // New contact on the company page.
    const created = await post('/api/contacts', { companyId: company.id, firstName: 'Gone', lastName: 'Away', businessEmail: 'Gone@OptOut.test' });
    expect(created.statusCode, created.body).toBe(201);
    const newId = (created.json() as { id: number }).id;
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: newId } })).unsubscribedAt).not.toBeNull();

    // Contact email edited to the address.
    const other = await makeContact({ companyId: company.id, businessEmail: 'fine@acme.test' });
    const edited = await post(`/api/contacts/${other.id}`, { businessEmail: 'gone@optout.test', updatedAt: other.updatedAt.toISOString() }, 'PATCH');
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: other.id } })).unsubscribedAt).not.toBeNull();

    // Lead email edited to the address.
    const loose = await makeLead({ companyId: null, assignedToId: admin.id });
    const leadEdit = await post(`/api/leads/${loose.id}`, { businessEmail: 'gone@optout.test', updatedAt: loose.updatedAt.toISOString() }, 'PATCH');
    expect(leadEdit.statusCode, leadEdit.body).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: loose.id } })).doNotEmail).toBe(true);

    // Switch contact to a contact holding the address.
    await prisma.contact.update({ where: { id: newId }, data: { unsubscribedAt: null } });
    const switched = await post(`/api/leads/${lead.id}/contact`, { contactId: newId, updatedAt: lead.updatedAt.toISOString() });
    expect(switched.statusCode, switched.body).toBe(200);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotEmail).toBe(true);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: newId } })).unsubscribedAt).not.toBeNull();
  });
});
