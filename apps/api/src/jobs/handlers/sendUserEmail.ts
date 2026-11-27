import type { EmailAccount, EmailMessage, Job, Prisma } from '@prisma/client';
import { TASK_DURATION, isClosedStatus } from '@dait-crm/shared';
import { prisma } from '../../db.js';
import { audit } from '../../audit.js';
import { errorMessage } from '../queue.js';
import { GraphError, isAuthFailure } from '../../graph/client.js';
import { dateOnly, ymd } from '../../leads/dates.js';
import { notifyUser } from '../../leads/notify.js';
import { syncFollowUpTask } from '../../leads/service.js';
import { canUserSeeLead } from '../../leads/visibility.js';
import { lockLeads } from '../../routes/leads.js';
import { recordOnLead } from '../../mail/outgoing.js';
import type { SendUserEmailPayload } from '../types.js';
import type { JobContext } from '../runner.js';
import { onQuotationSendFailed, onQuotationSent } from '../../quotations/send.js';
import { textToHtml } from '../../mail/html.js';
import { quoteHeader } from '../../mail/drafts.js';

/**
 * A message that will not be sent: marked `failed`, and its "Email sent" history line removed (it never left; the
 * sender still sees it as Failed in their Emails tab). A quotation it was sending leaves "Sending…" (release 3A).
 */
async function failMessage(id: number, lastError: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.emailMessage.update({ where: { id }, data: { status: 'failed', lastError } });
    await tx.leadActivity.deleteMany({ where: { relatedType: 'email_message', relatedId: id } });
    await onQuotationSendFailed(tx, id, lastError === INTERRUPTED ? 'may_have_sent' : 'failed');
  });
}

const INTERRUPTED = 'interrupted_may_have_sent';

/** A queued reply's Graph call besides a plain reply (SendUserEmailPayload.replyMode). */
const REPLY_MODES: readonly unknown[] = ['replyAll', 'forward'];

/**
 * A forward of a message only the CRM has (no Graph id, so Graph forward cannot add it): the user's text, then the
 * original under a "Forwarded message" header (quoteHeader: From, Sent in the sender's time zone, To, Subject) and its
 * stored, already sanitised HTML.
 */
function withForwarded(html: string, text: string, original: EmailMessage, timezone: string): { html: string; text: string } {
  const header = `---------- Forwarded message ---------\n${quoteHeader(original, timezone)}`;
  return {
    html: `${html}<br>${textToHtml(header)}<br>${original.bodyHtml || textToHtml(original.bodyText)}`,
    text: `${text}\n\n${header}\n\n${original.bodyText}`,
  };
}

/**
 * Release 3A: the send effects of the quotation this message sent, in their own transaction after the message is
 * marked sent (the email has left whatever happens here). A failure is retried with the job — a later run finds the
 * message sent and the quotation still "Sending…" and applies them then, once (onQuotationSent re-checks under its
 * lock). On the last attempt the quotation is released with a history line and a notice instead of staying stuck.
 */
async function settleQuotation(msg: EmailMessage, quotation: NonNullable<SendUserEmailPayload['quotation']>, lastAttempt: boolean): Promise<void> {
  try {
    await prisma.$transaction((tx) => onQuotationSent(tx, msg, quotation.snapshot));
  } catch (err) {
    if (lastAttempt) await prisma.$transaction((tx) => onQuotationSendFailed(tx, msg.id, 'not_recorded'));
    throw err;
  }
}

type Tx = Prisma.TransactionClient;
type Queued = EmailMessage & { account: EmailAccount | null; user: { timezone: string } };

/**
 * A draft send that will not happen (web-mail release 3, plan decision 18): the row is Failed with `lastError`, stays
 * in folder `drafts` (so Drafts lists it, marked Failed) and the sender is notified. The notification names the
 * sender's own subject and is shown only to them. Only a row still queued or sending is failed (and notified) once.
 */
async function failDraft(msg: Queued, lastError: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.emailMessage.updateMany({
      where: { id: msg.id, status: { in: ['queued', 'sending'] } },
      data: { status: 'failed', lastError, scheduledAt: null },
    });
    if (count > 0) await notifyUser(tx, msg.userId, `Your email "${msg.subject}" could not be sent`, null, '/email?folder=drafts');
  });
}

/** The row of a draft that left: Sent, now; its draft id dropped (the Sent Items copy has a new one, claimed by the sync). */
async function markDraftSent(db: Tx | typeof prisma, msg: Queued): Promise<void> {
  await db.emailMessage.update({
    where: { id: msg.id },
    data: { status: 'sent', folder: 'sent', occurredAt: new Date(), scheduledAt: null, lastError: null },
  });
  await db.emailMessage.updateMany({ where: { id: msg.id, graphId: msg.graphId }, data: { graphId: null } });
}

