import type { EmailMessage, Prisma } from '@prisma/client';
import { UNDO_SEND_SECONDS, can, instantIn, isClosedStatus, type DraftSend } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import type { GraphClient } from '../graph/client.js';
import type { AuthUser } from '../plugins/auth.js';
import type { SendUserEmailPayload } from '../jobs/types.js';
import { enqueue, staleRunningWhere } from '../jobs/queue.js';
import { RuleError } from '../leads/service.js';
import { canSeeLead, canUserSeeLead } from '../leads/visibility.js';
import { DraftError, openDraft, saveDraft, type DraftView } from './drafts.js';

/**
 * Send, Undo send and Schedule send of the user's own Outlook draft (web-mail release 3, plan decisions 1, 3, 4, 5, 17,
 * 20). Send saves the draft, marks its row `queued` (it stays in folder `drafts`, so Drafts leaves it out and Scheduled
 * lists it) and queues a `send_user_email` job for the end of the Undo window or the scheduled time; the worker sends
 * the Outlook draft then, and only then files the lead effects and the follow-up task. Undo, Cancel and Edit delete the
 * still-queued job (once the worker has claimed it they are 409 already_sent: the job row's own lock decides, never
 * both); Send now moves it to now. Nothing about the mail (subject, body, addresses) is audited or logged.
 */

/** A scheduled send is at least this far ahead… */
export const SCHEDULE_MIN_MS = 60_000;
/** …and at most this many days ahead. */
export const SCHEDULE_MAX_DAYS = 365;

const DAY_MS = 86_400_000;
/** Retries of a draft send (2, 4, 8, 16 minutes) before it is Failed, as other user sends. */
const SEND_ATTEMPTS = 5;
/** Statuses Send takes a draft from: a draft, or a send that failed. */
const SENDABLE = ['draft', 'failed'];

/** The queued `send_user_email` job of message `id` (still waiting: not yet claimed by the worker). */
const queuedJobOf = (id: number): Prisma.JobWhereInput => ({
  type: 'send_user_email', status: 'queued', payload: { path: ['emailMessageId'], equals: id },
});

export interface QueuedSend {
  id: number;
  sendAt: string;
  /** The end of the Undo window (a send now); null for a scheduled send (Cancel instead). */
  undoUntil: string | null;
  /** The follow-up that will be filed when the mail leaves; null when none was asked or it was dropped. */
  followUp: { date: string; time: string } | null;
}

/**
 * Sends the caller's own draft: saved first (saveDraft, so what leaves is what the editor held), then at least one
 * recipient (400 no_recipients). `at` null: sent after the Undo window (UNDO_SEND_SECONDS); `at` set: 1 minute to 365
 * days ahead (400 schedule_time). A follow-up needs the draft's lead, visible and open (else it is dropped and null
 * answered), a day and time (in the sender's zone) after the send instant (400 follow_up_time), and an assignee who
 * can see the lead (400 cannot_assign_hidden; someone else only with view_all_leads, else 403 forbidden). The row
 * becomes `queued` and the job is queued in one transaction; audited with the message id only.
 */
