import type { FastifyInstance } from 'fastify';
import type { EmailAccount, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatMoney } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type GraphClient, type MailMessage } from '../src/graph/client';
import { runOnce } from '../src/jobs/runner';
import { sendUserEmailHandler } from '../src/jobs/handlers/sendUserEmail';
import type { QuotationSnapshot } from '../src/quotations/service';
import type { SendUserEmailPayload } from '../src/jobs/types';
import { fakeGraph, resetDb, seedLookups } from './helpers';
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

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie } });

function recordingGraph(error?: Error): GraphClient & { calls: { account: EmailAccount; msg: MailMessage }[] } {
  const calls: { account: EmailAccount; msg: MailMessage }[] = [];
  return { ...fakeGraph(), calls, async sendMail(account, msg) { calls.push({ account, msg }); if (error) throw error; } };
}
const run = (graph: GraphClient) => runOnce({ types: ['send_user_email'], handlers: { send_user_email: sendUserEmailHandler }, graph });

async function personal(userId: number, address: string) {
  return prisma.emailAccount.create({
    data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' },
  });
}

type Detail = {
  id: number; number: string; status: string; revision: number; editingNewRevision: boolean; updatedAt: string; sending: boolean;
  canEdit: boolean; totals: { total: number }; currency: 'USD' | 'CAD' | 'INR'; subject: string;
  history: { text: string }[]; revisions: { revisionNo: number; sentTo: string; grandTotal: number }[];
};

/** A rep with a connected mailbox, a lead (Qualified) whose contact Priya Rao has an email, and a Draft on it. */
async function setup(opts: { leadStatus?: string; email?: string | null; mailbox?: boolean; language?: string } = {}) {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Sebastian Passalacqua', language: opts.language ?? 'en' });
  const cookie = await signIn(app, rep);
  const company = await makeCompany({ name: 'Acme India', country: 'India' });
  const contact = await makeContact({
    companyId: company.id, firstName: 'Priya', lastName: 'Rao', businessEmail: opts.email === undefined ? 'priya@acme.test' : opts.email,
  });
  const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: rep.id, status: opts.leadStatus ?? 'Qualified' });
  if (opts.mailbox !== false) await personal(rep.id, 'seba@daitpartners.com');
  const created = await req('POST', '/api/quotations', cookie, { companyId: company.id, leadId: lead.id });
  expect(created.statusCode, created.body).toBe(201);
  let q = created.json() as Detail;
  const res = await req('PATCH', `/api/quotations/${q.id}`, cookie, {
    updatedAt: q.updatedAt, lines: [{ item: 'Discovery workshop', description: null, qty: 2, unit: 'day', unitPrice: 50000, discount: 0 }],
  });
  expect(res.statusCode, res.body).toBe(200);
  q = res.json();
  return { rep, cookie, company, contact, lead, q };
}

const send = (cookie: string, id: number, body?: object) => req('POST', `/api/quotations/${id}/send`, cookie, body ?? {});
const detail = async (cookie: string, id: number): Promise<Detail> => (await req('GET', `/api/quotations/${id}`, cookie)).json();
const payloadOf = async () =>
  (await prisma.job.findFirstOrThrow({ where: { type: 'send_user_email' }, orderBy: { id: 'desc' } })).payload as unknown as SendUserEmailPayload;
/** Puts the queued send job on its last attempt (as after half an hour of retries). */
async function lastAttempt() {
  const job = await prisma.job.findFirstOrThrow({ where: { type: 'send_user_email' }, orderBy: { id: 'desc' } });
  await prisma.job.update({ where: { id: job.id }, data: { attempts: job.maxAttempts - 1, runAt: new Date(), status: 'queued' } });
}

