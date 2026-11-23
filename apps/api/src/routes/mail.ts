import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { Prisma, type EmailMessage, type Lead } from '@prisma/client';
import { LeadCreate, MailCompose, MailLink, MailListQuery, MailRead, MailReply, can, checkDomain, domainOf, isFreeMail, pageArgs } from '@dait-crm/shared';
import { audit } from '../audit.js';
import { enqueue, errorMessage } from '../jobs/queue.js';
import { BODY_MAX } from '../jobs/handlers/syncMailbox.js';
import { GraphError, type GraphClient } from '../graph/client.js';
import { emailBodies } from '../mail/html.js';
import type { MailActionPayload } from '../jobs/types.js';
import { dateOnly, todayIn, ymd } from '../leads/dates.js';
import { auditCreatedLead, createLeadWithCompany, RuleError } from '../leads/service.js';
import { autoResearchForLead } from '../research/service.js';
import { findCompanyMatches } from '../companies/match.js';
import { isUniqueViolation } from '../prismaErrors.js';
import { prisma } from '../db.js';
import { requireRight, type AuthUser } from '../plugins/auth.js';
import { NotFoundError, parseBody, parseQuery } from '../validate.js';
import { assertLeadVisible, canSeeLead, leadWhere } from '../leads/visibility.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import { matchMail } from '../mail/match.js';
import { assertProjectFor, queueOutgoing } from '../mail/outgoing.js';
import { projectWhere } from '../projects/visibility.js';
import { emailView } from './leadEmails.js';
import { domainTaken, guard, lockLeads } from './leads.js';

type Tx = Prisma.TransactionClient;

const VIEWS = ['inbox', 'sent', 'drafts', 'archive', 'unlinked', 'awaiting', 'mine'] as const;
type View = (typeof VIEWS)[number];
/** Upper bound on Awaiting reply candidates; paging applies after the other filters. */
const AWAITING_MAX = 5000;
const PREVIEW = 120;
const DAY_MS = 86_400_000;
/** Mailbox changes are retried a little (2, 4 minutes); the next sync shows Outlook's state anyway. */
const ACTION_ATTEMPTS = 3;

const leadRef = { select: { id: true, number: true, status: true, priority: true, nextFollowUp: true, companyId: true, companyName: true, assignedToId: true } } as const;
type WithLead = EmailMessage & { lead: { id: number; number: string } | null; project?: { id: number; number: string } | null };

/** A message in the list: no body, a short one-line preview. */
function listItem(m: WithLead) {
  return {
    id: m.id, folder: m.folder, status: m.status, fromAddress: m.fromAddress, fromName: m.fromName, toAddresses: m.toAddresses as string[],
    subject: m.subject, preview: m.bodyText.replace(/\s+/g, ' ').trim().slice(0, PREVIEW), occurredAt: m.occurredAt, isRead: m.isRead,
    leadId: m.leadId, leadNumber: m.lead?.number ?? null, companyId: m.companyId, hasAttachments: (m.attachmentNames as string[]).length > 0,
    projectId: m.project?.id ?? null, projectNumber: m.project?.number ?? null,
  };
}

/** Whether the message came from someone else (received) rather than from the user. */
const isInbound = (m: EmailMessage) => m.status === 'received';

/** The other party: the sender of received mail, the first recipient of your own. */
const counterpart = (m: EmailMessage) => (isInbound(m) ? m.fromName || m.fromAddress : ((m.toAddresses as string[])[0] ?? ''));

const THREAD_MAX = 50;
const REPLY_SUBJECT = /^\s*(re|aw|sv|rv)\s*:/i;

/**
 * The side panel's thread history (prototype `history`, newest first): the open message and the rest of the
 * conversation in the user's own mailbox. `kind` words the event ("sent by Maya", "reply received", "received"),
 * `by` is the sender's first name for your own mail other than the open message, `unmatched` marks mail with no lead
 * and no contact.
 */
