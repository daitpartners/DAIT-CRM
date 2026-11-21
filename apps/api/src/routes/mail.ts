import type { FastifyPluginAsync } from 'fastify';
import type { Lead, Prisma } from '@prisma/client';
import { MailCompose, MailReply } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { requireRight, type AuthUser } from '../plugins/auth.js';
import { NotFoundError, parseBody } from '../validate.js';
import { assertLeadVisible, canSeeLead } from '../leads/visibility.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import { matchMail } from '../mail/match.js';
import { queueOutgoing } from '../mail/outgoing.js';
import { emailView } from './leadEmails.js';
import { guard, lockLeads } from './leads.js';

type Tx = Prisma.TransactionClient;

/** The caller's connected personal mailbox, or null. */
const myMailbox = (userId: number) => prisma.emailAccount.findFirst({ where: { kind: 'personal', userId, status: 'connected' } });

/** One of the caller's own messages, else 404: nobody reaches another user's mail (owner, 22 Nov 2026). */
async function ownMessage(db: Tx | typeof prisma, user: AuthUser, rawId: string) {
  const id = Number(rawId);
  const m = Number.isInteger(id) ? await db.emailMessage.findFirst({ where: { id, userId: user.id } }) : null;
  if (!m) throw new NotFoundError();
  return m;
}

/** A live lead the user can see, locked for the transaction. */
async function lockedLead(tx: Tx, user: AuthUser, leadId: number): Promise<Lead> {
  await assertLeadVisible(tx, user, leadId);
  await lockLeads(tx, [leadId]);
  return tx.lead.findUniqueOrThrow({ where: { id: leadId } });
}

/**
 * The Email screen (release 2B-2). Privacy (owner, 22 Nov 2026): a message belongs to the user whose mailbox it is;
 * every route here reads and changes only the caller's own messages, whatever their role.
 */
export const mailRoutes: FastifyPluginAsync = async (app) => {
  const pre = { preHandler: [requireRight('use_email')] };

  // Compose (prototype V.compose): optionally on a lead or for a client; otherwise linked by matching.
  app.post('/mail', pre, async (request, reply) => {
    const body = parseBody(MailCompose, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const account = await myMailbox(user.id);
      if (!account) return reply.code(409).send({ error: 'no_mailbox' });
      const created = await prisma.$transaction(async (tx) => {
        const lead = body.leadId ? await lockedLead(tx, user, body.leadId) : null;
        let links = { companyId: null as number | null, contactId: null as number | null };
        if (!lead && body.companyId) {
          await assertCompanyVisible(tx, user, body.companyId);
          const contact = await tx.contact.findFirst({
            where: { companyId: body.companyId, businessEmail: { equals: body.to, mode: 'insensitive' } }, select: { id: true },
          });
          links = { companyId: body.companyId, contactId: contact?.id ?? null };
        } else if (!lead) {
          // "— no lead —" was the user's choice: only the contact and company are filled in.
          const m = await matchMail(tx, user, { threadId: null, counterparts: [body.to, ...body.cc], ownAddress: account.address });
          links = { companyId: m.companyId, contactId: m.contactId };
        }
        return queueOutgoing(tx, user, account, { lead, ...links, to: [body.to], cc: body.cc, subject: body.subject, body: body.body });
      });
      return reply.code(201).send(emailView(created));
    });
  });

  // Reply (prototype Reply): to the sender of a received message, or the recipients of your own; same conversation.
  app.post<{ Params: { id: string } }>('/mail/:id/reply', pre, async (request, reply) => {
    const body = parseBody(MailReply, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const original = await ownMessage(prisma, user, request.params.id);
      if (original.status === 'draft') return reply.code(409).send({ error: 'draft' });
      const account = await myMailbox(user.id);
      if (!account) return reply.code(409).send({ error: 'no_mailbox' });
      const to = original.status === 'received' ? [original.fromAddress] : (original.toAddresses as string[]);
      const subject = /^\s*re\s*:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`.slice(0, 500);
      const created = await prisma.$transaction(async (tx) => {
        const lead = original.leadId && (await canSeeLead(tx, user, original.leadId))
          ? await lockedLead(tx, user, original.leadId).catch(() => null)
          : null;
        return queueOutgoing(tx, user, account, {
          lead, companyId: original.companyId, contactId: original.contactId, to, cc: body.cc, subject, body: body.body,
          replyToId: original.id, threadId: original.threadId,
        });
      });
      return reply.code(201).send(emailView(created));
    });
  });
};
