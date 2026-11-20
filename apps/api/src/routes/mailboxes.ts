import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight } from '../plugins/auth.js';
import { accountSummary } from '../graph/accounts.js';
import { staleRunningWhere } from '../jobs/queue.js';
import { sendSystemEmail } from '../email/system.js';

export const TEST_EMAIL_SUBJECT = 'DAIT CRM test email';

export const mailboxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/mailboxes/system', { preHandler: [requireRight('view_admin_settings')] }, async () => {
    const [account, pendingJobs, failedJobs, staleJobs] = await Promise.all([
      prisma.emailAccount.findFirst({ where: { kind: 'system' }, orderBy: { id: 'desc' } }),
      prisma.job.count({ where: { type: 'send_email', status: { in: ['queued', 'running'] } } }),
      prisma.job.count({ where: { type: 'send_email', status: 'failed' } }),
      prisma.job.count({ where: { type: 'send_email', ...staleRunningWhere() } }),
    ]);
    return {
      account: account
        ? { address: account.address, sendAs: account.sendAs, status: account.status, lastError: account.lastError, updatedAt: account.updatedAt }
        : null,
      pendingJobs,
      failedJobs,
      staleJobs,
    };
  });

  app.post(
    '/mailboxes/system/test-email',
    {
      preHandler: [requireRight('manage_users')],
      // Route-level hooks run after the session hook, so the limit is per signed-in user.
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip) } },
    },
    async (request, reply) => {
      const actor = request.user!;
      const account = await prisma.emailAccount.findFirst({ where: { kind: 'system' }, orderBy: { id: 'desc' } });
      if (!account) return reply.code(409).send({ error: 'no_system_mailbox' });
      const from = account.sendAs ?? account.address;
      const text = `This is a test email from the DAIT CRM, sent from the system mailbox ${from} at the request of ${actor.name}. If you can read it, the CRM can send email.`;
      const job = await prisma.$transaction(async (tx) => {
        const queued = await sendSystemEmail(tx, {
          to: [actor.email],
          subject: TEST_EMAIL_SUBJECT,
          html: `<p>${escapeHtml(text)}</p>`,
          text,
          relatedTo: { entityType: 'email_account', entityId: String(account.id) },
        });
        await audit(tx, {
          entityType: 'email_account',
          entityId: account.id,
          action: 'test_email',
          userId: actor.id,
          after: { jobId: queued.id, to: actor.email, sendAs: from },
        });
        return queued;
      });
      return reply.code(201).send({ jobId: job.id });
    },
  );

  app.post('/mailboxes/system/disconnect', { preHandler: [requireRight('manage_users')] }, async (request, reply) => {
    await prisma.$transaction(async (tx) => {
      const accounts = await tx.emailAccount.findMany({ where: { kind: 'system' } });
      for (const a of accounts) {
        await tx.emailAccount.delete({ where: { id: a.id } });
        await audit(tx, { entityType: 'email_account', entityId: a.id, action: 'delete', userId: request.user!.id, before: accountSummary(a) });
      }
    });
    return reply.code(204).send();
  });
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