function threadHistory(user: AuthUser, open: EmailMessage, others: EmailMessage[]) {
  const all = [...others, open].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id);
  return all.map((t, i) => {
    const inbound = isInbound(t);
    // A reply answers your own mail: the message before it (drafts aside) is yours, or "Re:" when it starts the list.
    const before = all.slice(i + 1).find((o) => o.status !== 'draft');
    const kind = t.status === 'draft' ? 'draft' : !inbound ? 'sent' : (before ? !isInbound(before) : REPLY_SUBJECT.test(t.subject)) ? 'reply' : 'received';
    // Your own open message reads plain "sent" (prototype E-6); your other mail in the thread "sent by <first name>".
    const by = inbound || t.id === open.id ? null : ((t.fromName || user.name).trim().split(/\s+/)[0] ?? null);
    return {
      id: t.id, occurredAt: t.occurredAt, direction: inbound ? 'in' : 'out', who: counterpart(t), subject: t.subject,
      kind, by, unmatched: !t.leadId && !t.contactId,
    };
  });
}

/** Ids of the user's messages matching a search over subject, sender, recipients and text (case-insensitive). */
async function searchIds(userId: number, s: string): Promise<number[]> {
  const like = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM email_messages WHERE user_id = ${userId} AND (
      subject ILIKE ${like} OR from_address ILIKE ${like} OR coalesce(from_name, '') ILIKE ${like}
      OR to_addresses::text ILIKE ${like} OR cc_addresses::text ILIKE ${like} OR body_text ILIKE ${like})
    LIMIT 2000`;
  return rows.map((r) => r.id);
}

/** Sent, linked messages with no later received message in their conversation (prototype "Awaiting reply"). */
async function awaitingIds(userId: number): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT s.id FROM email_messages s WHERE s.user_id = ${userId} AND s.folder = 'sent' AND s.status IN ('sent', 'queued', 'sending')
      AND s.lead_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM email_messages r WHERE r.user_id = s.user_id AND r.status = 'received'
          AND r.thread_id IS NOT NULL AND r.thread_id = s.thread_id AND r.occurred_at > s.occurred_at)
    ORDER BY s.occurred_at DESC LIMIT ${AWAITING_MAX}`;
  return rows.map((r) => r.id);
}

/**
 * Messages with no lead the user can see: none, or one that has since moved to someone else (drafts aside). The NOT
 * wraps the relation filter: `lead: { NOT: {} }` (everyone's leads visible) would match every linked message.
 */
const unlinkedWhere = (user: AuthUser): Prisma.EmailMessageWhereInput => ({
  OR: [{ leadId: null }, { NOT: { lead: leadWhere(user, { includeArchived: true }) } }], folder: { not: 'drafts' },
});

/**
 * Linking a message (Link to lead, Create lead) also links the user's other mail in the same conversation that has no
 * lead yet, so the thread does not keep showing it as unmatched. Left alone: drafts, mail on another lead and mail
 * matched to another company. As /link: the lead's contact, else the row's own contact only when it belongs
 * to the lead's company.
 */
async function linkConversation(db: Tx | typeof prisma, m: EmailMessage, lead: Pick<Lead, 'id' | 'companyId' | 'contactId'>) {
  if (!m.threadId) return;
  const rows = await db.emailMessage.findMany({
    where: {
      userId: m.userId, threadId: m.threadId, leadId: null, id: { not: m.id }, folder: { not: 'drafts' },
      OR: [{ companyId: null }, ...(lead.companyId !== null ? [{ companyId: lead.companyId }] : [])],
    },
    select: { id: true, contact: { select: { id: true, companyId: true } } },
  });
  for (const r of rows) {
    const keep = r.contact && lead.companyId !== null && r.contact.companyId === lead.companyId ? r.contact.id : null;
    await db.emailMessage.update({ where: { id: r.id }, data: { leadId: lead.id, companyId: lead.companyId, contactId: lead.contactId ?? keep } });
  }
}

/** Queues the same change in the user's mailbox (messages that came from it only). */
async function tellMailbox(db: Tx | typeof prisma, m: EmailMessage, action: MailActionPayload['action']) {
  if (m.graphId) await enqueue(db, 'mail_action', { emailMessageId: m.id, action }, { maxAttempts: ACTION_ATTEMPTS });
}

/** Company name guessed from an address's domain ("blue-river.io" → "Blue River"); null for free mail. */
function nameFromDomain(address: string): string | null {
  const domain = domainOf(address);
  if (!domain || isFreeMail(domain)) return null;
  return domain.split('.')[0]!.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || null;
}

