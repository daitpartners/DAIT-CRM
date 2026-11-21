import type { FastifyPluginAsync } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { LeadEmailSend, isClosedStatus } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight } from '../plugins/auth.js';
import { parseBody } from '../validate.js';
import { enqueue } from '../jobs/queue.js';
import { assertLeadVisible } from '../leads/visibility.js';
import { dateOnly, todayIn } from '../leads/dates.js';
import { syncFollowUpTask } from '../leads/service.js';
import { guard, lockFresh } from './leads.js';

/** Retries for a user's email: about half an hour of backoff (2, 4, 8, 16 minutes) before it is marked failed. */
const SEND_ATTEMPTS = 5;
const DAY_MS = 86_400_000;

/** An email as its owner sees it (only ever returned to its owner). */
export function emailView(m: EmailMessage) {
  return {
    id: m.id, leadId: m.leadId, folder: m.folder, status: m.status, fromAddress: m.fromAddress,
    toAddresses: m.toAddresses as string[], ccAddresses: m.ccAddresses as string[], subject: m.subject, bodyText: m.bodyText,
    occurredAt: m.occurredAt, lastError: m.lastError,
  };
}

/**
 * Email from the lead page (release 2B-1). Privacy (owner, 22 Nov 2026): a message belongs to the user whose mailbox
 * it is; nobody else, administrators included, can list or read it.
 */
export const leadEmailRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>('/leads/:id/emails', { preHandler: [requireRight('use_email')] }, async (request, reply) => {
    const body = parseBody(LeadEmailSend, request.body);
    const user = request.user!;
    const id = Number(request.params.id);
    return guard(reply, async () => {
      const account = await prisma.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: 'connected' } });
      if (!account) return reply.code(409).send({ error: 'no_mailbox' });
      const created = await prisma.$transaction(async (tx) => {
        const { lead } = await lockFresh(tx, user, id, body.updatedAt);
        const msg = await tx.emailMessage.create({
          data: {
            userId: user.id, accountId: account.id, leadId: lead.id, contactId: lead.contactId, companyId: lead.companyId,
            folder: 'sent', status: 'queued', fromAddress: account.address, toAddresses: [body.to], ccAddresses: body.cc,
            subject: body.subject, bodyText: body.body,
          },
        });
        await enqueue(tx, 'send_user_email', { emailMessageId: msg.id }, { maxAttempts: SEND_ATTEMPTS });
        await tx.leadActivity.create({
          data: {
            leadId: lead.id, activityType: 'email', title: `Email sent · ${body.subject}`, relatedType: 'email_message',
            relatedId: msg.id, byUserId: user.id,
          },
        });
        // "Set follow-up in N days" (prototype): an open lead only; a closed lead keeps no follow-up.
        if (body.followUpDays && !isClosedStatus(lead.status)) {
          const due = new Date(dateOnly(todayIn(user.timezone)).getTime() + body.followUpDays * DAY_MS);
          const updated = await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUp: due } });
          await syncFollowUpTask(tx, updated);
        }
        // Audit without the content: the mail is private to its sender.
        await audit(tx, { entityType: 'lead', entityId: lead.id, action: 'update', userId: user.id, after: { emailMessageId: msg.id } });
        return msg;
      });
      return reply.code(201).send(emailView(created));
    });
  });

  app.get<{ Params: { id: string } }>('/leads/:id/emails', { preHandler: [requireRight('use_email')] }, async (request, reply) => {
    const user = request.user!;
    const id = Number(request.params.id);
    return guard(reply, async () => {
      await assertLeadVisible(prisma, user, id, { includeArchived: true });
      const rows = await prisma.emailMessage.findMany({
        where: { leadId: id, userId: user.id }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 200,
      });
      return { items: rows.map(emailView) };
    });
  });
};
