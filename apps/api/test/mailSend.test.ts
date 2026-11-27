import type { FastifyInstance } from 'fastify';
import type { EmailMessage, Job } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftSend, localNow } from '@dait-crm/shared';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type DraftFields, type GraphClient } from '../src/graph/client';
import { runOnce } from '../src/jobs/runner';
import { sendUserEmailHandler } from '../src/jobs/handlers/sendUserEmail';
import { WORKER_LANES } from '../src/worker';
import { activeUser } from '../src/leads/visibility';
import { ymd } from '../src/leads/dates';
import { queueDraftSend, sweepInterruptedSends } from '../src/mail/send';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/**
 * Web-mail release 3, Task 8: Send with a 10-second Undo, Schedule send, Send now and Cancel; the worker sends the
 * Outlook draft and only then files the lead effects and the follow-up task (Review Focus 1, 2, 3 and 5).
 */

const g = vi.hoisted(() => ({
  calls: [] as unknown[][],
  sendError: null as Error | null,
  /** When set, the next updateDraft waits for it (a save in flight). */
  gate: null as Promise<void> | null,
  /** What getDraft answers: the draft as Outlook holds it, or a refusal. */
  draftError: null as Error | null,
}));

const graphImpl: Partial<GraphClient> = {
  async updateDraft(_account, id, d) {
    const gate = g.gate;
    g.gate = null;
    if (gate) await gate;
    g.calls.push(['updateDraft', id, d]);
  },
  async getDraft(_account, id) {
    g.calls.push(['getDraft', id]);
    if (g.draftError) throw g.draftError;
    return { id, conversationId: null, subject: 'Proposal', html: '<p>Hi Ana</p>', to: ['ana@acme.com'], cc: [], bcc: [], lastModified: '2026-11-27T10:00:00Z', attachments: [] };
  },
  async sendDraft(_account, id) {
    g.calls.push(['sendDraft', id]);
    if (g.sendError) throw g.sendError;
  },
};
const graph = fakeGraph(graphImpl);

// A fresh app per test: Send is rate-limited per user (30 a minute), and user ids start again after each reset.
let app: FastifyInstance;
beforeAll(() => {
  process.env.TEST_LOGIN = '1';
});
afterEach(() => app.close());
beforeEach(async () => {
  app = await buildApp({ graph });
  g.calls = [];
  g.sendError = null;
  g.gate = null;
  g.draftError = null;
  await resetDb();
  await seedLookups();
});

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

const sendLane = WORKER_LANES.find((l) => l.name === 'send')!;
const runSend = () => runOnce({ types: [...sendLane.types], handlers: { send_user_email: sendUserEmailHandler }, graph });
/** Every queued send made due now (the Undo window or the scheduled time passed), then run. */
async function jobsDue() {
  await prisma.job.updateMany({ where: { type: 'send_user_email', status: 'queued' }, data: { runAt: new Date(Date.now() - 1000) } });
  while (await runSend());
}
const sent = () => g.calls.filter((c) => c[0] === 'sendDraft').map((c) => c[1]);
const updates = () => g.calls.filter((c) => c[0] === 'updateDraft') as [string, string, DraftFields][];

const personal = (userId: number, address: string, status = 'connected') =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status } });

/** `days` after today in Europe/London. */
const dayAhead = (days: number) => ymd(new Date(Date.parse(`${localNow('Europe/London').day}T00:00:00Z`) + days * 86_400_000))!;

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const ana = await makeContact({ companyId: acme.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@acme.com' });
  const lead = await makeLead({ companyId: acme.id, companyName: 'Acme', contactId: ana.id, assignedToId: rep.id, status: 'New', businessEmail: 'ana@acme.com' });
  const repBox = await personal(rep.id, 'maya@daitpartners.com');
  const carlosBox = await personal(carlos.id, 'carlos@daitpartners.com');
  const adminBox = await personal(admin.id, 'deepak@daitpartners.com');
  const repCookie = await signIn(app, rep);
  const d = await draftOf(rep.id, repBox.id, { leadId: lead.id, companyId: acme.id, contactId: ana.id });
  return { rep, carlos, admin, acme, ana, lead, repBox, carlosBox, adminBox, repCookie, d };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

let n = 0;
/** A CRM draft as POST /mail/drafts makes it (Outlook id D1 for the first one). */
async function draftOf(userId: number, accountId: number, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'drafts', status: 'draft', source: 'crm', fromAddress: 'maya@daitpartners.com', toAddresses: [], subject: '',
      bodyText: '', bodyHtml: '', graphId: n === 1 ? 'D1' : `D${n}`, ...(data as object),
    },
  });
}
beforeEach(() => {
  n = 0;
});