/** The caller's connected personal mailbox, or null. */
const myMailbox = (userId: number) => prisma.emailAccount.findFirst({ where: { kind: 'personal', userId, status: 'connected' } });

/** One of the caller's own messages, else 404: nobody reaches another user's mail (owner, 22 Nov 2026). */
async function ownMessage(db: Tx | typeof prisma, user: AuthUser, rawId: string) {
  const id = Number(rawId);
  const m = Number.isInteger(id) ? await db.emailMessage.findFirst({ where: { id, userId: user.id } }) : null;
  if (!m) throw new NotFoundError();
  return m;
}

/**
 * The HTML body of a message synced before bodies were kept as HTML (owner, 23 Nov 2026), read once when it is opened:
 * only for the caller's own message (`m` comes from ownMessage) and only from the mailbox it came from while that is
 * the caller's own connected one, never anyone else's. Sanitised and stored with the cleaner text. A message the
 * mailbox no longer has (or a plain-text one) is marked '' and not asked again; any other failure leaves the text
 * body to show and tries again next time.
 */
async function fillHtmlBody(graph: GraphClient, log: FastifyBaseLogger, user: AuthUser, m: EmailMessage): Promise<EmailMessage> {
  if (m.bodyHtml !== null || !m.graphId || m.accountId === null || m.userId !== user.id) return m;
  const account = await prisma.emailAccount.findFirst({ where: { id: m.accountId, userId: user.id, kind: 'personal', status: 'connected' } });
  if (!account) return m;
  try {
    const { bodyHtml, bodyText } = emailBodies(await graph.messageBody(account, m.graphId), BODY_MAX);
    return await prisma.emailMessage.update({ where: { id: m.id }, data: { bodyHtml: bodyHtml ?? '', bodyText } });
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) return prisma.emailMessage.update({ where: { id: m.id }, data: { bodyHtml: '' } });
    // The message id and Graph's status only: the mail is private to its owner.
    log.warn({ emailMessageId: m.id, err: errorMessage(err) }, 'mail body fetch failed');
    return m;
  }
}

