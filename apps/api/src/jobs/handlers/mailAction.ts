import type { Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { errorMessage } from '../queue.js';
import { isAuthFailure } from '../../graph/client.js';
import type { MailActionPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/**
 * Applies a change the user made in the CRM (read, unread, archive) to the same message in their mailbox (release
 * 2B-2). A message without a Graph id, or whose mailbox is no longer the owner's connected one, is left alone.
 */
export async function mailActionHandler(job: Job, ctx: JobContext): Promise<void> {
  const { emailMessageId, action } = job.payload as unknown as MailActionPayload;
  const msg = await prisma.emailMessage.findUnique({ where: { id: emailMessageId }, include: { account: true } });
  const account = msg?.account;
  if (!msg?.graphId || !account || account.kind !== 'personal' || account.status !== 'connected' || account.userId !== msg.userId) return;
  try {
    if (action === 'archive') await ctx.graph.moveTo(account, msg.graphId, 'archive');
    else await ctx.graph.markRead(account, msg.graphId, action === 'read');
  } catch (err) {
    if (isAuthFailure(err)) {
      await prisma.emailAccount.updateMany({
        where: { id: account.id, status: 'connected', refreshTokenEnc: account.refreshTokenEnc },
        data: { status: 'error', lastError: errorMessage(err) },
      });
      return;
    }
    throw err;
  }
}