/**
 * What a sent draft files on its lead (plan decision 3), when the lead still exists and the sender can still see it:
 * the "Email sent" line and New / Not Contacted → Contacted (recordOnLead), then the follow-up asked for — the task
 * (assigned as asked when that user can still see the lead, else to the sender; the assignee notified when not the
 * sender) and, when asked and the lead is open, the lead's next follow-up on that day (the task stands in for the lead
 * follow-up task: syncFollowUpTask).
 */
async function fileOnLead(tx: Tx, msg: Queued, followUp: SendUserEmailPayload['followUp']): Promise<void> {
  if (msg.leadId === null) return;
  await lockLeads(tx, [msg.leadId]);
  const lead = await tx.lead.findUnique({ where: { id: msg.leadId } });
  if (!lead || !(await canUserSeeLead(tx, msg.userId, lead.id))) return;
  await recordOnLead(tx, { id: msg.userId, timezone: msg.user.timezone }, lead, msg, msg.subject);
  if (!followUp || followUp.leadId !== lead.id) return;

  const current = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
  const assignedToId = (await canUserSeeLead(tx, followUp.assignedToId, lead.id)) ? followUp.assignedToId : msg.userId;
  const task = await tx.task.create({
    data: {
      leadId: lead.id, origin: 'email_follow_up', title: followUp.title, dueDate: dateOnly(followUp.date), dueTime: followUp.time,
      kind: followUp.kind, durationMinutes: followUp.kind === 'followup' ? null : TASK_DURATION[followUp.kind],
      priority: followUp.priority, note: followUp.note || null, assignedToId,
    },
  });
  if (assignedToId !== msg.userId) await notifyUser(tx, assignedToId, `Task assigned to you · ${task.title}`, null, '/tasks');
  await audit(tx, { entityType: 'task', entityId: task.id, action: 'create', userId: msg.userId, after: { origin: task.origin, leadId: lead.id, emailMessageId: msg.id } });
  if (followUp.updateLead && !current.archivedAt && !isClosedStatus(current.status)) {
    const updated = await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUp: dateOnly(followUp.date) } });
    await syncFollowUpTask(tx, updated);
    await audit(tx, {
      entityType: 'lead', entityId: lead.id, action: 'update', userId: msg.userId,
      before: { nextFollowUp: ymd(current.nextFollowUp) }, after: { nextFollowUp: followUp.date, emailFollowUpTaskId: task.id },
    });
  }
}

/**
 * Sends a queued Outlook draft (web-mail release 3): the same claim as other sends (`queued` → `sending`; a row found
 * still `sending` was interrupted mid-send and is Failed, never resent), only from the sender's own connected mailbox,
 * then Graph send on the draft. Afterwards the row is Sent and the lead effects filed in one transaction; if that
 * transaction fails the mail has still left, so the row is marked Sent on its own (best effort) and the failure logged
 * with the message id only. A revoked mailbox or a draft gone from Outlook (404) fails it at once, never retried;
 * other errors put it back in the queue, and the last attempt fails it. A failure stays in Drafts and is notified.
 */
async function sendDraftMessage(msg: Queued, ctx: JobContext, lastAttempt: boolean, followUp: SendUserEmailPayload['followUp']): Promise<void> {
  if (msg.status === 'sending') return failDraft(msg, INTERRUPTED);
  if (msg.status !== 'queued' || msg.folder !== 'drafts') return; // taken back, sent or failed
  const account = msg.account;
  if (!account || account.kind !== 'personal' || account.status !== 'connected' || account.userId !== msg.userId) {
    return failDraft(msg, 'mailbox_not_connected');
  }
  // Deleted in Outlook (the sync dropped its id): nothing to send.
  if (!msg.graphId) return failDraft(msg, 'draft_gone');
  const graphId = msg.graphId;
  const claimed = await prisma.emailMessage.updateMany({ where: { id: msg.id, status: 'queued' }, data: { status: 'sending' } });
  if (claimed.count === 0) return; // taken back or taken by another run

  try {
    await ctx.graph.sendDraft(account, graphId);
  } catch (err) {
    const lastError = errorMessage(err);
    if (isAuthFailure(err)) {
      await prisma.emailAccount.updateMany({
        where: { id: account.id, status: 'connected', refreshTokenEnc: account.refreshTokenEnc },
        data: { status: 'error', lastError },
      });
      return failDraft(msg, 'mailbox_needs_reconnect');
    }
    // Deleted (or sent) in Outlook before its time: Failed, never retried (Review Focus 3).
    if (err instanceof GraphError && err.status === 404) return failDraft(msg, 'draft_gone');
    if (lastAttempt) await failDraft(msg, lastError);
    else await prisma.emailMessage.updateMany({ where: { id: msg.id, status: 'sending' }, data: { status: 'queued', lastError } });
    throw err;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await markDraftSent(tx, msg);
      await fileOnLead(tx, msg, followUp);
    });
  } catch (err) {
    console.warn(`send_user_email: email_message ${msg.id}: sent, but its lead effects were not filed (${err instanceof Error ? err.name : 'error'})`);
    // The mail has left: never leave it `sending` (a retry would call it interrupted). If even this fails, the retry does.
    await markDraftSent(prisma, msg);
  }
}

