import type { FastifyInstance } from 'fastify';
import type { EmailAccount, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { localNow, roleLabel } from '@dait-crm/shared';
import type { GraphClient, GraphDraft, MailMessage } from '../src/graph/client';
import { GraphError } from '../src/graph/client';
import { runOnce } from '../src/jobs/runner';
import { sendUserEmailHandler } from '../src/jobs/handlers/sendUserEmail';
import { ymd } from '../src/leads/dates';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeProject, makeUser, signIn } from './factory';
import { queueOutgoing, type Outgoing } from '../src/mail/outgoing';
import { outgoingBody } from '../src/mail/formatted';
import type { AuthUser } from '../src/plugins/auth';

/** Outlook for the drafts path: a new draft is D1, saves and sends are taken (and sends recorded). */
const draftGraph: GraphClient & { sent: string[] } = {
  ...fakeGraph({
    async createDraft(_account, d): Promise<GraphDraft> {
      return { id: 'D1', conversationId: null, subject: d.subject, html: d.html, to: d.to, cc: d.cc, bcc: d.bcc, lastModified: '2026-11-27T10:00:00Z', attachments: [] };
    },
    async updateDraft() {},
    async sendDraft(_account, id) {
      draftGraph.sent.push(id);
    },
  }),
  sent: [],
};

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({ graph: draftGraph });
});
afterAll(() => app.close());
beforeEach(async () => {
  draftGraph.sent = [];
  await resetDb();
  await seedLookups();
});

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function personal(userId: number, address: string, status = 'connected') {
  return prisma.emailAccount.create({
    data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status },
  });
}

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Sebastian Passalacqua' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const company = await makeCompany({ name: 'Grupo Andino' });
  const contact = await makeContact({ companyId: company.id, firstName: 'Ana', lastName: 'Torres', businessEmail: 'ana@andino.cl' });
  const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: rep.id, status: 'Contacted' });
  return { rep, admin, company, contact, lead };
}

const body = (leadId: number, extra: Record<string, unknown> = {}) => ({
  to: 'ana@andino.cl', cc: ['carlos@daitpartners.com'], subject: '¿Una llamada esta semana?', body: 'Hola Ana:\n\nSaludos', leadId, ...extra,
});

function recordingGraph(error?: Error): GraphClient & { calls: { account: EmailAccount; msg: MailMessage }[] } {
  const calls: { account: EmailAccount; msg: MailMessage }[] = [];
  return { ...fakeGraph(), calls, async sendMail(account, msg) { calls.push({ account, msg }); if (error) throw error; } };
}
/** `days` after today in `zone`. */
const dayAhead = (zone: string, days: number) => ymd(new Date(Date.parse(`${localNow(zone).day}T00:00:00Z`) + days * 86_400_000))!;

/** The lead page's Send: a new draft with the lead (and project), then sent as the form holds it, after the Undo window. */
async function sendFromLeadPage(cookie: string, leadId: number, opts: { projectId?: number; followUp?: Record<string, unknown> } = {}) {
  const made = await call('POST', '/api/mail/drafts', cookie, { kind: 'new', leadId, ...(opts.projectId ? { projectId: opts.projectId } : {}) });
  expect(made.statusCode, made.body).toBe(201);
  return call('POST', `/api/mail/drafts/${made.json().id}/send`, cookie, {
    to: ['ana@andino.cl'], cc: ['carlos@daitpartners.com'], bcc: [], subject: '¿Una llamada esta semana?', bodyHtml: '<p>Hola Ana</p>',
    leadId, projectId: opts.projectId ?? null, at: null, followUp: opts.followUp ?? null,
  });
}

const run = (graph: GraphClient) => runOnce({ types: ['send_user_email'], handlers: { send_user_email: sendUserEmailHandler }, graph });

/*
 * The lead page sends through the drafts path since web-mail release 3 (`POST /leads/:id/emails` and release 2's
 * `POST /mail` are gone). Its queue, worker and lead effects are checked here through the drafts path. Quotations still
 * queue a ready message (queueOutgoing, folder `sent`) that the worker sends with sendMail; that path's failure handling
 * is checked with a message queued on the lead the same way.
 */
