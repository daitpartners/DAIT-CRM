import type { FastifyPluginAsync } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { prisma } from '../db.js';
import { requireRight } from '../plugins/auth.js';
import { assertLeadVisible } from '../leads/visibility.js';
import { guard } from './leads.js';
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

/** Message ids `viewerId` already has a lead-page view audit row for on lead `leadId` since midnight UTC today. */
async function auditedToday(viewerId: number, leadId: number): Promise<Set<number>> {
  const since = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const entries = await prisma.auditLog.findMany({
    where: { entityType: 'lead', entityId: String(leadId), action: 'view', userId: viewerId, at: { gte: since } },
    select: { after: true },
  });
  const ids = new Set<number>();
  for (const { after } of entries) {
    const list = after && typeof after === 'object' && !Array.isArray(after) ? after.emailMessageIds : undefined;
    if (Array.isArray(list)) for (const v of list) if (typeof v === 'number') ids.add(v);
  }
  return ids;
}

/**
 * The lead page's Emails tab (release 2B-1). Sending from the lead page goes through the drafts path (web-mail release 3:
 * routes/mailDrafts.ts, with the lead on the draft). Privacy (web-mail release 1): lead mail belongs to the mailbox owner.
 * Administrators and Managers can read every user's lead mail (view only, each opening audited); Sales representatives
 * and Data research users see only their own. Drafts stay with their owner.
 */
export const leadEmailRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/leads/:id/emails', { preHandler: [requireRight('use_email')] }, async (request, reply) => {
    const user = request.user!;
    const id = Number(request.params.id);
    return guard(reply, async () => {
      await assertLeadVisible(prisma, user, id, { includeArchived: true });
      // Your own mail on the lead; with `view_team_mail`, every other user's team-readable mail too (Task 8's rule).
      // Drafts stay out, except your own send in its Undo window or being sent (Sending, so the tab polls until it is
      // Sent) and your own send that failed (Failed, back in your Drafts): the lead page sends through a draft.
      const scope = mailScope(user, canSeeTeamMail(user) ? 'all' : 'me');
      const ownSend = { userId: user.id, OR: [{ status: { in: ['queued', 'sending'] }, scheduledAt: null }, { status: 'failed' }] };
      const rows = await prisma.emailMessage.findMany({
        where: { AND: [scope.where, { leadId: id }, { OR: [{ folder: { not: 'drafts' } }, ownSend] }] },
        include: { user: { select: { name: true } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 200,
      });
      const others = rows.filter((m) => m.userId !== user.id).map((m) => m.id);
      // Reading another user's mail is audited: which messages, never their content. Once per viewer, message and
      // (UTC) day, not on every poll of the tab.
      if (others.length) {
        const audited = await auditedToday(user.id, id);
        const fresh = others.filter((m) => !audited.has(m));
        if (fresh.length) await audit(prisma, { entityType: 'lead', entityId: id, action: 'view', userId: user.id, after: { emailMessageIds: fresh } });
      }
      return { items: rows.map((m) => emailView(m, user.id)) };
    });
  });
};
