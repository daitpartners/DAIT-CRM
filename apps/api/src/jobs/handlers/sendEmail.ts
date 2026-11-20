import type { Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { errorMessage } from '../queue.js';
import { isAuthFailure } from '../../graph/client.js';
import type { SendEmailPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** Sends a queued email through the connected system mailbox. Throwing makes the runner retry the job. */
export async function sendEmailHandler(job: Job, ctx: JobContext): Promise<void> {
  const account = await prisma.emailAccount.findFirst({
    where: { kind: 'system', status: 'connected' },
    orderBy: { id: 'desc' },
  });
  if (!account) throw new Error('no_system_mailbox');

  const p = job.payload as unknown as SendEmailPayload;
  try {
    await ctx.graph.sendMail(account, {
      to: p.to,
      ...(p.cc?.length ? { cc: p.cc } : {}),
      subject: p.subject,
      html: p.html,
      text: p.text,
    });
  } catch (err) {
    // Only a revoked or expired grant needs an admin to reconnect; throttling and outages just retry.
    if (isAuthFailure(err)) {
      await prisma.emailAccount.update({
        where: { id: account.id },
        data: { status: 'error', lastError: errorMessage(err) },
      });
    }
    throw err;
  }
}
