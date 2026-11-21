import type { FastifyPluginAsync } from 'fastify';
import type { EmailAccount } from '@prisma/client';
import { MailboxOptions, can } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight, requireUser, type AuthUser } from '../plugins/auth.js';
import { parseBody } from '../validate.js';
import { accountSummary } from '../graph/accounts.js';
import { staleRunningWhere } from '../jobs/queue.js';
import { sendSystemEmail } from '../email/system.js';

export const TEST_EMAIL_SUBJECT = 'DAIT CRM test email';

type WithUser = EmailAccount & { user: { name: string } | null };

/** A personal mailbox as the Settings card shows it; never the token. */
function mailboxView(a: WithUser) {
  return {
    id: a.id, address: a.address, userId: a.userId, userName: a.user?.name ?? null, provider: a.provider, status: a.status,
    syncMail: a.syncMail, syncCalendar: a.syncCalendar, sharedMailboxes: a.sharedMailboxes, lastSyncAt: a.lastSyncAt,
    messageCount: a.messageCount,
  };
}

/** The user's own personal mailbox, or any for an administrator / manager (`view_admin_settings`); else null (404). */
async function ownMailbox(user: AuthUser, id: number): Promise<WithUser | null> {
  if (!Number.isInteger(id)) return null;
  const a = await prisma.emailAccount.findFirst({ where: { id, kind: 'personal' }, include: { user: { select: { name: true } } } });
  return a && (a.userId === user.id || can(user.role, 'view_admin_settings')) ? a : null;
}

export const mailboxRoutes: FastifyPluginAsync = async (app) => {
  const include = { user: { select: { name: true } } } as const;

  // Personal mailboxes (release 2A): your own, plus everyone's for administrators and managers.
  app.get('/mailboxes', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const mine = await prisma.emailAccount.findFirst({
      where: { kind: 'personal', userId: user.id, status: { not: 'disconnected' } }, include,
    });
    if (!can(user.role, 'view_admin_settings')) return { mine: mine ? mailboxView(mine) : null };
    const all = await prisma.emailAccount.findMany({
      where: { kind: 'personal', status: { not: 'disconnected' } }, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { mine: mine ? mailboxView(mine) : null, all: all.map(mailboxView) };
  });

  app.patch<{ Params: { id: string } }>('/mailboxes/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const body = parseBody(MailboxOptions, request.body);
    const a = await ownMailbox(request.user!, Number(request.params.id));
    if (!a) return reply.code(404).send({ error: 'not_found' });
    const saved = await prisma.$transaction(async (tx) => {
      const updated = await tx.emailAccount.update({ where: { id: a.id }, data: body, include });
      await audit(tx, {
        entityType: 'email_account', entityId: a.id, action: 'update', userId: request.user!.id,
        before: { syncMail: a.syncMail, syncCalendar: a.syncCalendar, sharedMailboxes: a.sharedMailboxes },
        after: { syncMail: updated.syncMail, syncCalendar: updated.syncCalendar, sharedMailboxes: updated.sharedMailboxes },
      });
      return updated;
    });
    return mailboxView(saved);
  });

  /** Stops sending and syncing through the mailbox and deletes its token; mail already linked stays. */
  app.post<{ Params: { id: string } }>('/mailboxes/:id/disconnect', { preHandler: [requireUser] }, async (request, reply) => {
    const a = await ownMailbox(request.user!, Number(request.params.id));
    if (!a) return reply.code(404).send({ error: 'not_found' });
    await prisma.$transaction(async (tx) => {
      const updated = await tx.emailAccount.update({ where: { id: a.id }, data: { status: 'disconnected', refreshTokenEnc: '', tokenExpiresAt: null } });
      await audit(tx, { entityType: 'email_account', entityId: a.id, action: 'update', userId: request.user!.id, before: accountSummary(a), after: accountSummary(updated) });
    });
    return reply.code(204).send();
  });

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