export async function queueDraftSend(graph: GraphClient, user: AuthUser, m: EmailMessage, body: DraftSend, now: Date = new Date()): Promise<QueuedSend> {
  await saveDraft(graph, user, m, body);
  const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } });
  const recipients = [row.toAddresses, row.ccAddresses, row.bccAddresses].flatMap((list) => list as string[]);
  if (recipients.length === 0) throw new DraftError('no_recipients', 400);

  let sendAt: Date;
  if (body.at === null) {
    sendAt = new Date(now.getTime() + UNDO_SEND_SECONDS * 1000);
  } else {
    sendAt = new Date(body.at);
    const ahead = sendAt.getTime() - now.getTime();
    if (!(ahead >= SCHEDULE_MIN_MS && ahead <= SCHEDULE_MAX_DAYS * DAY_MS)) throw new DraftError('schedule_time', 400);
  }

  let followUp: SendUserEmailPayload['followUp'];
  const asked = body.followUp;
  if (asked && row.leadId !== null) {
    const lead = await prisma.lead.findUnique({ where: { id: row.leadId }, select: { id: true, status: true, archivedAt: true } });
    // Only an open lead the sender can see (plan decision 5); otherwise it is a plain send.
    if (lead && !lead.archivedAt && !isClosedStatus(lead.status) && (await canSeeLead(prisma, user, lead.id))) {
      if (instantIn(asked.date, asked.time, user.timezone).getTime() <= sendAt.getTime()) throw new DraftError('follow_up_time', 400);
      if (asked.assignedToId !== user.id && !can(user.role, 'view_all_leads')) throw new RuleError('forbidden');
      if (!(await canUserSeeLead(prisma, asked.assignedToId, lead.id))) throw new RuleError('cannot_assign_hidden');
      followUp = { ...asked, leadId: lead.id };
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM email_messages WHERE id = ${m.id} FOR UPDATE`;
    const queued = await tx.emailMessage.updateMany({
      where: { id: m.id, userId: user.id, folder: 'drafts', status: { in: SENDABLE } },
      data: { status: 'queued', scheduledAt: body.at === null ? null : sendAt, lastError: null },
    });
    // Sent, discarded or queued meanwhile (another tab): nothing is queued twice.
    if (queued.count === 0) throw new DraftError('not_draft', 409);
    const payload: SendUserEmailPayload = { emailMessageId: m.id, draft: true, ...(followUp ? { followUp } : {}) };
    await enqueue(tx, 'send_user_email', payload, { runAt: sendAt, maxAttempts: SEND_ATTEMPTS });
    await audit(tx, { entityType: 'email_message', entityId: m.id, action: 'update', userId: user.id, after: { emailMessageId: m.id } });
  });
  return {
    id: m.id,
    sendAt: sendAt.toISOString(),
    undoUntil: body.at === null ? sendAt.toISOString() : null,
    followUp: followUp ? { date: followUp.date, time: followUp.time } : null,
  };
}

/**
 * Takes a queued send back (Undo, a scheduled send's Cancel and Edit): its still-queued job is deleted and the row is
 * a draft again, in one transaction. No queued job (the worker claimed it, or it has left), or a row no longer queued,
 * is 409 already_sent, and job and row are left as the worker has them. Nothing else to undo: the lead effects only happen when the mail leaves.
 */
export async function unsend(graph: GraphClient, user: AuthUser, m: EmailMessage): Promise<DraftView> {
  if (m.folder !== 'drafts') throw new DraftError('already_sent', 409);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.job.deleteMany({ where: queuedJobOf(m.id) });
    if (count === 0) throw new DraftError('already_sent', 409);
    const back = await tx.emailMessage.updateMany({
      where: { id: m.id, userId: user.id, status: 'queued' },
      data: { status: 'draft', scheduledAt: null, lastError: null },
    });
    // The row is not waiting (left `sending` by an interrupted run whose job the sweep queued again): the job stays, so
    // the worker still Fails and notifies it (Review Focus 2).
    if (back.count === 0) throw new DraftError('already_sent', 409);
  });
  return openDraft(graph, user, await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } }));
}

/** A scheduled send goes now: its queued job is due at once (none queued → 409 already_sent) and the row loses its time. */
export async function sendNow(user: AuthUser, m: EmailMessage): Promise<void> {
  if (m.folder !== 'drafts') throw new DraftError('already_sent', 409);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.job.updateMany({ where: queuedJobOf(m.id), data: { runAt: new Date() } });
    if (count === 0) throw new DraftError('already_sent', 409);
    await tx.emailMessage.updateMany({ where: { id: m.id, userId: user.id, status: 'queued' }, data: { scheduledAt: null } });
  });
}

/**
 * Draft sends whose job a worker stopped holding (Review Focus 2): at worker start every `running` draft send was
 * interrupted (no job is running yet), later only those locked past STALE_AFTER_MS. Each is queued again, so the
 * handler decides: a row still `queued` was never handed to Microsoft and is sent; a row left `sending` may have left
 * and is Failed (interrupted_may_have_sent), back in Drafts, with a notification — never sent again.
 */
export async function sweepInterruptedSends(opts: { startup?: boolean } = {}): Promise<number> {
  const { count } = await prisma.job.updateMany({
    where: {
      type: 'send_user_email', payload: { path: ['draft'], equals: true },
      ...(opts.startup ? { status: 'running' } : staleRunningWhere()),
    },
    data: { status: 'queued', lockedAt: null, runAt: new Date() },
  });
  return count;
}