describe('send a quotation by email (release 3A)', () => {
  it('queues the email with the PDF attached; nothing changes on the quotation or lead until it is sent', async () => {
    const { cookie, q, lead, contact, rep } = await setup();
    const res = await send(cookie, q.id);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ id: q.id, status: 'Draft', sending: true, canEdit: false, revisions: [] });

    const msg = await prisma.emailMessage.findFirstOrThrow();
    expect(msg).toMatchObject({
      userId: rep.id, leadId: lead.id, contactId: contact.id, status: 'queued', folder: 'sent',
      subject: `Quotation ${q.number} · ${q.subject}`,
    });
    expect(msg.toAddresses).toEqual(['priya@acme.test']);
    expect(msg.attachmentNames).toEqual([`${q.number}-rev1.pdf`]);
    expect(msg.bodyText).toContain(`Please find attached quotation ${q.number} (revision 1)`);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } })).sendingMessageId).toBe(msg.id);

    const p = await payloadOf();
    expect(p.emailMessageId).toBe(msg.id);
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments![0]).toMatchObject({ name: `${q.number}-rev1.pdf`, contentType: 'application/pdf' });
    expect(Buffer.from(p.attachments![0]!.contentBase64, 'base64').subarray(0, 4).toString()).toBe('%PDF');
    // The snapshot sent is the one previewed, with the issuer frozen.
    expect(p.quotation).toMatchObject({ id: q.id, snapshot: { number: q.number, revision: 1, issuer: { legalName: 'DAIT Partners LLP' } } });

    // No "Email sent" line now: the timeline gets "Quotation sent" when Microsoft confirms the send.
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, activityType: { in: ['email', 'status'] } } })).toBe(0);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('Qualified');

    // While sending: not editable, not sendable again.
    const edit = await req('PATCH', `/api/quotations/${q.id}`, cookie, { updatedAt: res.json().updatedAt, subject: 'Changed' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe('sending');
    const again = await send(cookie, q.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('sending');
  });

  it('the user may edit the message', async () => {
    const { cookie, q } = await setup();
    expect((await send(cookie, q.id, { body: 'Hi Priya,\n\nHere it is.' })).statusCode).toBe(202);
    expect((await prisma.emailMessage.findFirstOrThrow()).bodyText).toBe('Hi Priya,\n\nHere it is.');
  });

  it('the default message is in the quotation owner\'s language', async () => {
    const { cookie, q } = await setup({ language: 'es' });
    expect((await send(cookie, q.id)).statusCode).toBe(202);
    expect((await prisma.emailMessage.findFirstOrThrow()).bodyText).toContain(`Adjuntamos el presupuesto ${q.number} (revisión 1)`);
  });

  it('when the send succeeds: revision 1 frozen, status Sent, lead Proposal Sent, timeline and history', async () => {
    const { cookie, q, lead } = await setup();
    await send(cookie, q.id);
    const graph = recordingGraph();
    expect(await run(graph)).toBe(true);

    expect(graph.calls).toHaveLength(1);
    const sent = graph.calls[0]!.msg;
    expect(sent).toMatchObject({ to: ['priya@acme.test'], subject: `Quotation ${q.number} · ${q.subject}` });
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]).toMatchObject({ name: `${q.number}-rev1.pdf`, contentType: 'application/pdf' });
    expect(Buffer.from(sent.attachments![0]!.contentBase64, 'base64').subarray(0, 4).toString()).toBe('%PDF');

    const d = await detail(cookie, q.id);
    expect(d).toMatchObject({ status: 'Sent', revision: 1, editingNewRevision: false, sending: false, canEdit: true });
    expect(d.revisions).toEqual([expect.objectContaining({ revisionNo: 1, sentTo: 'priya@acme.test', grandTotal: q.totals.total })]);
    expect(d.history.at(-1)!.text).toBe('Sent · rev 1 · emailed as PDF to Priya Rao');
    const rev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: q.id } });
    expect(rev.snapshot).toMatchObject({ revision: 1, number: q.number, issuer: { legalName: 'DAIT Partners LLP' } });

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('Proposal Sent');
    const acts = await prisma.leadActivity.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } });
    expect(acts.filter((a) => a.activityType === 'quote' && a.title.startsWith('Quotation sent'))).toEqual([
      expect.objectContaining({ title: `Quotation sent · ${q.number} rev 1`, body: formatMoney(q.totals.total, q.currency), relatedType: 'quotation', relatedId: q.id }),
    ]);
    expect(acts.filter((a) => a.activityType === 'status')).toEqual([expect.objectContaining({ statusFrom: 'Qualified', statusTo: 'Proposal Sent' })]);
    // One line for the send: no separate "Email sent" entry.
    expect(acts.filter((a) => a.activityType === 'email')).toEqual([]);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'sent' });
  });

  it('a lead already past Proposal Sent (or closed) keeps its status', async () => {
    for (const status of ['Negotiation', 'Lost']) {
      await resetDb();
      await seedLookups();
      const { cookie, q, lead } = await setup({ leadStatus: status });
      await send(cookie, q.id);
      await run(recordingGraph());
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(status);
      expect((await detail(cookie, q.id)).status).toBe('Sent');
    }
  });

  it('edit after send then send again → revision 2; Negotiating stays Negotiating', async () => {
    const { cookie, q } = await setup();
    await send(cookie, q.id);
    await run(recordingGraph());
    let d = await detail(cookie, q.id);
    expect((await req('POST', `/api/quotations/${q.id}/negotiate`, cookie)).statusCode).toBe(200);
    d = await detail(cookie, q.id);
    const edited = await req('PATCH', `/api/quotations/${q.id}`, cookie, { updatedAt: d.updatedAt, overallDiscount: 10 });
    expect(edited.json()).toMatchObject({ revision: 2, editingNewRevision: true });

    expect((await send(cookie, q.id)).statusCode).toBe(202);
    expect((await payloadOf()).attachments![0]!.name).toBe(`${q.number}-rev2.pdf`);
    await run(recordingGraph());
    d = await detail(cookie, q.id);
    expect(d).toMatchObject({ status: 'Negotiating', revision: 2, editingNewRevision: false, sending: false });
    expect(d.revisions.map((r) => r.revisionNo)).toEqual([1, 2]);
    expect(d.revisions[1]!.grandTotal).toBe(d.totals.total);
    expect(d.revisions[1]!.grandTotal).toBeLessThan(d.revisions[0]!.grandTotal);
  });

  it('sending again without edits re-sends the same revision: one row per number and a history line', async () => {
    const { cookie, q, lead } = await setup();
    await send(cookie, q.id);
    await run(recordingGraph());
    expect((await send(cookie, q.id)).statusCode).toBe(202);
    expect((await payloadOf()).attachments![0]!.name).toBe(`${q.number}-rev1.pdf`);
    await run(recordingGraph());
    const d = await detail(cookie, q.id);
    expect(d).toMatchObject({ status: 'Sent', revision: 1, sending: false });
    expect(await prisma.quotationRevision.count({ where: { quotationId: q.id } })).toBe(1);
    expect(d.history.at(-1)!.text).toBe('Sent again · rev 1 · emailed as PDF to Priya Rao');
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, title: `Quotation sent · ${q.number} rev 1` } })).toBe(2);
  });

  it('when the send finally fails: only a history line and a notification to the owner', async () => {
    const { cookie, q, lead, rep } = await setup();
    await send(cookie, q.id);
    await run(recordingGraph(new GraphError('unavailable', 503)));
    // A temporary failure retries: still sending.
    expect((await detail(cookie, q.id)).sending).toBe(true);
    await lastAttempt();
    await run(recordingGraph(new GraphError('unavailable', 503)));

    const d = await detail(cookie, q.id);
    expect(d).toMatchObject({ status: 'Draft', revision: 1, sending: false, canEdit: true, revisions: [] });
    expect(d.history.at(-1)!.text).toBe('Send failed');
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('Qualified');
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id } })).toBe(1); // "Quotation drafted" only
    const notes = await prisma.notification.findMany({ where: { userId: rep.id } });
    expect(notes).toEqual([expect.objectContaining({ text: `Quotation not sent · ${q.number}`, link: `/quotations/${q.id}` })]);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed' });

    // It can be sent again.
    expect((await send(cookie, q.id)).statusCode).toBe(202);
  });

  it('a revoked mailbox fails the send at once, with the same effects', async () => {
    const { cookie, q } = await setup();
    await send(cookie, q.id);
    await run(recordingGraph(new GraphError('token', 401)));
    const d = await detail(cookie, q.id);
    expect(d).toMatchObject({ status: 'Draft', sending: false, revisions: [] });
    expect(d.history.at(-1)!.text).toBe('Send failed');
  });

  it('a failed re-send of revision 2 keeps revision 2 open for editing', async () => {
    const { cookie, q } = await setup();
    await send(cookie, q.id);
    await run(recordingGraph());
    const d1 = await detail(cookie, q.id);
    await req('PATCH', `/api/quotations/${q.id}`, cookie, { updatedAt: d1.updatedAt, overallDiscount: 5 });
    await send(cookie, q.id);
    await run(recordingGraph(new GraphError('token', 401)));
    expect(await detail(cookie, q.id)).toMatchObject({ status: 'Sent', revision: 2, editingNewRevision: true, sending: false });
    expect(await prisma.quotationRevision.count({ where: { quotationId: q.id } })).toBe(1);
  });

  it('409 no_contact_email without a contact address, or without a contact', async () => {
    const { cookie, q } = await setup({ email: null });
    const res = await send(cookie, q.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_contact_email');
    const d = await detail(cookie, q.id);
    await req('PATCH', `/api/quotations/${q.id}`, cookie, { updatedAt: d.updatedAt, contactId: null });
    expect((await send(cookie, q.id)).json().error).toBe('no_contact_email');
    expect(await prisma.emailMessage.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it('409 no_mailbox without a connected mailbox', async () => {
    const { cookie, q } = await setup({ mailbox: false });
    const res = await send(cookie, q.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_mailbox');
    expect(await prisma.job.count()).toBe(0);
  });

  it('409 locked once Accepted / Rejected / Expired; 404 when hidden or missing', async () => {
    const { cookie, q } = await setup();
    for (const status of ['Accepted', 'Rejected', 'Expired']) {
      await prisma.quotation.update({ where: { id: q.id }, data: { status } });
      const locked = await send(cookie, q.id);
      expect(locked.statusCode).toBe(409);
      expect(locked.json().error).toBe('locked');
    }
    await prisma.quotation.update({ where: { id: q.id }, data: { status: 'Draft' } });
    const other: User = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    expect((await send(await signIn(app, other), q.id)).statusCode).toBe(404);
    expect((await send(cookie, 999999)).statusCode).toBe(404);
    expect(await prisma.job.count()).toBe(0);
  });

  it('a sent revision\'s PDF keeps the issuer it was sent with', async () => {
    const { cookie, q } = await setup();
    await send(cookie, q.id);
    await run(recordingGraph());
    await prisma.companySettings.upsert({
      where: { id: 1 }, update: { legalName: 'Renamed Partners LLP' },
      create: { id: 1, legalName: 'Renamed Partners LLP', addressLines: [], email: 'x@y.test' },
    });
    const rev = await prisma.quotationRevision.findFirstOrThrow({ where: { quotationId: q.id } });
    expect((rev.snapshot as unknown as QuotationSnapshot).issuer?.legalName).toBe('DAIT Partners LLP');
    const pdf = await app.inject({ method: 'GET', url: `/api/quotations/${q.id}/pdf?rev=1`, headers: { cookie } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-disposition']).toContain(`${q.number}-rev1.pdf`);
  });
});