/** Every queued send made due now (the Undo window passed), then run with the drafts Outlook. */
async function sendsDue() {
  await prisma.job.updateMany({ where: { type: 'send_user_email', status: 'queued' }, data: { runAt: new Date(Date.now() - 1000) } });
  while (await run(draftGraph));
}

const authUser = (u: User): AuthUser => ({ id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat });
/** A ready message queued on the lead (as quotations queue theirs), sent by the worker with sendMail. */
async function queueOnLead(rep: User, box: EmailAccount, leadId: number, extra: Partial<Outgoing> = {}) {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
    return queueOutgoing(tx, authUser(rep), box, {
      lead, to: ['ana@andino.cl'], cc: ['carlos@daitpartners.com'], subject: '¿Una llamada esta semana?', body: 'Hola Ana:\n\nSaludos', ...extra,
    });
  });
}

describe('the lead page Send (drafts path): queue, worker, lead effects', () => {
  it('without a connected personal mailbox: 409 no_mailbox and nothing made or queued', async () => {
    const { rep, lead } = await setup();
    const res = await call('POST', '/api/mail/drafts', await signIn(app, rep), { kind: 'new', leadId: lead.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_mailbox');
    expect(await prisma.emailMessage.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("queues the draft from the user's mailbox; the worker sends the Outlook draft, then logs the activity on the lead", async () => {
    const { rep, lead, contact, company } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    const res = await sendFromLeadPage(await signIn(app, rep), lead.id);
    expect(res.statusCode, res.body).toBe(202);
    const queued = await prisma.emailMessage.findFirstOrThrow();
    expect(queued).toMatchObject({
      userId: rep.id, accountId: box.id, leadId: lead.id, contactId: contact.id, companyId: company.id, folder: 'drafts', status: 'queued',
      fromAddress: 'seba@daitpartners.com', subject: '¿Una llamada esta semana?',
    });
    expect(queued.toAddresses).toEqual(['ana@andino.cl']);
    expect(queued.ccAddresses).toEqual(['carlos@daitpartners.com']);
    const job = await prisma.job.findFirstOrThrow();
    expect(job).toMatchObject({ type: 'send_user_email', status: 'queued' });
    expect(job.payload).toEqual({ emailMessageId: queued.id, draft: true });
    // Nothing on the lead until the mail leaves.
    expect(await prisma.leadActivity.count({ where: { activityType: 'email' } })).toBe(0);

    await sendsDue();
    expect(draftGraph.sent).toEqual(['D1']);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ folder: 'sent', status: 'sent', lastError: null });
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { activityType: 'email' } });
    expect(act).toMatchObject({ title: 'Email sent · ¿Una llamada esta semana?', relatedType: 'email_message', relatedId: queued.id, byUserId: rep.id });
    // No follow-up without the send dialog's task.
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp).toBeNull();
  });

  it('a message part over the cap is refused 413 message_too_long, never cut, and nothing is queued', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const cookie = await signIn(app, rep);
    const made = await call('POST', '/api/mail/drafts', cookie, { kind: 'new', leadId: lead.id });
    const res = await call('POST', `/api/mail/drafts/${made.json().id}/send`, cookie, {
      to: ['ana@andino.cl'], cc: [], bcc: [], subject: 'S', bodyHtml: '<p>' + 'x'.repeat(200_001) + '</p><p>tail</p>', leadId: lead.id, at: null, followUp: null,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'message_too_long' });
    expect(await prisma.job.count({ where: { type: 'send_user_email' } })).toBe(0);
  });

  it('sending to a New or Not Contacted lead moves it to Contacted (prototype); later statuses are left alone', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const cookie = await signIn(app, rep);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'New' } });
    expect((await sendFromLeadPage(cookie, lead.id)).statusCode).toBe(202);
    await sendsDue();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('Contacted');
    const change = await prisma.leadActivity.findFirstOrThrow({ where: { activityType: 'status' } });
    expect(change).toMatchObject({ statusFrom: 'New', statusTo: 'Contacted', body: 'Email sent' });

    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'Interested' } });
    expect((await sendFromLeadPage(cookie, lead.id)).statusCode).toBe(202);
    await sendsDue();
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('Interested');
  });
});