const fields = { to: ['ana@acme.com'], cc: [], bcc: [], subject: 'Proposal', bodyHtml: '<p>Hi Ana</p>' };
const followUp = (f: Fixture, over: Record<string, unknown> = {}) => ({
  date: dayAhead(4), time: '09:00', title: 'Follow up: Proposal', assignedToId: f.rep.id, kind: 'call', priority: 'high', note: 'Ask the CTO',
  updateLead: true, ...over,
});
const row = (id: number) => prisma.emailMessage.findUniqueOrThrow({ where: { id } });
const sendJob = () => prisma.job.findFirst({ where: { type: 'send_user_email' } });
const notes = (userId: number) => prisma.notification.findMany({ where: { userId }, select: { text: true, link: true } });
const listed = async (view: string, cookie: string) =>
  ((await call('GET', `/api/mail?view=${view}&conv=0`, cookie)).json().items as { id: number; scheduledAt: string | null }[]);

describe('Send with Undo (web-mail release 3)', () => {
  it('Send queues the draft 10 s ahead; nothing on the lead yet; the job sends the Outlook draft, then files the lead effects', async () => {
    const f = await setup();
    const before = Date.now();
    const res = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ id: f.d.id, undoUntil: expect.any(String), followUp: { date: dayAhead(4), time: '09:00' } });
    expect(body.sendAt).toBe(body.undoUntil);
    const wait = Date.parse(body.undoUntil) - before;
    expect(wait).toBeGreaterThanOrEqual(10_000);
    expect(wait).toBeLessThan(12_000);
    // Saved to Outlook first: what leaves is what the editor held.
    expect(updates()).toEqual([['updateDraft', 'D1', { subject: 'Proposal', html: '<p>Hi Ana</p>', to: ['ana@acme.com'], cc: [], bcc: [], from: null }]]);
    expect(await row(f.d.id)).toMatchObject({ status: 'queued', folder: 'drafts', scheduledAt: null });
    const job = (await sendJob())!;
    expect(job).toMatchObject({ status: 'queued', maxAttempts: 5 });
    expect(job.runAt.toISOString()).toBe(body.sendAt);
    expect(job.payload).toEqual({ emailMessageId: f.d.id, draft: true, followUp: { ...followUp(f), leadId: f.lead.id } });
    // Audited with the message id only.
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'email_message', entityId: String(f.d.id) } });
    expect(entry.after).toEqual({ emailMessageId: f.d.id });
    // Nothing on the lead until the mail leaves (plan decision 3).
    expect(await prisma.task.count({ where: { origin: 'email_follow_up' } })).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: f.lead.id } })).toBe(0);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).status).toBe('New');
    expect(sent()).toEqual([]);

    await jobsDue();
    expect(sent()).toEqual(['D1']);
    expect(await row(f.d.id)).toMatchObject({ status: 'sent', folder: 'sent', graphId: null, scheduledAt: null, lastError: null });
    expect(await prisma.task.findFirstOrThrow({ where: { origin: 'email_follow_up' } })).toMatchObject({
      leadId: f.lead.id, title: 'Follow up: Proposal', dueTime: '09:00', kind: 'call', durationMinutes: 30, priority: 'high', note: 'Ask the CTO',
      assignedToId: f.rep.id, isDone: false,
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect(ymd(lead.nextFollowUp)).toBe(dayAhead(4));
    expect(lead.status).toBe('Contacted');
    // The email follow-up task stands in for the lead follow-up task (plan decision 6): no second task.
    expect(await prisma.task.count({ where: { leadId: f.lead.id, origin: 'follow_up' } })).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: f.lead.id, title: 'Email sent · Proposal' } })).toBe(1);
    expect(await prisma.auditLog.findFirst({ where: { entityType: 'lead', entityId: String(f.lead.id), after: { path: ['emailFollowUpTaskId'], not: 'null' } } })).toBeTruthy();
    // Sending to yourself as the assignee: no notification.
    expect(await notes(f.rep.id)).toEqual([]);
    // The job is done; running again sends nothing more.
    await jobsDue();
    expect(sent()).toEqual(['D1']);
  });

  it('Undo inside the window: job gone, row back in Drafts, no task, lead untouched', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    const res = await call('POST', `/api/mail/${f.d.id}/unsend`, f.repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: f.d.id, status: 'draft', scheduledAt: null, subject: 'Proposal', bodyHtml: '<p>Hi Ana</p>' });
    expect(await prisma.job.count({ where: { type: 'send_user_email' } })).toBe(0);
    expect(await row(f.d.id)).toMatchObject({ status: 'draft', folder: 'drafts', graphId: 'D1' });
    await jobsDue();
    expect(sent()).toEqual([]);
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: f.lead.id } })).toBe(0);
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).toMatchObject({ status: 'New', nextFollowUp: null });
    expect((await listed('drafts', f.repCookie)).map((i) => i.id)).toEqual([f.d.id]);
    // Nothing left to take back.
    expect((await call('POST', `/api/mail/${f.d.id}/unsend`, f.repCookie)).json()).toEqual({ error: 'already_sent' });
  });

  it('Undo racing the worker: once the job is claimed, Undo is 409 already_sent and the mail is sent exactly once (Review Focus 1)', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    // The worker has claimed the job (running) but not yet the row.
    await prisma.job.updateMany({ where: { type: 'send_user_email' }, data: { status: 'running', lockedAt: new Date() } });
    const res = await call('POST', `/api/mail/${f.d.id}/unsend`, f.repCookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'already_sent' });
    expect((await row(f.d.id)).status).toBe('queued');
    // The worker carries on: sent once, with its lead effects.
    await sendUserEmailHandler((await sendJob()) as Job, { graph });
    expect(sent()).toEqual(['D1']);
    expect(await row(f.d.id)).toMatchObject({ status: 'sent', folder: 'sent' });
    expect(await prisma.task.count({ where: { origin: 'email_follow_up' } })).toBe(1);
  });

  it('Undo and the worker at the same instant: exactly one outcome, never both (Review Focus 1)', async () => {
    for (let i = 0; i < 6; i++) {
      await resetDb();
      await seedLookups();
      g.calls = [];
      n = 0;
      const f = await setup();
      await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
      await prisma.job.updateMany({ where: { type: 'send_user_email' }, data: { runAt: new Date(Date.now() - 1000) } });
      const [undo] = await Promise.all([call('POST', `/api/mail/${f.d.id}/unsend`, f.repCookie), runSend()]);
      const r = await row(f.d.id);
      const tasks = await prisma.task.count({ where: { origin: 'email_follow_up' } });
      const lines = await prisma.leadActivity.count({ where: { leadId: f.lead.id, activityType: 'email' } });
      if (undo.statusCode === 200) {
        expect([sent(), r.status, r.folder, tasks, lines]).toEqual([[], 'draft', 'drafts', 0, 0]);
      } else {
        expect(undo.json()).toEqual({ error: 'already_sent' });
        expect([sent(), r.status, r.folder, tasks, lines]).toEqual([['D1'], 'sent', 'sent', 1, 1]);
      }
    }
  });

  it('a send interrupted after the claim is failed, back in Drafts, notified, never sent again (Review Focus 2)', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    // The worker claimed job and row, then stopped (crash, reload, host sleep) before or after Graph took it.
    await prisma.job.updateMany({ where: { type: 'send_user_email' }, data: { status: 'running', lockedAt: new Date() } });
    await prisma.emailMessage.update({ where: { id: f.d.id }, data: { status: 'sending' } });
    // A running job locked only now is not stale: the periodic sweep leaves it.
    expect(await sweepInterruptedSends()).toBe(0);
    // The worker starts again: no job is running yet, so every running draft send was interrupted.
    expect(await sweepInterruptedSends({ startup: true })).toBe(1);
    await jobsDue();
    expect(sent()).toEqual([]);
    expect(await row(f.d.id)).toMatchObject({ status: 'failed', folder: 'drafts', lastError: 'interrupted_may_have_sent', graphId: 'D1' });
    expect(await notes(f.rep.id)).toEqual([{ text: 'Your email "Proposal" could not be sent', link: '/email?folder=drafts' }]);
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: f.lead.id } })).toBe(0);
    expect((await sendJob())!.status).toBe('done');
    // Listed in Drafts (Failed), not in Scheduled.
    expect((await listed('drafts', f.repCookie)).map((i) => i.id)).toEqual([f.d.id]);
    expect(await listed('scheduled', f.repCookie)).toEqual([]);
    await jobsDue();
    expect(sent()).toEqual([]);
    expect(await notes(f.rep.id)).toHaveLength(1);
  });

  it('a job still queued after a restart sends at its time (the row and job are in the database)', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    // Not due yet: nothing goes before the Undo window ends.
    expect(await runSend()).toBe(false);
    // A worker that claimed the job but stopped before claiming the row: queued again at start, and sent once.
    await prisma.job.updateMany({ where: { type: 'send_user_email' }, data: { status: 'running', lockedAt: new Date() } });
    expect(await sweepInterruptedSends({ startup: true })).toBe(1);
    expect(await runSend()).toBe(true);
    expect(sent()).toEqual(['D1']);
    expect(await row(f.d.id)).toMatchObject({ status: 'sent', folder: 'sent' });
    expect(await runSend()).toBe(false);
  });

  it('scheduled: at must be 1 minute to 365 days ahead; scheduledAt set; Scheduled lists it; Send now moves the job; Cancel returns it to Drafts', async () => {
    const f = await setup();
    const url = `/api/mail/drafts/${f.d.id}/send`;
    for (const ms of [30_000, -60_000, 366 * 86_400_000]) {
      const res = await call('POST', url, f.repCookie, { ...fields, at: new Date(Date.now() + ms).toISOString() });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'schedule_time' });
    }
    expect(await prisma.job.count()).toBe(0);
    expect((await row(f.d.id)).status).toBe('draft');

    const at = new Date(Date.now() + 2 * 86_400_000);
    at.setUTCMilliseconds(0);
    const res = await call('POST', url, f.repCookie, { ...fields, at: at.toISOString() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ undoUntil: null, sendAt: at.toISOString(), followUp: null });
    expect((await row(f.d.id)).scheduledAt?.toISOString()).toBe(at.toISOString());
    expect((await sendJob())!.runAt.toISOString()).toBe(at.toISOString());
    expect(await listed('scheduled', f.repCookie)).toEqual([expect.objectContaining({ id: f.d.id, scheduledAt: at.toISOString() })]);
    expect(await listed('drafts', f.repCookie)).toEqual([]);
    expect(await runSend()).toBe(false);
    // A save on a queued draft is refused before Outlook is touched.
    g.calls = [];
    const save = await call('PATCH', `/api/mail/drafts/${f.d.id}`, f.repCookie, { ...fields, bodyHtml: '<p>Late edit</p>' });
    expect(save.json()).toEqual({ error: 'not_draft' });
    expect(updates()).toEqual([]);

    // Cancel: back in Drafts, nothing queued.
    expect((await call('POST', `/api/mail/${f.d.id}/unsend`, f.repCookie)).statusCode).toBe(200);
    expect(await row(f.d.id)).toMatchObject({ status: 'draft', scheduledAt: null });
    expect(await prisma.job.count()).toBe(0);
    expect((await listed('drafts', f.repCookie)).map((i) => i.id)).toEqual([f.d.id]);

    // Scheduled again, then Send now: due at once, sent by the next run.
    await call('POST', url, f.repCookie, { ...fields, at: at.toISOString() });
    const now = await call('POST', `/api/mail/${f.d.id}/send-now`, f.repCookie);
    expect(now.statusCode).toBe(204);
    expect((await row(f.d.id)).scheduledAt).toBeNull();
    expect((await sendJob())!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await runSend()).toBe(true);
    expect(sent()).toEqual(['D1']);
    expect((await call('POST', `/api/mail/${f.d.id}/send-now`, f.repCookie)).json()).toEqual({ error: 'already_sent' });
    expect((await call('POST', `/api/mail/${f.d.id}/unsend`, f.repCookie)).json()).toEqual({ error: 'already_sent' });
  });

  it('a follow-up before the send instant is 400 follow_up_time; Kolkata 09:00 is stored as 09:00 on the user day (Review Focus 5)', async () => {
    const f = await setup();
    const res = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f, { date: dayAhead(-1) }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'follow_up_time' });
    expect(await prisma.job.count()).toBe(0);
    // Counted from a scheduled send's instant: a follow-up before it is refused too.
    const at = new Date(Date.now() + 10 * 86_400_000).toISOString();
    expect((await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, at, followUp: followUp(f) })).json())
      .toEqual({ error: 'follow_up_time' });

    // 23:30 UTC on 26 Nov is already 05:00 on 27 Nov in Asia/Kolkata.
    await prisma.user.update({ where: { id: f.rep.id }, data: { timezone: 'Asia/Kolkata' } });
    const user = (await activeUser(prisma, f.rep.id))!;
    const now = new Date('2026-11-26T23:30:00Z');
    const fresh = async () => row(f.d.id);
    // 04:00 on the 27th in Kolkata is 22:30 UTC on the 26th: before the send.
    await expect(queueDraftSend(graph, user, await fresh(), DraftSend.parse({ ...fields, followUp: followUp(f, { date: '2026-11-27', time: '04:00' }) }), now))
      .rejects.toMatchObject({ code: 'follow_up_time' });
    const queued = await queueDraftSend(graph, user, await fresh(), DraftSend.parse({ ...fields, followUp: followUp(f, { date: '2026-11-27', time: '09:00' }) }), now);
    expect(queued).toMatchObject({ sendAt: '2026-11-26T23:30:10.000Z', undoUntil: '2026-11-26T23:30:10.000Z', followUp: { date: '2026-11-27', time: '09:00' } });
    await jobsDue();
    const task = await prisma.task.findFirstOrThrow({ where: { origin: 'email_follow_up' } });
    expect([ymd(task.dueDate), task.dueTime]).toEqual(['2026-11-27', '09:00']);
    expect(ymd((await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).nextFollowUp)).toBe('2026-11-27');
  });

  it('a follow-up on a closed lead, or without a lead, is dropped; assigning to someone who cannot see the lead is 400 cannot_assign_hidden', async () => {
    const f = await setup();
    // Someone else, without view_all_leads: 403 forbidden.
    const other = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f, { assignedToId: f.carlos.id }) });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: 'forbidden' });

    // The Administrator's draft on Maya's lead: Carlos cannot see it (400); Maya can, and is notified when it leaves.
    const adminCookie = await signIn(app, f.admin);
    const ad = await draftOf(f.admin.id, f.adminBox.id, { leadId: f.lead.id });
    const hidden = await call('POST', `/api/mail/drafts/${ad.id}/send`, adminCookie, { ...fields, followUp: followUp(f, { assignedToId: f.carlos.id }) });
    expect(hidden.statusCode).toBe(400);
    expect(hidden.json()).toEqual({ error: 'cannot_assign_hidden' });
    const ok = await call('POST', `/api/mail/drafts/${ad.id}/send`, adminCookie, { ...fields, followUp: followUp(f, { assignedToId: f.rep.id, kind: 'followup', priority: 'normal', note: '', updateLead: false }) });
    expect(ok.statusCode).toBe(202);
    await jobsDue();
    expect(await prisma.task.findFirstOrThrow({ where: { origin: 'email_follow_up' } })).toMatchObject({
      assignedToId: f.rep.id, kind: 'followup', durationMinutes: null, priority: 'normal', note: null,
    });
    expect(await notes(f.rep.id)).toEqual([{ text: 'Task assigned to you · Follow up: Proposal', link: '/tasks' }]);
    // Not asked to move the lead's next follow-up.
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).nextFollowUp).toBeNull();

    // A closed lead: plain send, no follow-up.
    await prisma.task.deleteMany();
    await prisma.lead.update({ where: { id: f.lead.id }, data: { status: 'Lost' } });
    const closed = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    expect(closed.json()).toMatchObject({ followUp: null });
    expect((await sendJob())).toBeTruthy();
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'send_user_email', status: 'queued' } })).payload).toEqual({ emailMessageId: f.d.id, draft: true });
    // No lead: plain send too.
    const loose = await draftOf(f.rep.id, f.repBox.id);
    expect((await call('POST', `/api/mail/drafts/${loose.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) })).json()).toMatchObject({ followUp: null });
    await jobsDue();
    expect(await prisma.task.count()).toBe(0);
    expect(await row(loose.id)).toMatchObject({ status: 'sent' });
  });

  it('the draft was deleted in Outlook before a scheduled send: failed draft_gone, no retry, notified (Review Focus 3)', async () => {
    const f = await setup();
    const at = new Date(Date.now() + 86_400_000).toISOString();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, at, followUp: followUp(f) });
    g.sendError = new GraphError('graph_request_failed 404', 404);
    await jobsDue();
    expect(sent()).toEqual(['D1']);
    expect(await row(f.d.id)).toMatchObject({ status: 'failed', folder: 'drafts', lastError: 'draft_gone', scheduledAt: null });
    expect((await sendJob())!).toMatchObject({ status: 'done', attempts: 0 });
    expect(await notes(f.rep.id)).toEqual([{ text: 'Your email "Proposal" could not be sent', link: '/email?folder=drafts' }]);
    expect(await prisma.task.count()).toBe(0);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).status).toBe('New');

    // A draft the sync saw deleted in Outlook (its id dropped): failed draft_gone without asking Graph.
    g.calls = [];
    const d2 = await draftOf(f.rep.id, f.repBox.id, { leadId: f.lead.id });
    await call('POST', `/api/mail/drafts/${d2.id}/send`, f.repCookie, fields);
    await prisma.emailMessage.update({ where: { id: d2.id }, data: { graphId: null } });
    await jobsDue();
    expect(sent()).toEqual([]);
    expect(await row(d2.id)).toMatchObject({ status: 'failed', lastError: 'draft_gone' });
  });

  it('a revoked mailbox fails the send at once (mailbox_needs_reconnect); other errors retry, and the last attempt fails it', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, fields);
    g.sendError = new GraphError('invalid_grant', 401);
    await jobsDue();
    expect(await row(f.d.id)).toMatchObject({ status: 'failed', folder: 'drafts', lastError: 'mailbox_needs_reconnect' });
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: f.repBox.id } })).status).toBe('error');

    await prisma.emailAccount.update({ where: { id: f.repBox.id }, data: { status: 'connected' } });
    await prisma.job.deleteMany();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, fields);
    g.sendError = new GraphError('graph_request_failed 503', 503);
    await jobsDue();
    // Outlook still has it as a draft, so it never left: back in the queue for a retry (Undo / Cancel still take it back).
    expect(g.calls.filter((c) => c[0] === 'getDraft')).toEqual([['getDraft', 'D1']]);
    expect(await row(f.d.id)).toMatchObject({ status: 'queued', lastError: 'graph_request_failed 503' });
    expect((await sendJob())!).toMatchObject({ status: 'queued', attempts: 1 });
    await prisma.job.updateMany({ data: { attempts: 4 } });
    await jobsDue();
    expect(await row(f.d.id)).toMatchObject({ status: 'failed', lastError: 'graph_request_failed 503' });
    expect((await sendJob())!.status).toBe('failed');
  });

  it('the mail has left even when its lead effects fail: the row is Sent, the failure logged without content', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    // New → Contacted cannot be applied (the status is no longer offered): the lead transaction fails.
    await prisma.lookupValue.updateMany({ where: { group: 'lead_status', value: 'Contacted' }, data: { isActive: false } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await jobsDue();
    expect(sent()).toEqual(['D1']);
    expect(await row(f.d.id)).toMatchObject({ status: 'sent', folder: 'sent', graphId: null });
    expect(await prisma.task.count()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(new RegExp(`email_message ${f.d.id}: sent, but its lead effects were not filed`));
    expect(String(warn.mock.calls[0]![0])).not.toContain('Proposal');
    warn.mockRestore();
    expect((await sendJob())!.status).toBe('done');
  });

  it("send, unsend and send-now on another user's message are 403 view_only", async () => {
    const f = await setup();
    const cd = await draftOf(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id });
    const adminCookie = await signIn(app, f.admin);
    for (const [cookie, status] of [[adminCookie, 403], [f.repCookie, 404]] as const) {
      const responses = [
        await call('POST', `/api/mail/drafts/${cd.id}/send`, cookie, fields),
        await call('POST', `/api/mail/${cd.id}/unsend`, cookie),
        await call('POST', `/api/mail/${cd.id}/send-now`, cookie),
      ];
      expect(responses.map((r) => r.statusCode)).toEqual([status, status, status]);
      if (status === 403) expect(responses.map((r) => r.json())).toEqual(Array(3).fill({ error: 'view_only' }));
    }
    expect(g.calls).toEqual([]);
    expect(await prisma.job.count()).toBe(0);
  });

  it('no recipients: 400 no_recipients', async () => {
    const f = await setup();
    const res = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, to: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'no_recipients' });
    expect(await prisma.job.count()).toBe(0);
    expect((await row(f.d.id)).status).toBe('draft');
    // Bcc alone is enough.
    expect((await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, to: [], bcc: ['ana@acme.com'] })).statusCode).toBe(202);
  });

  it('a draft of a mailbox since replaced is 409 mailbox_changed and Outlook is not called (Task 6 review Minor 4)', async () => {
    const f = await setup();
    await prisma.emailAccount.update({ where: { id: f.repBox.id }, data: { status: 'disconnected', userId: null } });
    const fresh = await personal(f.rep.id, 'maya.new@daitpartners.com');
    const res = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, fields);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'mailbox_changed' });
    expect(g.calls).toEqual([]);
    expect(await prisma.job.count()).toBe(0);
    expect(fresh.id).not.toBe(f.repBox.id);
  });

  it('a message part over the cap is refused 413 message_too_long and nothing is queued (Task 6 review Minor 5)', async () => {
    const f = await setup();
    const res = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, bodyHtml: `<p>${'x'.repeat(200_001)}</p>` });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'message_too_long' });
    expect(g.calls).toEqual([]);
    expect(await prisma.job.count()).toBe(0);
    // At the cap, with a quote of the same size, it is saved and queued (the worker sends the Outlook draft as is).
    await prisma.emailMessage.update({ where: { id: f.d.id }, data: { quotedHtml: `<div>${'q'.repeat(199_000)}</div>` } });
    const ok = await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, bodyHtml: `<p>${'x'.repeat(199_000)}</p>` });
    expect(ok.statusCode).toBe(202);
    expect(updates()[0]![2].html.length).toBeGreaterThan(398_000);
    await jobsDue();
    expect(sent()).toEqual(['D1']);
  });

  it('a save in flight and Send never overlap: Send waits, then saves its own content; a save after Send is 409 (Task 6 review Minor 3)', async () => {
    const f = await setup();
    let release!: () => void;
    g.gate = new Promise((r) => { release = r; });
    const saving = call('PATCH', `/api/mail/drafts/${f.d.id}`, f.repCookie, { ...fields, bodyHtml: '<p>Older auto-save</p>' });
    await new Promise((r) => setTimeout(r, 50));
    const sending = call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, fields);
    await new Promise((r) => setTimeout(r, 50));
    // Send has not touched Outlook or the row while the save is in flight.
    expect(updates()).toEqual([]);
    expect((await row(f.d.id)).status).toBe('draft');
    release();
    const [save, send] = await Promise.all([saving, sending]);
    expect(save.statusCode).toBe(200);
    expect(send.statusCode).toBe(202);
    expect(updates().map((u) => u[2].html)).toEqual(['<p>Older auto-save</p>', '<p>Hi Ana</p>']);
    expect((await row(f.d.id)).bodyHtml).toBe('<p>Hi Ana</p>');
    const late = await call('PATCH', `/api/mail/drafts/${f.d.id}`, f.repCookie, { ...fields, bodyHtml: '<p>Too late</p>' });
    expect(late.json()).toEqual({ error: 'not_draft' });
    expect(updates()).toHaveLength(2);
  });

  it('an error after Microsoft may have taken the mail: Outlook is asked first; gone or no longer a draft is filed as sent once, unknown is Failed, never resent (fix round 1)', async () => {
    const f = await setup();
    // Timed out, but Outlook no longer has the draft: it left. Filed as sent with its lead effects, once.
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    g.sendError = new Error('The operation was aborted due to timeout');
    g.draftError = new GraphError('graph_request_failed 404', 404);
    await jobsDue();
    expect(sent()).toEqual(['D1']);
    expect(await row(f.d.id)).toMatchObject({ status: 'sent', folder: 'sent', graphId: null });
    expect((await sendJob())!).toMatchObject({ status: 'done', attempts: 0 });
    expect(await prisma.task.count({ where: { origin: 'email_follow_up' } })).toBe(1);
    expect(await prisma.leadActivity.count({ where: { leadId: f.lead.id, activityType: 'email' } })).toBe(1);
    expect(await notes(f.rep.id)).toEqual([]);

    // A 5xx, and Outlook has it as sent (getDraft: not a draft any more): sent too.
    const d2 = await draftOf(f.rep.id, f.repBox.id);
    await call('POST', `/api/mail/drafts/${d2.id}/send`, f.repCookie, fields);
    g.sendError = new GraphError('graph_request_failed 502', 502);
    g.draftError = new GraphError('not_a_draft', 409);
    await jobsDue();
    expect(await row(d2.id)).toMatchObject({ status: 'sent', folder: 'sent' });

    // Outlook cannot be asked either: Failed (may have sent), notified, and the job is not retried.
    const d3 = await draftOf(f.rep.id, f.repBox.id, { subject: '' });
    await call('POST', `/api/mail/drafts/${d3.id}/send`, f.repCookie, { ...fields, subject: '' });
    g.draftError = new GraphError('graph_request_failed 503', 503);
    g.calls = [];
    await jobsDue();
    expect(sent()).toEqual([d3.graphId]);
    expect(await row(d3.id)).toMatchObject({ status: 'failed', folder: 'drafts', lastError: 'interrupted_may_have_sent' });
    expect((await prisma.job.findFirstOrThrow({ where: { payload: { path: ['emailMessageId'], equals: d3.id } } }))).toMatchObject({ status: 'done', attempts: 0 });
    // An empty subject reads "(no subject)".
    expect(await notes(f.rep.id)).toEqual([{ text: 'Your email "(no subject)" could not be sent', link: '/email?folder=drafts' }]);
    await jobsDue();
    expect(sent()).toEqual([d3.graphId]);
  });

  it('Undo after the sweep queued an interrupted send again is 409 already_sent; the worker still Fails and notifies it (fix round 1)', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, fields);
    await prisma.job.updateMany({ where: { type: 'send_user_email' }, data: { status: 'running', lockedAt: new Date() } });
    await prisma.emailMessage.update({ where: { id: f.d.id }, data: { status: 'sending' } });
    expect(await sweepInterruptedSends({ startup: true })).toBe(1);
    const undo = await call('POST', `/api/mail/${f.d.id}/unsend`, f.repCookie);
    expect(undo.statusCode).toBe(409);
    expect(undo.json()).toEqual({ error: 'already_sent' });
    // The job was not deleted (the transaction rolled back).
    expect((await sendJob())!.status).toBe('queued');
    expect((await row(f.d.id)).status).toBe('sending');
    await jobsDue();
    expect(sent()).toEqual([]);
    expect(await row(f.d.id)).toMatchObject({ status: 'failed', folder: 'drafts', lastError: 'interrupted_may_have_sent' });
    expect(await notes(f.rep.id)).toEqual([{ text: 'Your email "Proposal" could not be sent', link: '/email?folder=drafts' }]);
  });

  it('a lead closed between Send and the mail leaving gets no follow-up task (plan decision 5; fix round 1)', async () => {
    const f = await setup();
    await call('POST', `/api/mail/drafts/${f.d.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    await prisma.lead.update({ where: { id: f.lead.id }, data: { status: 'Lost' } });
    await jobsDue();
    expect(sent()).toEqual(['D1']);
    expect(await prisma.task.count()).toBe(0);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect([lead.status, lead.nextFollowUp]).toEqual(['Lost', null]);
    // The mail still left on the lead: its Email sent line is there.
    expect(await prisma.leadActivity.count({ where: { leadId: f.lead.id, title: 'Email sent · Proposal' } })).toBe(1);
    // Archived since Send: no follow-up either.
    await prisma.lead.update({ where: { id: f.lead.id }, data: { status: 'Contacted' } });
    const d2 = await draftOf(f.rep.id, f.repBox.id, { leadId: f.lead.id });
    await call('POST', `/api/mail/drafts/${d2.id}/send`, f.repCookie, { ...fields, followUp: followUp(f) });
    expect(((await prisma.job.findFirstOrThrow({ where: { status: 'queued' } })).payload as { followUp?: unknown }).followUp).toBeTruthy();
    await prisma.lead.update({ where: { id: f.lead.id }, data: { archivedAt: new Date() } });
    await jobsDue();
    expect(await row(d2.id)).toMatchObject({ status: 'sent' });
    expect(await prisma.task.count()).toBe(0);
  });

  it('a draft made in Outlook, scheduled from the CRM: listed in Scheduled, Cancel and Send now work, and it is sent (fix round 1)', async () => {
    const f = await setup();
    const od = await draftOf(f.rep.id, f.repBox.id, { source: 'sync', subject: 'Proposal', toAddresses: ['ana@acme.com'], leadId: f.lead.id });
    const at = new Date(Date.now() + 86_400_000);
    at.setUTCMilliseconds(0);
    expect((await call('POST', `/api/mail/drafts/${od.id}/send`, f.repCookie, { ...fields, at: at.toISOString() })).statusCode).toBe(202);
    expect(await listed('scheduled', f.repCookie)).toEqual([expect.objectContaining({ id: od.id, scheduledAt: at.toISOString() })]);
    expect(await listed('drafts', f.repCookie)).toEqual([expect.objectContaining({ id: f.d.id })]);
    // Cancel: back in Drafts (opened fresh from Outlook, as any draft made there).
    const cancel = await call('POST', `/api/mail/${od.id}/unsend`, f.repCookie);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toMatchObject({ id: od.id, status: 'draft' });
    expect(await listed('scheduled', f.repCookie)).toEqual([]);
    await call('POST', `/api/mail/drafts/${od.id}/send`, f.repCookie, { ...fields, at: at.toISOString() });
    expect((await call('POST', `/api/mail/${od.id}/send-now`, f.repCookie)).statusCode).toBe(204);
    expect(await runSend()).toBe(true);
    expect(sent()).toEqual([od.graphId]);
    expect(await row(od.id)).toMatchObject({ status: 'sent', folder: 'sent', graphId: null, source: 'sync' });
  });
});
