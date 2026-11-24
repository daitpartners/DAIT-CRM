import type { FastifyPluginAsync } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { LeadEmailSend } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { requireRight } from '../plugins/auth.js';
import { parseBody } from '../validate.js';
import { assertLeadVisible } from '../leads/visibility.js';
import { assertProjectFor, queueOutgoing } from '../mail/outgoing.js';
import { guard, lockFresh } from './leads.js';
import { FORMATTED_BODY_LIMIT, perUser } from '../mail/formatted.js';
import { outgoingWithFiles } from '../mail/templateFiles.js';

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
  app.post<{ Params: { id: string } }>('/leads/:id/emails', { preHandler: [requireRight('use_email')], bodyLimit: FORMATTED_BODY_LIMIT, config: perUser(30) }, async (request, reply) => {
    const body = parseBody(LeadEmailSend, request.body);
    const user = request.user!;
    const id = Number(request.params.id);
    return guard(reply, async () => {
      const account = await prisma.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: 'connected' } });
      if (!account) return reply.code(409).send({ error: 'no_mailbox' });
      await assertLeadVisible(prisma, user, id, { includeArchived: true });
      // A formatted message is sanitised again here, whatever the browser sent: after the cheap checks, before the
      // transaction (the worker may take up to its time limit). A template's files go with it (inline pictures the
      // HTML still shows, and the attachments the sender kept).
      const message = await outgoingWithFiles(body.body, body.bodyHtml, body.templateId, body.attachmentIds);
      const created = await prisma.$transaction(async (tx) => {
        const { lead } = await lockFresh(tx, user, id, body.updatedAt);
        if (body.projectId) await assertProjectFor(tx, user, body.projectId, lead.companyId);
        return queueOutgoing(tx, user, account, {
          lead, to: [body.to], cc: body.cc, subject: body.subject, ...message, followUpDays: body.followUpDays,
          projectId: body.projectId ?? null,
        });
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
        where: { leadId: id, userId: user.id, folder: { not: 'drafts' } }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 200,
      });
      return { items: rows.map(emailView) };
    });
  });
};