describe('a ready message queued on a lead (queueOutgoing, as quotations): worker sendMail and its failures', () => {
  it('queues it in Sent with the "Email sent" line; the worker sends through the user\'s mailbox and marks it sent', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    const msg = await queueOnLead(rep, box, lead.id);
    expect(msg).toMatchObject({ folder: 'sent', status: 'queued', bodyText: 'Hola Ana:\n\nSaludos', bodyHtml: '<div>Hola Ana:<br><br>Saludos</div>' });
    expect((await prisma.job.findFirstOrThrow()).payload).toEqual({ emailMessageId: msg.id });
    expect(await prisma.leadActivity.count({ where: { activityType: 'email', relatedId: msg.id } })).toBe(1);
    const graph = recordingGraph();
    expect(await run(graph)).toBe(true);
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]!.account.id).toBe(box.id);
    expect(graph.calls[0]!.msg).toMatchObject({
      to: ['ana@andino.cl'], cc: ['carlos@daitpartners.com'], subject: '¿Una llamada esta semana?', html: '<div>Hola Ana:<br><br>Saludos</div>', text: 'Hola Ana:\n\nSaludos',
    });
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'sent', lastError: null });
  });

  it('a formatted message goes to Graph as the sanitised HTML it stores, with its text', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    const message = await outgoingBody('Hola Ana', '<p>Hola <b>Ana</b></p><script>alert(1)</script>');
    const msg = await queueOnLead(rep, box, lead.id, message);
    expect(msg.bodyHtml).toBe('<p>Hola <b>Ana</b></p>');
    const graph = recordingGraph();
    expect(await run(graph)).toBe(true);
    expect(graph.calls[0]!.msg.html).toBe(msg.bodyHtml);
    expect(graph.calls[0]!.msg.text).toBe(msg.bodyText);
  });

  it('a temporary failure retries; the last failure marks the message failed', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await queueOnLead(rep, box, lead.id);
    await run(recordingGraph(new GraphError('unavailable', 503)));
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'queued' });
    const job = await prisma.job.findFirstOrThrow();
    await prisma.job.update({ where: { id: job.id }, data: { attempts: job.maxAttempts - 1, runAt: new Date() } });
    await run(recordingGraph(new GraphError('unavailable', 503)));
    const failed = await prisma.emailMessage.findFirstOrThrow();
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('unavailable');
  });

  it('a revoked mailbox marks the message failed at once and the mailbox in error', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await queueOnLead(rep, box, lead.id);
    await run(recordingGraph(new GraphError('InvalidAuthenticationToken', 401)));
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed' });
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: box.id } })).status).toBe('error');
    expect((await prisma.job.findFirstOrThrow()).status).toBe('done');
  });

  it('a final failure removes the "Email sent" history line (the sender sees Failed in the Emails tab)', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await queueOnLead(rep, box, lead.id);
    const job = await prisma.job.findFirstOrThrow();
    await prisma.job.update({ where: { id: job.id }, data: { attempts: job.maxAttempts - 1 } });
    await run(recordingGraph(new GraphError('unavailable', 503)));
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed' });
    expect(await prisma.leadActivity.count({ where: { activityType: 'email' } })).toBe(0);
  });

  it('a revoked send does not turn a since-disconnected mailbox into an error', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await queueOnLead(rep, box, lead.id);
    const graph: GraphClient = {
      ...fakeGraph(),
      async sendMail() {
        // The user disconnects while the send is in flight; then Microsoft answers 401.
        await prisma.emailAccount.update({ where: { id: box.id }, data: { status: 'disconnected', refreshTokenEnc: '' } });
        throw new GraphError('InvalidAuthenticationToken', 401);
      },
    };
    await run(graph);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: box.id } })).status).toBe('disconnected');
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed' });
  });

  it('an interrupted send is never handed to Microsoft twice', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await queueOnLead(rep, box, lead.id);
    // A previous attempt claimed the message and then died before recording the result.
    await prisma.emailMessage.updateMany({ data: { status: 'sending' } });
    const graph = recordingGraph();
    await run(graph);
    expect(graph.calls).toHaveLength(0);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed', lastError: 'interrupted_may_have_sent' });
  });

  it('a queued message never goes out through a mailbox that now belongs to someone else', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await queueOnLead(rep, box, lead.id);
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    await prisma.emailAccount.update({ where: { id: box.id }, data: { userId: other.id } });
    const graph = recordingGraph();
    await run(graph);
    expect(graph.calls).toHaveLength(0);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed', lastError: 'mailbox_not_connected' });
  });
});