/** Of `ids`, the projects the user can see (a tag on one they cannot see shows no id or number, as a lead's). */
async function visibleProjects(user: AuthUser, ids: (number | null)[]): Promise<Map<number, { id: number; number: string }>> {
  const unique = [...new Set(ids.filter((id): id is number => id !== null))];
  if (!unique.length) return new Map();
  const rows = await prisma.project.findMany({ where: { AND: [{ id: { in: unique } }, projectWhere(user)] }, select: { id: true, number: true } });
  return new Map(rows.map((p) => [p.id, p]));
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
        // The project's company must be the lead's, or without a lead the client chosen (not one matching guessed).
        if (body.projectId) await assertProjectFor(tx, user, body.projectId, lead ? lead.companyId : (body.companyId ?? null));
        return queueOutgoing(tx, user, account, {
          lead, ...links, to: [body.to], cc: body.cc, subject: body.subject, body: body.body, projectId: body.projectId ?? null,
        });
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
          ? await lockedLead(tx, user, original.leadId).catch((e) => {
            // Only a lead gone in the meantime is skipped; a database error must not send the reply without its lead.
            if (e instanceof NotFoundError) return null;
            throw e;
          })
          : null;
        return queueOutgoing(tx, user, account, {
          lead, companyId: original.companyId, contactId: original.contactId, to, cc: body.cc, subject, body: body.body,
          replyToId: original.id, threadId: original.threadId, projectId: original.projectId,
        });
      });
      return reply.code(201).send(emailView(created));
    });
  });

  // The message list, paged (owner, 22 Nov 2026): every filter applies first, `total` counts what they leave.
  app.get('/mail', pre, async (request) => {
    const user = request.user!;
    const q = parseQuery(MailListQuery, request.query);
    const view: View = (VIEWS as readonly string[]).includes(q.view ?? '') ? (q.view as View) : 'inbox';
    const and: Prisma.EmailMessageWhereInput[] = [{ userId: user.id }];
    if (view === 'unlinked') and.push(unlinkedWhere(user));
    else if (view === 'mine') and.push({ lead: { assignedToId: user.id }, folder: { not: 'drafts' } });
    else if (view === 'awaiting') and.push({ id: { in: await awaitingIds(user.id) } });
    else and.push({ folder: view });
    const company = Number(q.company);
    // Through a lead only when the user can see that lead (a lead moved to someone else does not place your mail).
    if (q.company && Number.isInteger(company)) {
      and.push({ OR: [{ companyId: company }, { lead: { AND: [{ companyId: company }, leadWhere(user, { includeArchived: true })] } }] });
    }
    const lead = Number(q.lead);
    if (q.lead && Number.isInteger(lead)) and.push({ leadId: lead });
    // Narrows the caller's own mail only (the userId filter above stays): a tag never shows anyone else's message.
    const project = Number(q.project);
    if (q.project && Number.isInteger(project)) and.push({ projectId: project });
    const s = q.s?.trim().slice(0, 200);
    if (s) and.push({ id: { in: await searchIds(user.id, s) } });
    const where = { AND: and };
    const [rows, total] = await Promise.all([
      prisma.emailMessage.findMany({
        where, include: { lead: { select: { id: true, number: true } } }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], ...pageArgs(q),
      }),
      prisma.emailMessage.count({ where }),
    ]);
    // A lead the user can no longer see (moved to someone else) is not shown: no id, no number.
    const leadIds = [...new Set(rows.flatMap((m) => (m.leadId ? [m.leadId] : [])))];
    const visible = new Set(leadIds.length
      ? (await prisma.lead.findMany({ where: { AND: [{ id: { in: leadIds } }, leadWhere(user, { includeArchived: true })] }, select: { id: true } })).map((l) => l.id)
      : []);
    const projects = await visibleProjects(user, rows.map((m) => m.projectId));
    return {
      items: rows.map((m) => listItem({
        ...(m.leadId && !visible.has(m.leadId) ? { ...m, leadId: null, lead: null } : m), project: m.projectId ? projects.get(m.projectId) ?? null : null,
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  app.get('/mail/meta', pre, async (request) => {
    const user = request.user!;
    const [mailbox, unread, unlinked, companyIds, leadIds] = await Promise.all([
      prisma.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: { not: 'disconnected' } }, select: { id: true, address: true, status: true, lastSyncAt: true } }),
      prisma.emailMessage.count({ where: { userId: user.id, folder: 'inbox', isRead: false } }),
      prisma.emailMessage.count({ where: { AND: [{ userId: user.id }, unlinkedWhere(user)] } }),
      prisma.emailMessage.findMany({ where: { userId: user.id, companyId: { not: null } }, distinct: ['companyId'], select: { companyId: true } }),
      prisma.emailMessage.findMany({ where: { userId: user.id, leadId: { not: null } }, distinct: ['leadId'], select: { leadId: true } }),
    ]);
    const [companies, leads, projects] = await Promise.all([
      prisma.company.findMany({ where: { id: { in: companyIds.map((c) => c.companyId!) } }, select: { id: true, name: true, legalName: true, isClient: true }, orderBy: { name: 'asc' } }),
      prisma.lead.findMany({
        where: { AND: [{ id: { in: leadIds.map((l) => l.leadId!) } }, leadWhere(user, { includeArchived: true })] },
        select: { id: true, number: true, companyId: true, companyName: true, status: true }, orderBy: { id: 'desc' },
      }),
      // Release 3B: the projects the user can see (Project filter and Compose picker), not only those in their mail.
      prisma.project.findMany({ where: projectWhere(user), select: { id: true, number: true, name: true, companyId: true }, orderBy: { id: 'desc' } }),
    ]);
    return { mailbox, unread, unlinked, companies, leads, projects };
  });

  // `peek=1`: the first message shown on arrival, which the user has not opened yet, stays unread.
  app.get<{ Params: { id: string }; Querystring: { peek?: string } }>('/mail/:id', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      let m = await fillHtmlBody(app.graph, request.log, user, await ownMessage(prisma, user, request.params.id));
      if (!m.isRead && request.query.peek !== '1') {
        m = await prisma.emailMessage.update({ where: { id: m.id }, data: { isRead: true } });
        await tellMailbox(prisma, m, 'read');
      }
      const [lead, contact, company, thread, projects] = await Promise.all([
        m.leadId && (await canSeeLead(prisma, user, m.leadId)) ? prisma.lead.findUnique({ where: { id: m.leadId }, ...leadRef }) : null,
        m.contactId ? prisma.contact.findUnique({ where: { id: m.contactId }, select: { id: true, firstName: true, lastName: true } }) : null,
        m.companyId ? prisma.company.findUnique({ where: { id: m.companyId }, select: { id: true, name: true } }) : null,
        m.threadId
          ? prisma.emailMessage.findMany({ where: { userId: user.id, threadId: m.threadId, id: { not: m.id } }, orderBy: { occurredAt: 'desc' }, take: THREAD_MAX - 1 })
          : [],
        visibleProjects(user, [m.projectId]),
      ]);
      return {
        ...listItem({ ...m, lead: lead ? { id: lead.id, number: lead.number } : null, project: m.projectId ? projects.get(m.projectId) ?? null : null }),
        ccAddresses: m.ccAddresses as string[], bodyText: m.bodyText, bodyHtml: m.bodyHtml || null, attachmentNames: m.attachmentNames as string[], loggedAt: m.loggedAt,
        lead: lead ? { id: lead.id, number: lead.number, status: lead.status, priority: lead.priority, nextFollowUp: ymd(lead.nextFollowUp), companyId: lead.companyId } : null,
        contact: contact ? { id: contact.id, name: `${contact.firstName} ${contact.lastName}`.trim() } : null,
        company,
        thread: threadHistory(user, m, thread),
      };
    });
  });

  app.post<{ Params: { id: string } }>('/mail/:id/read', pre, async (request, reply) => {
    const { isRead } = parseBody(MailRead, request.body);
    return guard(reply, async () => {
      const m = await ownMessage(prisma, request.user!, request.params.id);
      if (m.isRead === isRead) return { id: m.id, isRead };
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.emailMessage.update({ where: { id: m.id }, data: { isRead } });
        await tellMailbox(tx, u, isRead ? 'read' : 'unread');
        return u;
      });
      return { id: updated.id, isRead: updated.isRead };
    });
  });

  app.post<{ Params: { id: string } }>('/mail/:id/archive', pre, async (request, reply) => {
    return guard(reply, async () => {
      const m = await ownMessage(prisma, request.user!, request.params.id);
      if (m.folder === 'drafts') return reply.code(409).send({ error: 'draft' });
      if (m.folder !== 'archive') {
        await prisma.$transaction(async (tx) => {
          const u = await tx.emailMessage.update({ where: { id: m.id }, data: { folder: 'archive' } });
          await tellMailbox(tx, u, 'archive');
        });
      }
      return { id: m.id, folder: 'archive' };
    });
  });

  // Log as activity (prototype): once per message, on its lead; the subject is the sender's alone.
  app.post<{ Params: { id: string } }>('/mail/:id/log', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const m = await ownMessage(prisma, user, request.params.id);
      if (!m.leadId || !(await canSeeLead(prisma, user, m.leadId))) return reply.code(409).send({ error: 'no_lead' });
      const logged = m.loggedAt || (await prisma.leadActivity.count({ where: { relatedType: 'email_message', relatedId: m.id } })) > 0;
      if (logged) return reply.code(409).send({ error: 'already_logged' });
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.emailMessage.updateMany({ where: { id: m.id, loggedAt: null }, data: { loggedAt: new Date() } });
        if (claimed.count === 0) throw new RuleError('already_logged');
        await tx.leadActivity.create({
          data: {
            leadId: m.leadId!, activityType: 'email', title: `${isInbound(m) ? 'Email received' : 'Email sent'} · ${m.subject}`,
            relatedType: 'email_message', relatedId: m.id, byUserId: user.id, occurredAt: m.occurredAt,
          },
        });
        await audit(tx, { entityType: 'lead', entityId: m.leadId!, action: 'update', userId: user.id, after: { emailMessageId: m.id } });
      });
      return reply.code(201).send({ id: m.id, leadId: m.leadId });
    });
  });

  app.post<{ Params: { id: string } }>('/mail/:id/link', pre, async (request, reply) => {
    const { leadId } = parseBody(MailLink, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const m = await ownMessage(prisma, user, request.params.id);
      const lead = await assertLeadVisible(prisma, user, leadId);
      const keepContact = m.contactId && lead.companyId && (await prisma.contact.count({ where: { id: m.contactId, companyId: lead.companyId } })) > 0;
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.emailMessage.update({
          where: { id: m.id }, data: { leadId: lead.id, companyId: lead.companyId, contactId: lead.contactId ?? (keepContact ? m.contactId : null) },
        });
        await linkConversation(tx, m, lead);
        return u;
      });
      return { id: updated.id, leadId: updated.leadId };
    });
  });

  // Create lead from this email (prototype): the lead form's duplicate check on the sender's domain, source Other,
  // a neutral note (the email itself stays private), a follow-up in 2 days, the allocation rules; the message is linked to it.
  app.post<{ Params: { id: string } }>('/mail/:id/create-lead', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const m = await ownMessage(prisma, user, request.params.id);
      if (!can(user.role, 'manage_leads')) return reply.code(403).send({ error: 'forbidden' });
      const email = isInbound(m) ? m.fromAddress : ((m.toAddresses as string[])[0] ?? '');
      const name = isInbound(m) ? m.fromName?.trim() : '';
      const match = (await findCompanyMatches(prisma, { name: '', businessEmail: email })).auto;
      const [first, ...rest] = (name && !name.includes('@') ? name : '').split(/\s+/);
      const due = new Date(dateOnly(todayIn(user.timezone)).getTime() + 2 * DAY_MS).toISOString().slice(0, 10);
      const input = LeadCreate.parse({
        companyName: (match?.name ?? nameFromDomain(email) ?? (name || email)).slice(0, 200),
        businessEmail: email || undefined,
        country: match?.country || 'United States',
        leadSource: 'Other',
        nextFollowUp: due,
        // Not the email's subject or text: the lead (and its audit trail) is shared, the mail is not.
        notes: 'Created from an email',
      });
      try {
        const leadId = await prisma.$transaction(async (tx) => {
          const created = await createLeadWithCompany(tx, { ...input, contactFirstName: first || null, contactLastName: rest.join(' ') || null, contactEmail: email || null }, user);
          await auditCreatedLead(tx, user.id, created);
          const l = created.lead;
          await tx.emailMessage.update({ where: { id: m.id }, data: { leadId: l.id, companyId: l.companyId, contactId: l.contactId } });
          await linkConversation(tx, m, l);
          return l.id;
        });
        // Release 4: AI research for a never-researched company with a website.
        await autoResearchForLead(leadId, user.id, (msg) => request.log.warn(msg));
        return reply.code(201).send({ id: m.id, leadId });
      } catch (e) {
        if (isUniqueViolation(e, 'domain')) {
          const taken = await domainTaken(checkDomain({ businessEmail: email }));
          if (taken) return reply.code(409).send(taken);
        }
        throw e;
      }
    });
  });

  // Add follow-up task (prototype): due tomorrow, assigned to you, on the message's lead. Tasks are seen by everyone who
  // sees the lead, so the title names no sender or subject (owner: nobody else sees anyone's mail).
  app.post<{ Params: { id: string } }>('/mail/:id/task', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const m = await ownMessage(prisma, user, request.params.id);
      if (!m.leadId || !(await canSeeLead(prisma, user, m.leadId))) return reply.code(409).send({ error: 'no_lead' });
      const dueDate = new Date(dateOnly(todayIn(user.timezone)).getTime() + DAY_MS);
      const task = await prisma.$transaction(async (tx) => {
        const t = await tx.task.create({
          data: { leadId: m.leadId, title: 'Reply to email', dueDate, assignedToId: user.id, origin: 'manual' },
        });
        await audit(tx, { entityType: 'task', entityId: t.id, action: 'create', userId: user.id, after: { id: t.id, leadId: t.leadId, dueDate: t.dueDate } });
        return t;
      });
      return reply.code(201).send({ id: task.id, leadId: task.leadId });
    });
  });
};
