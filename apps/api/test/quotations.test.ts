import type { FastifyInstance } from 'fastify';
import type { Company, Lead, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMPANY_SETTINGS_DEFAULTS, formatMoney } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { todayIn } from '../src/leads/dates';
import { quotationSnapshot } from '../src/quotations/service';
import { expireQuotations, resetQuotationExpiryClock, scheduleQuotationExpiry } from '../src/jobs/quotationExpiry';
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

const DAY_MS = 86_400_000;
const shift = (s: string, days: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const today = () => todayIn('Europe/London');

/** A company with a primary contact and a lead (with its own contact) assigned to `assigneeId`. */
async function setup(assigneeId: number | null, country = 'India'): Promise<{ company: Company; lead: Lead; leadContactId: number; primaryId: number }> {
  const company = await makeCompany({ country, name: `Acme ${country}` });
  const primary = await makeContact({ companyId: company.id, businessEmail: 'primary@acme.test' });
  await prisma.contact.update({ where: { id: primary.id }, data: { isPrimary: true } });
  const leadContact = await makeContact({ companyId: company.id, businessEmail: 'buyer@acme.test' });
  const lead = await makeLead({ companyId: company.id, contactId: leadContact.id, assignedToId: assigneeId, status: 'Qualified' });
  return { company, lead, leadContactId: leadContact.id, primaryId: primary.id };
}

type Detail = {
  id: number; number: string; status: string; revision: number; editingNewRevision: boolean; updatedAt: string;
  currency: string; taxRate: number; overallDiscount: number; notes: string; subject: string;
  quotationDate: string; validUntil: string | null; locked: boolean; sending: boolean; canEdit: boolean;
  contact: { id: number } | null; lead: { id: number } | null; company: { id: number };
  lines: { item: string; qty: number; unit: string; unitPrice: number; discount: number }[];
  totals: { total: number }; displayTotals: { total: number; currency: string };
  history: { at: string; text: string }[]; revisions: { revisionNo: number }[];
};

async function createQuote(cookie: string, body: object): Promise<Detail> {
  const res = await req('POST', '/api/quotations', cookie, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
const patch = (cookie: string, q: Pick<Detail, 'id' | 'updatedAt'>, body: object) =>
  req('PATCH', `/api/quotations/${q.id}`, cookie, { updatedAt: q.updatedAt, ...body });
const line = (item: string, qty: number, unitPrice: number, discount = 0) => ({ item, description: null, qty, unit: 'unit', unitPrice, discount });
const setStatus = (id: number, status: string, extra: object = {}) => prisma.quotation.update({ where: { id }, data: { status, ...extra } });

describe('quotations API', () => {
  it('401 when signed out', async () => {
    expect((await req('GET', '/api/quotations')).statusCode).toBe(401);
    expect((await req('POST', '/api/quotations', undefined, { companyId: 1 })).statusCode).toBe(401);
  });

  it('creates a Draft with the spec defaults (India: INR, 18 %, +30 days, one line, settings notes, lead contact)', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const { company, lead, leadContactId } = await setup(rep.user.id);
    const q = await createQuote(rep.cookie, { companyId: company.id, leadId: lead.id });
    const t = today();
    expect(q).toMatchObject({
      number: `Q-${t.slice(0, 4)}-001`, status: 'Draft', revision: 1, editingNewRevision: false,
      currency: 'INR', taxRate: 18, overallDiscount: 0, quotationDate: t, validUntil: shift(t, 30),
      subject: `Advisory services for ${company.name}`, notes: COMPANY_SETTINGS_DEFAULTS.defaultNotes,
      contact: { id: leadContactId }, lead: { id: lead.id }, company: { id: company.id },
      locked: false, sending: false, canEdit: true,
    });
    expect(q.lines).toEqual([expect.objectContaining({ item: 'Consulting services', qty: 1, unit: 'project', unitPrice: 0, discount: 0 })]);
    expect(q.history.map((h) => h.text)).toEqual([`Draft created by ${rep.user.name}`]);
    const acts = await prisma.leadActivity.findMany({ where: { leadId: lead.id, activityType: 'quote' } });
    expect(acts).toEqual([expect.objectContaining({ title: `Quotation drafted · ${q.number}`, body: q.subject, byUserId: rep.user.id })]);
  });

  it('takes tax and notes from Company details, currency from the country, contact = primary without a lead', async () => {
    const admin = await as('ADMINISTRATOR');
    await prisma.companySettings.create({
      data: { id: 1, legalName: 'DAIT Partners LLP', email: 'info@daitpartners.com', taxInr: 12, taxUsd: 5, taxCad: 7, defaultNotes: 'Custom terms' },
    });
    const ca = await setup(null, 'Canada');
    const us = await setup(null, 'United States');
    const caQ = await createQuote(admin.cookie, { companyId: ca.company.id });
    expect(caQ).toMatchObject({ currency: 'CAD', taxRate: 7, notes: 'Custom terms', contact: { id: ca.primaryId }, lead: null });
    const usQ = await createQuote(admin.cookie, { companyId: us.company.id });
    expect(usQ).toMatchObject({ currency: 'USD', taxRate: 5, number: `Q-${today().slice(0, 4)}-002` });
    const inQ = await createQuote(admin.cookie, { companyId: (await setup(null)).company.id });
    expect(inQ.taxRate).toBe(12);
  });

  it('refuses a lead of another company, a hidden company or lead, and users without quotation rights', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await as('SALES_REPRESENTATIVE');
    const research = await as('DATA_RESEARCH_USER');
    const a = await setup(rep.user.id);
    const b = await setup(rep.user.id);
    expect((await req('POST', '/api/quotations', rep.cookie, { companyId: a.company.id, leadId: b.lead.id })).statusCode).toBe(400);
    expect((await req('POST', '/api/quotations', rep.cookie, { companyId: a.company.id, contactId: b.primaryId })).statusCode).toBe(400);
    expect((await req('POST', '/api/quotations', other.cookie, { companyId: a.company.id, leadId: a.lead.id })).statusCode).toBe(404);
    expect((await req('POST', '/api/quotations', other.cookie, { companyId: a.company.id })).statusCode).toBe(404);
    expect((await req('POST', '/api/quotations', research.cookie, { companyId: a.company.id })).statusCode).toBe(403);
  });

  it('lists with tabs, counts, tiles and search', async () => {
    const admin = await as('ADMINISTRATOR');
    const india = await setup(null);
    const us = await setup(null, 'United States');
    const t = today();
    const mk = async (companyId: number, leadId: number | undefined, price: number) => {
      const q = await createQuote(admin.cookie, { companyId, leadId });
      const res = await patch(admin.cookie, q, { lines: [line('Work', 1, price)] });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Promise<Detail>;
    };
    const draft = await mk(india.company.id, india.lead.id, 1000);
    const sentInr = await mk(india.company.id, undefined, 100000);
    const negUsd = await mk(us.company.id, us.lead.id, 2000);
    const accUsd = await mk(us.company.id, undefined, 500);
    const rejected = await mk(india.company.id, undefined, 10);
    await setStatus(sentInr.id, 'Sent', { validUntil: new Date(`${shift(t, 3)}T00:00:00Z`) });
    await setStatus(negUsd.id, 'Negotiating', { subject: 'Website rebuild' });
    await setStatus(accUsd.id, 'Accepted');
    await setStatus(rejected.id, 'Rejected');

    const res = await req('GET', '/api/quotations', admin.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: number }) => i.id).sort()).toEqual([draft.id, sentInr.id, negUsd.id, accUsd.id, rejected.id].sort());
    expect(body.counts).toEqual({ all: 5, draft: 1, sent: 2, accepted: 1, closed: 1 });
    expect(body.tiles).toMatchObject({
      openCount: 2, acceptedCount: 1, sentCount: 4, winRate: 25,
      expiringSoon: [{ id: sentInr.id, number: sentInr.number, validUntil: shift(t, 3) }],
    });
    // 100000 + 18 % GST; 2000 at 0 %
    expect(body.tiles.openSums).toEqual(expect.arrayContaining([{ currency: 'INR', amount: 118000 }, { currency: 'USD', amount: 2000 }]));
    expect(body.tiles.acceptedSums).toEqual([{ currency: 'USD', amount: 500 }]);
    const sentRow = body.items.find((i: { id: number }) => i.id === sentInr.id);
    expect(sentRow).toMatchObject({ total: 118000, currency: 'INR', expiringSoon: true, company: { id: india.company.id } });

    const tab = async (q: string) => (await req('GET', `/api/quotations?${q}`, admin.cookie)).json().items.map((i: { id: number }) => i.id).sort();
    expect(await tab('tab=draft')).toEqual([draft.id]);
    expect(await tab('tab=sent')).toEqual([sentInr.id, negUsd.id].sort());
    expect(await tab('tab=accepted')).toEqual([accUsd.id]);
    expect(await tab('tab=closed')).toEqual([rejected.id]);
    expect(await tab(`s=${encodeURIComponent(draft.number)}`)).toEqual([draft.id]);
    expect(await tab('s=website%20REBUILD')).toEqual([negUsd.id]);
    expect(await tab(`s=${encodeURIComponent(us.lead.number)}`)).toEqual([negUsd.id]);
    expect(await tab('s=acme%20united')).toEqual([negUsd.id, accUsd.id].sort());
    expect((await req('GET', '/api/quotations?tab=nope', admin.cookie)).statusCode).toBe(400);
  });

  it('a rep cannot see a quotation on a lead hidden from them (404, not listed); without a lead the company decides', async () => {
    const repA = await as('SALES_REPRESENTATIVE');
    const repB = await as('SALES_REPRESENTATIVE');
    const a = await setup(repA.user.id);
    const onLead = await createQuote(repA.cookie, { companyId: a.company.id, leadId: a.lead.id });
    const own = await makeCompany({ createdById: repA.user.id });
    const noLead = await createQuote(repA.cookie, { companyId: own.id });
    for (const q of [onLead, noLead]) {
      expect((await req('GET', `/api/quotations/${q.id}`, repB.cookie)).statusCode).toBe(404);
      expect((await patch(repB.cookie, q, { subject: 'X' })).statusCode).toBe(404);
      expect((await req('POST', `/api/quotations/${q.id}/accept`, repB.cookie, {})).statusCode).toBe(404);
    }
    expect((await req('GET', '/api/quotations', repB.cookie)).json().items).toEqual([]);
    expect((await req('GET', '/api/quotations', repA.cookie)).json().items).toHaveLength(2);
    expect((await req('GET', `/api/quotations/${noLead.id}`, repA.cookie)).statusCode).toBe(200);
  });

  it('a rep who can see but does not own (unassigned lead) may not edit', async () => {
    const repA = await as('SALES_REPRESENTATIVE');
    const repB = await as('SALES_REPRESENTATIVE');
    const a = await setup(null);
    const q = await createQuote(repA.cookie, { companyId: a.company.id, leadId: a.lead.id });
    const seen = await req('GET', `/api/quotations/${q.id}`, repB.cookie);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().canEdit).toBe(false);
    expect((await patch(repB.cookie, q, { subject: 'X' })).statusCode).toBe(403);
    expect((await req('POST', `/api/quotations/${q.id}/reject`, repB.cookie, {})).statusCode).toBe(403);
  });

  it('PATCH edits header and lines, checks lead / contact belong to the company, resets tax on currency change, 409 when stale', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    const b = await setup(rep.user.id);
    const q = await createQuote(rep.cookie, { companyId: a.company.id, leadId: a.lead.id });
    const res = await patch(rep.cookie, q, {
      subject: 'Brand refresh', overallDiscount: 5, notes: 'N', validUntil: null, contactId: a.primaryId,
      lines: [line('Design', 2, 1000, 10), line('Build', 1, 500)],
    });
    expect(res.statusCode, res.body).toBe(200);
    const e = res.json() as Detail;
    expect(e).toMatchObject({ subject: 'Brand refresh', overallDiscount: 5, notes: 'N', validUntil: null, contact: { id: a.primaryId }, status: 'Draft', revision: 1 });
    expect(e.lines.map((l) => l.item)).toEqual(['Design', 'Build']);
    // (1800 + 500) × 0.95 = 2185, + 18 % = 2578.30
    expect(e.totals.total).toBe(2578.3);
    expect((await patch(rep.cookie, q, { subject: 'Again' })).json()).toEqual({ error: 'stale' });

    const usd = await patch(rep.cookie, e, { currency: 'USD' });
    expect(usd.json()).toMatchObject({ currency: 'USD', taxRate: 0 });
    const both = await patch(rep.cookie, usd.json(), { currency: 'INR', taxRate: 5 });
    expect(both.json()).toMatchObject({ currency: 'INR', taxRate: 5 });

    const cur = both.json() as Detail;
    expect((await patch(rep.cookie, cur, { leadId: b.lead.id })).statusCode).toBe(400);
    expect((await patch(rep.cookie, cur, { contactId: b.primaryId })).statusCode).toBe(400);
    const hidden = await makeLead({ companyId: a.company.id, assignedToId: (await makeUser()).id });
    expect((await patch(rep.cookie, cur, { leadId: hidden.id })).statusCode).toBe(400);
    const cleared = await patch(rep.cookie, cur, { leadId: null });
    expect(cleared.json().lead).toBeNull();
  });

  it('PATCH on a Sent quotation opens revision 2 once; display totals stay on the sent revision', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    let q = await createQuote(rep.cookie, { companyId: a.company.id, leadId: a.lead.id });
    q = (await patch(rep.cookie, q, { lines: [line('Design', 1, 1000)] })).json();
    await sendRevision1(q.id);
    q = (await req('GET', `/api/quotations/${q.id}`, rep.cookie)).json();

    // Not printed on the PDF: no new revision.
    const leadOnly = await patch(rep.cookie, q, { leadId: null });
    expect(leadOnly.json()).toMatchObject({ revision: 1, editingNewRevision: false });
    q = leadOnly.json();
    // Same values sent back: no new revision either.
    q = (await patch(rep.cookie, q, { subject: q.subject, lines: [line('Design', 1, 1000)] })).json();
    expect(q.revision).toBe(1);

    const first = await patch(rep.cookie, q, { lines: [line('Design', 1, 2000)] });
    expect(first.json()).toMatchObject({ status: 'Sent', revision: 2, editingNewRevision: true });
    expect(first.json().totals.total).toBe(2360);
    expect(first.json().displayTotals).toMatchObject({ total: 1180, currency: 'INR' });
    const second = await patch(rep.cookie, first.json(), { subject: 'Changed again' });
    expect(second.json()).toMatchObject({ revision: 2, editingNewRevision: true });
    const opened = (second.json() as Detail).history.filter((h) => h.text.startsWith('Revision'));
    expect(opened.map((h) => h.text)).toEqual(['Revision 2 opened for editing']);
    const list = (await req('GET', '/api/quotations', rep.cookie)).json();
    expect(list.items[0]).toMatchObject({ total: 1180, revision: 2 });
  });

  it('PATCH on an Accepted quotation → 409 locked', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    const q = await createQuote(rep.cookie, { companyId: a.company.id });
    const row = await setStatus(q.id, 'Accepted');
    const res = await patch(rep.cookie, { id: q.id, updatedAt: row.updatedAt.toISOString() }, { subject: 'X' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'locked' });
    expect((await req('GET', `/api/quotations/${q.id}`, rep.cookie)).json()).toMatchObject({ locked: true, canEdit: false });
  });

  it('while a send is queued: sending, not editable (409 sending)', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    const q = await createQuote(rep.cookie, { companyId: a.company.id });
    const msg = await prisma.emailMessage.create({
      data: { userId: rep.user.id, folder: 'sent', status: 'queued', fromAddress: 'me@daitpartners.com', subject: 'Quotation' },
    });
    const row = await prisma.quotation.update({ where: { id: q.id }, data: { sendingMessageId: msg.id } });
    expect((await req('GET', `/api/quotations/${q.id}`, rep.cookie)).json()).toMatchObject({ sending: true, canEdit: false });
    const res = await patch(rep.cookie, { id: q.id, updatedAt: row.updatedAt.toISOString() }, { subject: 'X' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'sending' });
    expect((await req('POST', `/api/quotations/${q.id}/accept`, rep.cookie, {})).json()).toEqual({ error: 'sending' });
  });

  it('negotiate: Sent → Negotiating only', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    const q = await createQuote(rep.cookie, { companyId: a.company.id });
    expect((await req('POST', `/api/quotations/${q.id}/negotiate`, rep.cookie, {})).json()).toEqual({ error: 'invalid_transition' });
    await setStatus(q.id, 'Sent');
    const res = await req('POST', `/api/quotations/${q.id}/negotiate`, rep.cookie, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('Negotiating');
    expect(res.json().history.at(-1).text).toBe(`Negotiating · by ${rep.user.name}`);
  });

  it('accept from Draft: lead Won, company Client, owner notified, timeline entry, locked', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const manager = await as('MANAGER');
    const a = await setup(rep.user.id);
    let q = await createQuote(rep.cookie, { companyId: a.company.id, leadId: a.lead.id });
    q = (await patch(rep.cookie, q, { lines: [line('Design', 1, 1000)] })).json();
    const res = await req('POST', `/api/quotations/${q.id}/accept`, manager.cookie, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'Accepted', locked: true, canEdit: false });
    expect(res.json().history.at(-1).text).toBe(`Accepted · by ${manager.user.name}`);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: a.lead.id } })).status).toBe('Won');
    expect((await prisma.company.findUniqueOrThrow({ where: { id: a.company.id } })).isClient).toBe(true);
    const notes = await prisma.notification.findMany({ where: { userId: rep.user.id } });
    expect(notes).toEqual([expect.objectContaining({
      text: `Quotation accepted · ${q.number} · ${formatMoney(1180, 'INR')}`, detail: 'Convert to project?', link: `/quotations/${q.id}`,
    })]);
    const acts = await prisma.leadActivity.findMany({ where: { leadId: a.lead.id, activityType: 'quote' }, orderBy: { id: 'asc' } });
    expect(acts.map((x) => x.title)).toEqual([`Quotation drafted · ${q.number}`, `Quotation accepted · ${q.number}`]);
    expect((await req('POST', `/api/quotations/${q.id}/accept`, manager.cookie, {})).json()).toEqual({ error: 'locked' });
    expect((await req('POST', `/api/quotations/${q.id}/reject`, manager.cookie, {})).json()).toEqual({ error: 'locked' });
  });

  it('accept without a lead still flags the company as a client', async () => {
    const admin = await as('ADMINISTRATOR');
    const a = await setup(null);
    const q = await createQuote(admin.cookie, { companyId: a.company.id });
    expect((await req('POST', `/api/quotations/${q.id}/accept`, admin.cookie, {})).statusCode).toBe(200);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: a.company.id } })).isClient).toBe(true);
  });

  it('reject on a Won lead leaves it Won', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    await prisma.lead.update({ where: { id: a.lead.id }, data: { status: 'Won' } });
    const q = await createQuote(rep.cookie, { companyId: a.company.id, leadId: a.lead.id });
    await setStatus(q.id, 'Negotiating');
    const res = await req('POST', `/api/quotations/${q.id}/reject`, rep.cookie, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'Rejected', locked: true });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: a.lead.id } })).status).toBe('Won');
    const acts = await prisma.leadActivity.findMany({ where: { leadId: a.lead.id }, orderBy: { id: 'asc' } });
    expect(acts.map((x) => x.title)).toEqual([`Quotation drafted · ${q.number}`, `Quotation rejected · ${q.number}`]);
  });

  it('accept with unsent edits: 409 without the flag; with it the lines are restored from the sent revision', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    let q = await createQuote(rep.cookie, { companyId: a.company.id, leadId: a.lead.id });
    q = (await patch(rep.cookie, q, { subject: 'Original', lines: [line('Design', 1, 1000)] })).json();
    await sendRevision1(q.id);
    q = (await req('GET', `/api/quotations/${q.id}`, rep.cookie)).json();
    q = (await patch(rep.cookie, q, { subject: 'Edited', lines: [line('Design', 1, 5000), line('Extra', 1, 1)] })).json();
    expect(q).toMatchObject({ revision: 2, editingNewRevision: true });

    const refused = await req('POST', `/api/quotations/${q.id}/accept`, rep.cookie, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'unsent_changes' });
    const res = await req('POST', `/api/quotations/${q.id}/accept`, rep.cookie, { discardUnsent: true });
    expect(res.statusCode, res.body).toBe(200);
    const done = res.json() as Detail;
    expect(done).toMatchObject({ status: 'Accepted', revision: 1, editingNewRevision: false, subject: 'Original' });
    expect(done.lines.map((l) => [l.item, l.unitPrice])).toEqual([['Design', 1000]]);
    expect(done.totals.total).toBe(1180);
    expect(done.history.map((h) => h.text)).toContain('Revision 2 discarded (unsent changes)');
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: rep.user.id } });
    expect(note.text).toBe(`Quotation accepted · ${q.number} · ${formatMoney(1180, 'INR')}`);
  });

  it('reject with unsent edits and no revision row just clears the flag', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    const q = await createQuote(rep.cookie, { companyId: a.company.id });
    await setStatus(q.id, 'Sent', { revision: 2, editingNewRevision: true });
    expect((await req('POST', `/api/quotations/${q.id}/reject`, rep.cookie, {})).statusCode).toBe(409);
    const res = await req('POST', `/api/quotations/${q.id}/reject`, rep.cookie, { discardUnsent: true });
    expect(res.json()).toMatchObject({ status: 'Rejected', revision: 1, editingNewRevision: false });
  });

  it('duplicate of an Accepted quotation → a new Draft with the lines', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const a = await setup(rep.user.id);
    let q = await createQuote(rep.cookie, { companyId: a.company.id, leadId: a.lead.id });
    q = (await patch(rep.cookie, q, { subject: 'Brand', currency: 'USD', overallDiscount: 3, lines: [line('Design', 2, 100, 5)] })).json();
    await setStatus(q.id, 'Accepted', { revision: 3 });
    const res = await req('POST', `/api/quotations/${q.id}/duplicate`, rep.cookie, {});
    expect(res.statusCode, res.body).toBe(201);
    const d = res.json() as Detail;
    expect(d.id).not.toBe(q.id);
    expect(d).toMatchObject({
      number: `Q-${today().slice(0, 4)}-002`, status: 'Draft', revision: 1, editingNewRevision: false, subject: 'Brand (copy)',
      currency: 'USD', taxRate: 0, overallDiscount: 3, quotationDate: today(), validUntil: shift(today(), 30),
      lead: { id: a.lead.id }, contact: { id: a.leadContactId },
    });
    expect(d.lines).toEqual([expect.objectContaining({ item: 'Design', qty: 2, unitPrice: 100, discount: 5 })]);
    expect(d.history.map((h) => h.text)).toEqual([`Draft created by ${rep.user.name} · copy of ${q.number}`]);
    const acts = await prisma.leadActivity.count({ where: { leadId: a.lead.id, title: `Quotation drafted · ${d.number}` } });
    expect(acts).toBe(1);
  });
});

