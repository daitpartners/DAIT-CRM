import type { Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { errorMessage } from '../queue.js';
import { isAuthFailure } from '../../graph/client.js';
import type { SendUserEmailPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** Plain text as simple HTML: escaped, line breaks kept. */
export function textToHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<div>${escaped.replace(/\r?\n/g, '<br>')}</div>`;
}

/**
 * Sends a message a user wrote in the CRM through their own mailbox (Graph sendMail, so it is also in Outlook's
 * Sent Items). Marks it `sent`; a revoked mailbox fails it at once (retrying cannot help until the user reconnects);
 * other errors retry, and the last attempt marks it `failed` with the error.
 */
export async function sendUserEmailHandler(job: Job, ctx: JobContext): Promise<void> {
  const { emailMessageId } = job.payload as unknown as SendUserEmailPayload;
  const msg = await prisma.emailMessage.findUnique({ where: { id: emailMessageId }, include: { account: true } });
  if (!msg || msg.status !== 'queued') return; // already handled, or the message is gone
  const account = msg.account;
  const lastAttempt = job.attempts + 1 >= job.maxAttempts;
  if (!account || account.kind !== 'personal' || account.status !== 'connected') {
    await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: 'failed', lastError: 'mailbox_not_connected' } });
    return;
  }
  try {
    const cc = msg.ccAddresses as string[];
    await ctx.graph.sendMail(account, {
      to: msg.toAddresses as string[],
      ...(cc.length ? { cc } : {}),
      subject: msg.subject,
      html: textToHtml(msg.bodyText),
      text: msg.bodyText,
    });
  } catch (err) {
    const lastError = errorMessage(err);
    if (isAuthFailure(err)) {
      await prisma.$transaction([
        prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'error', lastError } }),
        prisma.emailMessage.update({ where: { id: msg.id }, data: { status: 'failed', lastError: 'mailbox_needs_reconnect' } }),
      ]);
      return;
    }
    await prisma.emailMessage.update({ where: { id: msg.id }, data: lastAttempt ? { status: 'failed', lastError } : { lastError } });
    throw err;
  }
  await prisma.emailMessage.update({ where: { id: msg.id }, data: { status: 'sent', lastError: null, occurredAt: new Date() } });
}
