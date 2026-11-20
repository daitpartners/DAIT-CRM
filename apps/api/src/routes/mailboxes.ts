import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight } from '../plugins/auth.js';
import { accountSummary } from '../graph/accounts.js';

export const mailboxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/mailboxes/system', { preHandler: [requireRight('view_admin_settings')] }, async () => {
    const [account, pendingJobs, failedJobs] = await Promise.all([
      prisma.emailAccount.findFirst({ where: { kind: 'system' }, orderBy: { id: 'desc' } }),
      prisma.job.count({ where: { type: 'send_email', status: { in: ['queued', 'running'] } } }),
      prisma.job.count({ where: { type: 'send_email', status: 'failed' } }),
    ]);
    return {
      account: account
        ? { address: account.address, status: account.status, lastError: account.lastError, updatedAt: account.updatedAt }
        : null,
      pendingJobs,
      failedJobs,
    };
  });

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