describe('lead Emails tab and timeline: Administrators and Managers see the team\'s lead mail (web-mail release 1)', () => {
  /** An unassigned lead (so every Sales rep may open it) with mail in three mailboxes. */
  async function team() {
    const maya = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
    const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
    const ravi = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Ravi Kumar' });
    const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
    const manager = await makeUser({ role: 'MANAGER', name: 'Neha Rao' });
    const company = await makeCompany({ name: 'Grupo Andino' });
    const lead = await makeLead({ companyId: company.id, assignedToId: null, status: 'Contacted' });
    const mayaBox = await personal(maya.id, 'maya@daitpartners.com');
    const carlosBox = await personal(carlos.id, 'carlos@daitpartners.com');
    const adminBox = await personal(admin.id, 'deepak@daitpartners.com');
    let n = 0;
    const msg = (userId: number, accountId: number, data: Record<string, unknown>) => {
      n += 1;
      return prisma.emailMessage.create({
        data: {
          userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@andino.cl', toAddresses: [],
          subject: 'Proposal', bodyText: 'Looks good', graphId: `g-${n}`, threadId: `conv-${n}`, isRead: false,
          occurredAt: new Date('2026-11-20T10:00:00Z'), leadId: lead.id, companyId: company.id, ...data,
        },
      });
    };
    const proposal = await msg(maya.id, mayaBox.id, { subject: 'Proposal' });
    const pricing = await msg(carlos.id, carlosBox.id, { subject: 'Pricing', occurredAt: new Date('2026-11-20T11:00:00Z') });
    const intro = await msg(admin.id, adminBox.id, { subject: 'Intro', occurredAt: new Date('2026-11-20T09:00:00Z') });
    await msg(maya.id, mayaBox.id, { subject: 'Draft to Ana', folder: 'drafts', status: 'draft', occurredAt: new Date('2026-11-20T12:00:00Z') });
    return { maya, carlos, ravi, admin, manager, lead, mayaBox, proposal, pricing, intro, msg };
  }
  const tab = async (leadId: number, cookie: string) =>
    (await call('GET', `/api/leads/${leadId}/emails`, cookie)).json().items as { id: number; subject: string; ownerName: string | null }[];
  const emailLines = async (leadId: number, cookie: string) =>
    ((await call('GET', `/api/leads/${leadId}`, cookie)).json().activities as { activityType: string; title: string; body: string | null }[])
      .filter((a) => a.activityType === 'email');

  it('Emails tab: an Administrator or Manager lists every user\'s mail on the lead with ownerName; a Sales rep only their own', async () => {
    const f = await team();
    const adminItems = await tab(f.lead.id, await signIn(app, f.admin));
    expect(adminItems.map((e) => [e.subject, e.ownerName])).toEqual([['Pricing', 'Carlos Mendez'], ['Proposal', 'Maya Pillai'], ['Intro', null]]);
    const managerItems = await tab(f.lead.id, await signIn(app, f.manager));
    expect(managerItems.map((e) => [e.subject, e.ownerName])).toEqual([['Pricing', 'Carlos Mendez'], ['Proposal', 'Maya Pillai'], ['Intro', 'Deepak Singh']]);
    const mayaItems = await tab(f.lead.id, await signIn(app, f.maya));
    expect(mayaItems.map((e) => [e.subject, e.ownerName])).toEqual([['Proposal', null]]);
    const otherRepItems = await tab(f.lead.id, await signIn(app, f.ravi));
    expect(otherRepItems).toEqual([]);
  });

  it('timeline: Administrators, Managers and the mailbox owner see the email subject; a Sales rep who does not own the mailbox sees "Email received" only', async () => {
    const f = await team();
    // The admin logs Maya's message: the line is the admin's, the mail stays Maya's (ruling 3: the mailbox owner decides).
    expect((await call('POST', `/api/mail/${f.proposal.id}/log`, await signIn(app, f.admin))).statusCode).toBe(201);
    const line = await prisma.leadActivity.findFirstOrThrow({ where: { activityType: 'email' } });
    expect(line).toMatchObject({ title: 'Email received · Proposal', relatedId: f.proposal.id, byUserId: f.admin.id });
    for (const viewer of [f.admin, f.manager, f.maya]) {
      expect(await emailLines(f.lead.id, await signIn(app, viewer))).toMatchObject([{ title: 'Email received · Proposal' }]);
    }
    expect(await emailLines(f.lead.id, await signIn(app, f.carlos))).toEqual([expect.objectContaining({ title: 'Email received', body: null })]);
  });

  it('timeline: a line whose message is gone shows no subject, even to the user who logged it; the team still sees it', async () => {
    const f = await team();
    await prisma.leadActivity.create({
      data: { leadId: f.lead.id, activityType: 'email', title: 'Email sent · Gone', body: 'text', relatedType: 'email_message', relatedId: 999_999, byUserId: f.maya.id },
    });
    expect(await emailLines(f.lead.id, await signIn(app, f.maya))).toEqual([expect.objectContaining({ title: 'Email sent', body: null })]);
    expect(await emailLines(f.lead.id, await signIn(app, f.admin))).toMatchObject([{ title: 'Email sent · Gone' }]);
  });

  it('company activities follow the same rule', async () => {
    const f = await team();
    // A Sales rep sees a company through their own leads: Carlos's lead first, then handed to Maya (the mail stays Carlos's).
    await prisma.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.carlos.id } });
    await call('POST', `/api/mail/${f.pricing.id}/log`, await signIn(app, f.carlos));
    const companyLines = async (cookie: string) =>
      ((await call('GET', `/api/companies/${f.lead.companyId}/activities`, cookie)).json().items as { activityType: string; title: string }[])
        .filter((a) => a.activityType === 'email').map((a) => a.title);
    expect(await companyLines(await signIn(app, f.manager))).toEqual(['Email received · Pricing']);
    expect(await companyLines(await signIn(app, f.carlos))).toEqual(['Email received · Pricing']);
    await prisma.lead.update({ where: { id: f.lead.id }, data: { assignedToId: f.maya.id } });
    expect(await companyLines(await signIn(app, f.maya))).toEqual(['Email received']);
  });

  it("listing others' mail on the lead writes one audit row with message ids and no content", async () => {
    const f = await team();
    await tab(f.lead.id, await signIn(app, f.admin));
    const rows = await prisma.auditLog.findMany({ where: { action: 'view' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'lead', entityId: String(f.lead.id), action: 'view', userId: f.admin.id });
    expect(rows[0]!.after).toEqual({ emailMessageIds: [f.pricing.id, f.proposal.id] });
    // Your own mail only (a Sales rep, or an admin on a lead with only their own mail): no audit row.
    await prisma.auditLog.deleteMany();
    await tab(f.lead.id, await signIn(app, f.maya));
    const ownOnly = await makeLead({ assignedToId: null });
    await f.msg(f.admin.id, (await prisma.emailAccount.findFirstOrThrow({ where: { userId: f.admin.id } })).id, { leadId: ownOnly.id });
    await tab(ownOnly.id, await signIn(app, f.admin));
    expect(await prisma.auditLog.count({ where: { action: 'view' } })).toBe(0);
  });

  it("others' mail on the lead is audited once per viewer, message and day, not on every poll", async () => {
    const f = await team();
    const admin = await signIn(app, f.admin);
    await tab(f.lead.id, admin);
    await tab(f.lead.id, admin); // the tab polls while mail is queued
    expect(await prisma.auditLog.count({ where: { action: 'view' } })).toBe(1);

    const later = await f.msg(f.maya.id, f.mayaBox.id, { subject: 'Later', leadId: f.lead.id });
    await tab(f.lead.id, admin);
    const rows = await prisma.auditLog.findMany({ where: { action: 'view' }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => r.after)).toEqual([{ emailMessageIds: [f.pricing.id, f.proposal.id] }, { emailMessageIds: [later.id] }]);

    // Another viewer is audited separately; yesterday's rows do not count today.
    await tab(f.lead.id, await signIn(app, f.manager));
    expect(await prisma.auditLog.count({ where: { action: 'view', userId: f.manager.id } })).toBe(1);
    await prisma.auditLog.updateMany({ where: { userId: f.admin.id }, data: { at: new Date(Date.now() - 86_400_000 * 2) } });
    await tab(f.lead.id, admin);
    expect(await prisma.auditLog.count({ where: { action: 'view', userId: f.admin.id } })).toBe(3);
  });

  it('mail of a deleted lead never reaches the lead tab (it has no lead)', async () => {
    const f = await team();
    await f.msg(f.maya.id, f.mayaBox.id, { subject: 'Old lead', leadId: null, leadDeletedAt: new Date('2026-11-25T10:00:00Z') });
    expect((await tab(f.lead.id, await signIn(app, f.admin))).map((e) => e.subject)).toEqual(['Pricing', 'Proposal', 'Intro']);
    expect((await tab(f.lead.id, await signIn(app, f.maya))).map((e) => e.subject)).toEqual(['Proposal']);
  });

  it('the sender still lists their own message from the lead page, with no owner name', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const repCookie = await signIn(app, rep);
    const sent = await sendFromLeadPage(repCookie, lead.id);
    expect(sent.statusCode, sent.body).toBe(202);
    await sendsDue();
    expect(await tab(lead.id, repCookie)).toMatchObject([{ subject: '¿Una llamada esta semana?', ownerName: null }]);
    expect(await emailLines(lead.id, repCookie)).toMatchObject([{ title: 'Email sent · ¿Una llamada esta semana?' }]);
  });
});

