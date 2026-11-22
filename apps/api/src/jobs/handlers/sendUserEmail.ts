import type { Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { errorMessage } from '../queue.js';
import { isAuthFailure } from '../../graph/client.js';
import type { SendUserEmailPayload } from '../types.js';
import type { JobContext } from '../runner.js';
import { onQuotationSendFailed, onQuotationSent } from '../../quotations/send.js';

/** Plain text as simple HTML: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<div>${escaped.replace(/\r?\n/g, '<br>')}</div>`;
}

/**
 * A message that will not be sent: marked `failed`, and its "Email sent" history line removed (it never left; the
 * sender still sees it as Failed in their Emails tab). A quotation it was sending leaves "Sending…" (release 3A).
 */
async function failMessage(id: number, lastError: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.emailMessage.update({ where: { id }, data: { status: 'failed', lastError } });
    await tx.leadActivity.deleteMany({ where: { relatedType: 'email_message', relatedId: id } });
    await onQuotationSendFailed(tx, id);
  });
}

/**
 * Sends a message a user wrote in the CRM through their own mailbox (Graph sendMail, so it is also in Outlook's Sent
 * Items). The message is claimed first (`queued` → `sending`), so it is never handed to Microsoft twice: a message
 * found still `sending` was interrupted mid-send and is failed rather than resent. A revoked mailbox fails it at once;
 * other errors put it back in the queue, and the last attempt fails it.
 */
export async function sendUserEmailHandler(job: Job, ctx: JobContext): Promise<void> {
  const { emailMessageId, attachments, quotation } = job.payload as unknown as SendUserEmailPayload;
  const msg = await prisma.emailMessage.findUnique({ where: { id: emailMessageId }, include: { account: true } });
  if (!msg) return;
  if (msg.status === 'sending') return failMessage(msg.id, 'interrupted_may_have_sent');
  if (msg.status !== 'queued') return; // already sent or failed
  const account = msg.account;
  // Only the sender's own, connected personal mailbox.
  if (!account || account.kind !== 'personal' || account.status !== 'connected' || account.userId !== msg.userId) {
    return failMessage(msg.id, 'mailbox_not_connected');
  }
  const claimed = await prisma.emailMessage.updateMany({ where: { id: msg.id, status: 'queued' }, data: { status: 'sending' } });
  if (claimed.count === 0) return; // another run took it

  const lastAttempt = job.attempts + 1 >= job.maxAttempts;
  // A reply goes through Graph reply on the original, so it stays in the conversation in Outlook too.
  const original = msg.replyToId ? await prisma.emailMessage.findUnique({ where: { id: msg.replyToId } }) : null;
  try {
    const cc = msg.ccAddresses as string[];
    if (original?.graphId && original.userId === msg.userId) {
      await ctx.graph.reply(account, original.graphId, { to: msg.toAddresses as string[], ...(cc.length ? { cc } : {}), html: textToHtml(msg.bodyText) });
    } else {
      await ctx.graph.sendMail(account, {
        to: msg.toAddresses as string[],
        ...(cc.length ? { cc } : {}),
        subject: msg.subject,
        html: textToHtml(msg.bodyText),
        text: msg.bodyText,
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
  await prisma.$transaction(async (tx) => {
    await tx.emailMessage.update({ where: { id: msg.id }, data: { status: 'sent', lastError: null, occurredAt: new Date() } });
    // Release 3A: the quotation's send effects, only now that Microsoft has accepted the message.
    if (quotation) await onQuotationSent(tx, msg, quotation.snapshot);
  });
}