/**
 * Sends a message a user wrote in the CRM through their own mailbox (Graph sendMail, or reply / replyAll / forward on
 * the original in that mailbox, so it is also in Outlook's Sent Items). The message is claimed first (`queued` →
 * `sending`), so it is never handed to Microsoft twice: a message found still `sending` was interrupted mid-send and is
 * failed rather than resent. A revoked mailbox fails it at once;
 * other errors put it back in the queue, and the last attempt fails it.
 */
export async function sendUserEmailHandler(job: Job, ctx: JobContext): Promise<void> {
  const { emailMessageId, attachments, quotation, replyMode, draft, followUp } = job.payload as unknown as SendUserEmailPayload;
  const msg = await prisma.emailMessage.findUnique({ where: { id: emailMessageId }, include: { account: true, user: { select: { timezone: true } } } });
  if (!msg) return;
  const lastAttempt = job.attempts + 1 >= job.maxAttempts;
  // Web-mail release 3: an Outlook draft the user sent (or scheduled) from the CRM.
  if (draft) return sendDraftMessage(msg, ctx, lastAttempt, followUp);
  if (msg.status === 'sending') return failMessage(msg.id, INTERRUPTED);
  // Sent, but the quotation's effects did not go through on that run (settleQuotation): apply them now.
  if (msg.status === 'sent' && quotation) return settleQuotation(msg, quotation, lastAttempt);
  if (msg.status !== 'queued') return; // already sent or failed
  // Only the Graph calls a reply can be (the payload names the call, ctx.graph[replyMode]): anything else fails the
  // message and Microsoft is never asked.
  if (replyMode !== undefined && !REPLY_MODES.includes(replyMode)) return failMessage(msg.id, 'invalid_reply_mode');
  const account = msg.account;
  // Only the sender's own, connected personal mailbox.
  if (!account || account.kind !== 'personal' || account.status !== 'connected' || account.userId !== msg.userId) {
    return failMessage(msg.id, 'mailbox_not_connected');
  }
  const claimed = await prisma.emailMessage.updateMany({ where: { id: msg.id, status: 'queued' }, data: { status: 'sending' } });
  if (claimed.count === 0) return; // another run took it

  // A reply, reply all or forward goes through Graph on the original (reply / replyAll / forward), so it stays in the
  // conversation in Outlook too and a forward carries the original's attachments.
  const original = msg.replyToId ? await prisma.emailMessage.findUnique({ where: { id: msg.replyToId } }) : null;
  // The HTML stored when it was queued: a formatted message's sanitised HTML, or its plain text as simple HTML.
  const html = msg.bodyHtml || textToHtml(msg.bodyText);
  try {
    const cc = msg.ccAddresses as string[];
    if (original?.graphId && original.userId === msg.userId) {
      await ctx.graph[replyMode ?? 'reply'](account, original.graphId, { to: msg.toAddresses as string[], ...(cc.length ? { cc } : {}), html });
    } else {
      const body = replyMode === 'forward' && original ? withForwarded(html, msg.bodyText, original, msg.user.timezone) : { html, text: msg.bodyText };
      await ctx.graph.sendMail(account, {
        to: msg.toAddresses as string[],
        ...(cc.length ? { cc } : {}),
        subject: msg.subject,
        ...body,
        ...(attachments?.length ? { attachments } : {}),
      });
    }
  } catch (err) {
    const lastError = errorMessage(err);
    if (isAuthFailure(err)) {
      // Only the connection this send used: a mailbox disconnected or reconnected meanwhile keeps its new state.
      await prisma.emailAccount.updateMany({
        where: { id: account.id, status: 'connected', refreshTokenEnc: account.refreshTokenEnc },
        data: { status: 'error', lastError },
      });
      return failMessage(msg.id, 'mailbox_needs_reconnect');
    }
    if (lastAttempt) {
      await failMessage(msg.id, lastError);
    } else {
      await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: 'queued', lastError } });
    }
    throw err;
  }
  try {
    await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: 'sent', lastError: null, occurredAt: new Date() } });
  } catch (err) {
    // A retry would find it `sending` and fail it; on the last attempt there is no retry, so fail it now (best effort)
    // rather than leave the message, and a quotation it sends, stuck.
    if (lastAttempt) await failMessage(msg.id, INTERRUPTED).catch(() => undefined);
    throw err;
  }
  // Release 3A: the quotation's send effects, only now that Microsoft has accepted the message.
  if (quotation) await settleQuotation(msg, quotation, lastAttempt);
}
