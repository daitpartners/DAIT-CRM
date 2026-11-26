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
import { canSeeTeamMail, mailScope } from '../mail/access.js';
import { audit } from '../audit.js';

/**
 * An email on the lead page. `ownerName` is the mailbox owner's name when `viewerId` (the reader) is someone else (an
 * Administrator or Manager reading the team's lead mail); null for the reader's own mail and when no reader is given.
 */
export function emailView(m: EmailMessage & { user?: { name: string } }, viewerId?: number) {
  return {
    ownerName: viewerId !== undefined && m.userId !== viewerId ? (m.user?.name ?? null) : null,
    id: m.id, leadId: m.leadId, folder: m.folder, status: m.status, fromAddress: m.fromAddress,
    toAddresses: m.toAddresses as string[], ccAddresses: m.ccAddresses as string[], subject: m.subject, bodyText: m.bodyText,
    occurredAt: m.occurredAt, lastError: m.lastError,
  };
}

/**
 * Email from the lead page (release 2B-1). Privacy (web-mail release 1): lead mail belongs to the mailbox owner.
 * Administrators and Managers can read every user's lead mail (view only, each opening audited); Sales representatives
 * and Data research users see only their own. Drafts stay with their owner.
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
      // Your own mail on the lead; with `view_team_mail`, every other user's team-readable mail too (Task 8's rule).
      const scope = mailScope(user, canSeeTeamMail(user) ? 'all' : 'me');
      const rows = await prisma.emailMessage.findMany({
        where: { AND: [scope.where, { leadId: id, folder: { not: 'drafts' } }] },
        include: { user: { select: { name: true } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 200,
      });
      const others = rows.filter((m) => m.userId !== user.id).map((m) => m.id);
      // Reading another user's mail is audited: which messages, never their content.
      if (others.length) await audit(prisma, { entityType: 'lead', entityId: id, action: 'view', userId: user.id, after: { emailMessageIds: others } });
      return { items: rows.map((m) => emailView(m, user.id)) };
    });
  });
};