/** What Task 4's send does to the database, enough for these tests: revision 1 frozen, status Sent. */
async function sendRevision1(id: number): Promise<void> {
  const snapshot = await quotationSnapshot(prisma, id);
  await prisma.quotationRevision.create({
    data: {
      quotationId: id, revisionNo: 1, sentAt: new Date(), sentTo: 'buyer@acme.test', subtotal: snapshot.totals.sub,
      discountTotal: snapshot.totals.disc + snapshot.totals.overall, taxTotal: snapshot.totals.tax, grandTotal: snapshot.totals.total,
      note: 'Sent by email as PDF', snapshot: snapshot as object,
    },
  });
  await prisma.quotation.update({ where: { id }, data: { status: 'Sent' } });
}

describe('quotation expiry', () => {
  const at = new Date('2026-11-22T20:00:00Z');

  async function quote(ownerTz: string, status: string, validUntil: string | null) {
    const owner = await makeUser();
    await prisma.user.update({ where: { id: owner.id }, data: { timezone: ownerTz } });
    const company = await makeCompany();
    return prisma.quotation.create({
      data: {
        number: `Q-2026-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, companyId: company.id, ownerId: owner.id,
        quotationDate: new Date('2026-10-01'), validUntil: validUntil ? new Date(`${validUntil}T00:00:00Z`) : null,
        currency: 'USD', subject: 'S', status,
      },
    });
  }

  it('Sent / Negotiating past valid-until in the owner’s time zone → Expired, history, owner notified', async () => {
    // 20:00 UTC on 22 Nov is already 23 Nov in Kolkata, still 22 Nov in Los Angeles.
    const kolkata = await quote('Asia/Kolkata', 'Sent', '2026-11-22');
    const la = await quote('America/Los_Angeles', 'Negotiating', '2026-11-22');
    const old = await quote('Europe/London', 'Negotiating', '2026-11-01');
    const draft = await quote('Europe/London', 'Draft', '2026-11-01');
    const noDate = await quote('Europe/London', 'Sent', null);
    expect(await expireQuotations(prisma, at)).toBe(2);
    const status = async (id: number) => (await prisma.quotation.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(kolkata.id)).toBe('Expired');
    expect(await status(old.id)).toBe('Expired');
    expect(await status(la.id)).toBe('Negotiating');
    expect(await status(draft.id)).toBe('Draft');
    expect(await status(noDate.id)).toBe('Sent');
    const k = await prisma.quotation.findUniqueOrThrow({ where: { id: kolkata.id } });
    expect((k.history as { text: string }[]).map((h) => h.text)).toEqual(['Expired · valid until 2026-11-22']);
    const n = await prisma.notification.findMany({ where: { userId: kolkata.ownerId } });
    expect(n).toEqual([expect.objectContaining({ text: `Quotation expired · ${kolkata.number}`, link: `/quotations/${kolkata.id}` })]);
  });

  it('the worker’s minute schedule runs the check at most once an hour', async () => {
    resetQuotationExpiryClock();
    await quote('Europe/London', 'Sent', '2026-11-01');
    expect(await scheduleQuotationExpiry(prisma, at)).toBe(1);
    await quote('Europe/London', 'Sent', '2026-11-01');
    expect(await scheduleQuotationExpiry(prisma, new Date(at.getTime() + 59 * 60_000))).toBeNull();
    expect(await scheduleQuotationExpiry(prisma, new Date(at.getTime() + 60 * 60_000))).toBe(1);
  });
});