describe('the lead page sends through the drafts path (web-mail release 3)', () => {
  it('POST /leads/:id/emails is gone (404); GET still lists the lead mail', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const cookie = await signIn(app, rep);
    const old = await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...body(lead.id), followUpDays: 3, updatedAt: lead.updatedAt.toISOString() });
    expect(old.statusCode).toBe(404);
    expect(await prisma.emailMessage.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
    expect((await call('GET', `/api/leads/${lead.id}/emails`, cookie)).statusCode).toBe(200);
  });

  it("the Emails tab: a plain draft, a scheduled send and someone else's queued send stay out; your failed send is listed", async () => {
    const { rep, admin, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    const adminBox = await personal(admin.id, 'deepak@daitpartners.com');
    const row = (userId: number, accountId: number, subject: string, data: Record<string, unknown>) => prisma.emailMessage.create({
      data: { userId, accountId, leadId: lead.id, folder: 'drafts', source: 'crm', fromAddress: 'x@daitpartners.com', toAddresses: ['ana@andino.cl'], subject, bodyText: '', status: 'draft', ...data },
    });
    await row(rep.id, box.id, 'Plain draft', {});
    await row(rep.id, box.id, 'Scheduled', { status: 'queued', scheduledAt: new Date(Date.now() + 86_400_000) });
    await row(rep.id, box.id, 'Failed', { status: 'failed', lastError: 'draft_gone' });
    await row(admin.id, adminBox.id, 'Admin sending', { status: 'queued' });
    const subjects = async (cookie: string) => ((await call('GET', `/api/leads/${lead.id}/emails`, cookie)).json().items as { subject: string }[]).map((m) => m.subject);
    expect(await subjects(await signIn(app, rep))).toEqual(['Failed']);
    expect(await subjects(await signIn(app, admin))).toEqual(['Admin sending']);
  });

  it('without a connected personal mailbox: the draft is 409 no_mailbox and nothing is made', async () => {
    const { rep, lead } = await setup();
    const res = await call('POST', '/api/mail/drafts', await signIn(app, rep), { kind: 'new', leadId: lead.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_mailbox');
    expect(await prisma.emailMessage.count()).toBe(0);
  });

  it('a draft made with the lead, sent with a follow-up: when the mail leaves, the "Email sent" line, Contacted and the follow-up task', async () => {
    const { rep, lead } = await setup();
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'New' } });
    await personal(rep.id, 'seba@daitpartners.com');
    const cookie = await signIn(app, rep);
    const day = dayAhead(rep.timezone, 3);
    const res = await sendFromLeadPage(cookie, lead.id, {
      followUp: { date: day, time: '09:00', title: 'Follow up: ¿Una llamada esta semana?', assignedToId: rep.id, kind: 'followup', priority: 'normal', updateLead: true },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ undoUntil: expect.any(String), followUp: { date: day, time: '09:00' } });
    // Nothing on the lead until the mail leaves; the Emails tab lists it as being sent (so the tab polls).
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id } })).toBe(0);
    const listed = async () => ((await call('GET', `/api/leads/${lead.id}/emails`, cookie)).json().items as { status: string }[]).map((m) => m.status);
    expect(await listed()).toEqual(['queued']);
    await sendsDue();
    expect(await listed()).toEqual(['sent']);
    expect(draftGraph.sent).toHaveLength(1);
    const msg = await prisma.emailMessage.findFirstOrThrow();
    expect(msg).toMatchObject({ leadId: lead.id, status: 'sent', folder: 'sent', subject: '¿Una llamada esta semana?' });
    expect(msg.toAddresses).toEqual(['ana@andino.cl']);
    expect(msg.ccAddresses).toEqual(['carlos@daitpartners.com']);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe('Contacted');
    expect(after.nextFollowUp?.toISOString().slice(0, 10)).toBe(day);
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, activityType: 'email', title: 'Email sent · ¿Una llamada esta semana?' } })).toBe(1);
    expect(await prisma.task.findFirstOrThrow({ where: { origin: 'email_follow_up' } })).toMatchObject({ leadId: lead.id, dueTime: '09:00', kind: 'followup' });
  });
});

describe('project tag on lead page email (3B)', () => {
  it('stores the project; one you cannot see or on another company is 400 invalid_project', async () => {
    const { rep, admin, lead, company } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const project = await makeProject({ companyId: company.id, leadId: lead.id, managerId: rep.id });
    const other = await makeCompany({ name: 'Otra' });
    const foreign = await makeProject({ companyId: other.id, managerId: rep.id });
    const hidden = await makeProject({ companyId: other.id, leadId: (await makeLead({ companyId: other.id, assignedToId: admin.id })).id, managerId: admin.id });
    const cookie = await signIn(app, rep);
    for (const bad of [foreign.id, hidden.id]) {
      const res = await call('POST', '/api/mail/drafts', cookie, { kind: 'new', leadId: lead.id, projectId: bad });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe('invalid_project');
    }
    expect(await prisma.emailMessage.count()).toBe(0);
    const res = await sendFromLeadPage(cookie, lead.id, { projectId: project.id });
    expect(res.statusCode, res.body).toBe(202);
    await sendsDue();
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ projectId: project.id, status: 'sent' });
  });
});
