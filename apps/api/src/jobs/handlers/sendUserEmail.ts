import type { EmailMessage, Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { errorMessage } from '../queue.js';
import { isAuthFailure } from '../../graph/client.js';
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

/**
 * Sends a message a user wrote in the CRM through their own mailbox (Graph sendMail, or reply / replyAll / forward on
 * the original in that mailbox, so it is also in Outlook's Sent Items). The message is claimed first (`queued` →
 * `sending`), so it is never handed to Microsoft twice: a message found still `sending` was interrupted mid-send and is
 * failed rather than resent. A revoked mailbox fails it at once;
 * other errors put it back in the queue, and the last attempt fails it.
 */
export async function sendUserEmailHandler(job: Job, ctx: JobContext): Promise<void> {
  const { emailMessageId, attachments, quotation, replyMode } = job.payload as unknown as SendUserEmailPayload;
  const msg = await prisma.emailMessage.findUnique({ where: { id: emailMessageId }, include: { account: true, user: { select: { timezone: true } } } });
  if (!msg) return;
  const lastAttempt = job.attempts + 1 >= job.maxAttempts;
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
