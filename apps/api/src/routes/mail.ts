import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { Prisma, type EmailMessage, type Lead } from '@prisma/client';
import { BULK_MAX, LeadCreate, MailBulk, MailChange, MailCompose, MailLink, MailListQuery, MailRead, MailReply, can, replyRecipients, replySubject, checkDomain, domainOf, isFreeMail, pageArgs } from '@dait-crm/shared';
import { audit } from '../audit.js';
import { enqueue } from '../jobs/queue.js';
import { BODY_MAX } from '../jobs/handlers/syncMailbox.js';
import { GraphError, isAuthFailure, type GraphClient } from '../graph/client.js';
import type { GraphBody } from '../mail/html.js';
import { processEmailBody, storedColumns } from '../mail/bodies.js';
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
import { canSeeTeamMail, mailScope, messageFor, teamReadableWhere } from '../mail/access.js';
import { changeMany, changeMessage } from '../mail/changes.js';
import { LIST_CANDIDATES_MAX, conversationKey, countKey, decorate, listWhere, orderCandidates, type Candidate } from '../mail/list.js';
import { assertProjectFor, queueOutgoing } from '../mail/outgoing.js';
import { leadPanel } from '../mail/leadPanel.js';
import { participantsOf } from '../mail/leadMail.js';
import { FORMATTED_BODY_LIMIT, outgoingBody, perUser } from '../mail/formatted.js';
import { outgoingWithFiles } from '../mail/templateFiles.js';
import { projectWhere } from '../projects/visibility.js';
import { emailView } from './leadEmails.js';
import { domainTaken, guard, lockLeads } from './leads.js';

type Tx = Prisma.TransactionClient;

const PREVIEW = 120;
/** `GET /mail/meta`: only the list's scope. */
const MailMetaQuery = MailListQuery.pick({ mailOf: true });
const DAY_MS = 86_400_000;
/** Opening a message marks it read in the mailbox through a job, retried a little (2, 4 minutes); the next sync shows Outlook's state anyway. */
const ACTION_ATTEMPTS = 3;

const leadRef = { select: { id: true, number: true, status: true, priority: true, nextFollowUp: true, companyId: true, companyName: true, assignedToId: true } } as const;
type WithLead = EmailMessage & {
  lead: { id: number; number: string; status?: string } | null; project?: { id: number; number: string } | null; user: { id: number; name: string };
  /** The message's lead is one the viewer cannot see (another owner's): only its number is shown. */
  leadRestricted?: boolean;
};

/** A message's one-line preview (list rows and the conversation): its text, spaces collapsed, PREVIEW characters. */
const previewOf = (m: EmailMessage) => m.bodyText.replace(/\s+/g, ' ').trim().slice(0, PREVIEW);

/**
 * A message in the list: no body, a short one-line preview. `owner` is the user whose mailbox it is; `viewOnly` when
 * that is not the viewer (team view: read, log and tasks only). `leadRestricted`: the lead is another owner's that the
 * viewer cannot open, so the item keeps its number only (no lead id, no company id, no status). `shown` (mail/list.ts
 * decorate): whether you replied, and how many messages its conversation has.
 */
function listItem(m: WithLead, viewerId: number, shown: { replied: boolean; conversationCount: number }) {
  const restricted = m.leadRestricted === true;
  return {
    owner: { id: m.user.id, name: m.user.name }, viewOnly: m.userId !== viewerId,
    id: m.id, folder: m.folder, status: m.status, fromAddress: m.fromAddress, fromName: m.fromName, toAddresses: m.toAddresses as string[],
    subject: m.subject, preview: previewOf(m), occurredAt: m.occurredAt, isRead: m.isRead,
    leadId: restricted ? null : m.leadId, leadNumber: m.lead?.number ?? null, companyId: restricted ? null : m.companyId, leadRestricted: restricted,
    hasAttachments: (m.attachmentNames as string[]).length > 0,
    projectId: m.project?.id ?? null, projectNumber: m.project?.number ?? null,
    flagStatus: m.flagStatus, flagDue: ymd(m.flagDue), replied: shown.replied, conversationCount: shown.conversationCount,
    leadStatus: restricted ? null : (m.lead?.status ?? null),
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
 * conversation in its owner's mailbox. `kind` words the event ("sent by Maya", "reply received", "received"),
 * `by` is the sender's first name (else the mailbox owner's, `ownerName`) for the owner's mail other than the open
 * message, `unmatched` marks mail with no lead and no contact. Each item also carries what the reading pane's
 * conversation shows (web-mail release 2): sender, recipients, the list's preview, attachments, folder and read state.
 */
function threadHistory(ownerName: string, open: EmailMessage, others: EmailMessage[]) {
  const all = [...others, open].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id);
  return all.map((t, i) => {
    const inbound = isInbound(t);
    // A reply answers your own mail: the message before it (drafts aside) is yours, or "Re:" when it starts the list.
    const before = all.slice(i + 1).find((o) => o.status !== 'draft');
    const kind = t.status === 'draft' ? 'draft' : !inbound ? 'sent' : (before ? !isInbound(before) : REPLY_SUBJECT.test(t.subject)) ? 'reply' : 'received';
    // Your own open message reads plain "sent" (prototype E-6); your other mail in the thread "sent by <first name>".
    const by = inbound || t.id === open.id ? null : ((t.fromName || ownerName).trim().split(/\s+/)[0] ?? null);
    return {
      id: t.id, occurredAt: t.occurredAt, direction: inbound ? 'in' : 'out', who: counterpart(t), subject: t.subject,
      kind, by, unmatched: !t.leadId && !t.contactId,
      fromName: t.fromName, fromAddress: t.fromAddress, toAddresses: t.toAddresses as string[], ccAddresses: t.ccAddresses as string[],
      preview: previewOf(t), hasAttachments: (t.attachmentNames as string[]).length > 0, folder: t.folder, isRead: t.isRead,
    };
  });
}

/**
 * Linking a message (Link to lead, Create lead) also links the user's other mail in the same conversation that has no
 * lead yet, so the thread does not keep showing it as unmatched. Left alone: drafts, mail on another lead and mail
 * matched to another company. As /link: the lead's contact, else the row's own contact only when it belongs
 * to the lead's company. Linking clears a deleted-lead mark (`lead_deleted_at`), as /link and /create-lead do.
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
    await db.emailMessage.update({ where: { id: r.id }, data: { leadId: lead.id, companyId: lead.companyId, contactId: lead.contactId ?? keep, leadDeletedAt: null } });
  }
}

/** Queues the change in the user's mailbox (messages that came from it only); used when a message is opened. */
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

/** The reader waits at most this long for an older message's body (a send waits 20 s). */
const BODY_FETCH_TIMEOUT_MS = 4000;
/** After a refusal (401/403) or FAILS_BEFORE_PAUSE failures in a row, a mailbox is not asked for bodies for this long. */
const BODY_FETCH_PAUSE_MS = 30 * 60_000;
const FAILS_BEFORE_PAUSE = 3;
/** By mailbox (account id): failures in a row, and until when it is not asked. In memory: the API is one process. */
const bodyFetchState = new Map<number, { fails: number; pausedUntil: number }>();

/** Forgets every pause (tests). */
export function resetBodyFetchBackoff(): void {
  bodyFetchState.clear();
}

function noteBodyFetchFailure(accountId: number, err: unknown): void {
  const state = bodyFetchState.get(accountId) ?? { fails: 0, pausedUntil: 0 };
  state.fails += 1;
  const refused = isAuthFailure(err) || (err instanceof GraphError && err.status === 403);
  if (refused || state.fails >= FAILS_BEFORE_PAUSE) state.pausedUntil = Date.now() + BODY_FETCH_PAUSE_MS;
  bodyFetchState.set(accountId, state);
}

/**
 * The HTML body of a message synced before bodies were kept as HTML (owner, 23 Nov 2026), read once when it is opened:
 * `m` comes from messageFor (the caller's own, or team view), and the body is read only from the mailbox it came from
 * while that is still its owner's (`m.userId`) connected personal one. Team view (controller ruling 2): an
 * Administrator or Manager gets it the same way, from the owner's mailbox, read only (a GET that never marks the
 * message read); the sanitised body is kept as a cache. Sanitised and stored with the cleaner text. A message the
 * mailbox no longer has (or a plain-text one) is marked '' and not asked again. Any other failure leaves the text body
 * to show; the fetch waits at most 4 s, and a mailbox that refuses (401/403) or fails three times in a row is left
 * alone for 30 minutes (security review I3). A row deleted meanwhile gives 404.
 */
async function fillHtmlBody(graph: GraphClient, log: FastifyBaseLogger, m: EmailMessage): Promise<EmailMessage> {
  if (m.bodyHtml !== null || !m.graphId || m.accountId === null) return m;
  if ((bodyFetchState.get(m.accountId)?.pausedUntil ?? 0) > Date.now()) return m;
  const account = await prisma.emailAccount.findFirst({ where: { id: m.accountId, userId: m.userId, kind: 'personal', status: 'connected' } });
  if (!account) return m;
  let body: GraphBody | null = null;
  try {
    body = await graph.messageBody(account, m.graphId, { timeoutMs: BODY_FETCH_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof GraphError && err.status === 404)) {
      noteBodyFetchFailure(account.id, err);
      // The error's kind and HTTP status only: never its message (the mail is private to its owner).
      log.warn({ emailMessageId: m.id, errName: (err as Error)?.name, status: err instanceof GraphError ? err.status : undefined }, 'mail body fetch failed');
      return m;
    }
  }
  bodyFetchState.delete(account.id);
  // Parsed in a worker thread with a time limit, so a hostile email cannot hold up the API for everyone.
  const result = body ? await processEmailBody(body, BODY_MAX, { retryKey: `${m.userId}:${m.graphId}` }) : null;
  if (result?.fellBack) log.warn({ emailMessageId: m.id, reason: result.reason }, 'mail body fell back to plain text');
  const stored = result ? storedColumns(result) : null;
  // Only a row still without its HTML (two opens at once store it once); then read back: gone meanwhile is a 404. A
  // plain-text body is marked '' (not asked again); a first timeout or crash stays null, to be tried once more.
  await prisma.emailMessage.updateMany({
    where: { id: m.id, userId: m.userId, bodyHtml: null },
    data: stored ? { bodyHtml: result!.retry ? null : (stored.bodyHtml ?? ''), bodyText: stored.bodyText } : { bodyHtml: '' },
  });
  const fresh = await prisma.emailMessage.findFirst({ where: { id: m.id, userId: m.userId } });
  if (!fresh) throw new NotFoundError();
  return fresh;
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
 * The Email screen (release 2B-2). Privacy (owner, 22 Nov 2026): a message belongs to the user whose mailbox it is.
 * Web-mail release 1 (mail/access.ts): Administrators and Managers (`view_team_mail`) also read every other user's lead
 * mail, view only: they may open it (never marking it read, audited), log it and add a task, but every change to
 * another user's mailbox (reply, read/unread, archive, link, create lead) is 403 view_only. Everyone else reaches
 * only their own messages (another user's is 404). Enforced here, on every route.
 * Web-mail release 2: mailbox changes go to Outlook first, inline; a refusal changes nothing.
 */
export const mailRoutes: FastifyPluginAsync = async (app) => {
  const pre = { preHandler: [requireRight('use_email')] };

  // Compose (prototype V.compose): optionally on a lead or for a client; otherwise linked by matching.
  // A formatted message carries its HTML: a larger request, sanitised again here (after the cheap checks, before the
  // transaction), and at most 30 sends a minute per user.
  const send = { ...pre, bodyLimit: FORMATTED_BODY_LIMIT, config: perUser(30) };
  app.post('/mail', send, async (request, reply) => {
    const body = parseBody(MailCompose, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const account = await myMailbox(user.id);
      if (!account) return reply.code(409).send({ error: 'no_mailbox' });
      if (body.leadId) await assertLeadVisible(prisma, user, body.leadId);
      const message = await outgoingWithFiles(body.body, body.bodyHtml, body.templateId, body.attachmentIds);
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
          lead, ...links, to: [body.to], cc: body.cc, subject: body.subject, ...message, projectId: body.projectId ?? null,
        });
      });
      return reply.code(201).send(emailView(created));
    });
  });

  // Reply (prototype Reply): to the sender of a received message, or the recipients of your own; same conversation.
  // Web-mail release 2: also Reply all (those and the original To, never your own addresses) and Forward (to the `to`
  // given; it keeps the conversation and lead too). Recipients and subject: shared replyRecipients / replySubject.
  // Only from your own mailbox: another user's message is view only (403) or not yours to see (404).
  app.post<{ Params: { id: string } }>('/mail/:id/reply', send, async (request, reply) => {
    const body = parseBody(MailReply, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const { m: original } = await messageFor(prisma, user, request.params.id, 'change');
      if (original.status === 'draft') return reply.code(409).send({ error: 'draft' });
      const account = await myMailbox(user.id);
      if (!account) return reply.code(409).send({ error: 'no_mailbox' });
      const message = await outgoingBody(body.body, body.bodyHtml);
      const own = [account.address, ...(account.sendAs ? [account.sendAs] : [])];
      const { to } = replyRecipients({ ...original, toAddresses: original.toAddresses as string[] }, body.mode, own, body.to);
      const subject = replySubject(original.subject, body.mode);
      const created = await prisma.$transaction(async (tx) => {
        const lead = original.leadId && (await canSeeLead(tx, user, original.leadId))
          ? await lockedLead(tx, user, original.leadId).catch((e) => {
            // Only a lead gone in the meantime is skipped; a database error must not send the reply without its lead.
            if (e instanceof NotFoundError) return null;
            throw e;
          })
          : null;
        return queueOutgoing(tx, user, account, {
          lead, companyId: original.companyId, contactId: original.contactId, to, cc: body.cc, subject, ...message,
          replyToId: original.id, replyMode: body.mode, threadId: original.threadId, projectId: original.projectId,
        });
      });
      return reply.code(201).send(emailView(created));
    });
  });

  // The message list, paged (owner, 22 Nov 2026): every filter applies first (mail/list.ts listWhere: the view, chip,
  // Filters panel, client, lead, project and search), `total` counts the rows they leave (`count=0`, the later batches
  // of the scrolling list: no total). `mailOf` (mailScope): your own mail by default; `all` or a user id needs
  // `view_team_mail` and adds only other users' team-readable mail, each item with its owner. Web-mail release 2:
  // conversation view (the default, `conv=0` turns it off) shows one row per owner's conversation; sorting by date
  // without it pages in the database, anything else sorts and groups up to LIST_CANDIDATES_MAX messages in memory, and
  // `total` then counts rows, not messages. Each row's `conversationIds` are its conversation's messages in this view
  // (at most BULK_MAX), which the screen's actions change together.
  app.get('/mail', pre, async (request) => {
    const user = request.user!;
    const q = parseQuery(MailListQuery, request.query);
    const scope = mailScope(user, q.mailOf);
    const where = await listWhere(user, scope, q);
    const sort = q.sort ?? 'date';
    const dir = q.dir ?? 'desc';
    const conversation = q.conv !== '0';
    const include = { lead: { select: { id: true, number: true, status: true } }, user: { select: { id: true, name: true } } } as const;
    let rows: Prisma.EmailMessageGetPayload<{ include: typeof include }>[];
    let total: number | null;
    let conversationIds = (m: EmailMessage): number[] => [m.id];
    if (sort === 'date' && !conversation) {
      [rows, total] = await Promise.all([
        prisma.emailMessage.findMany({ where, include, orderBy: [{ occurredAt: dir }, { id: dir }], ...pageArgs(q) }),
        q.count === '0' ? null : prisma.emailMessage.count({ where }),
      ]);
    } else {
      const found = await prisma.emailMessage.findMany({
        where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: LIST_CANDIDATES_MAX,
        select: { id: true, userId: true, threadId: true, occurredAt: true, fromName: true, fromAddress: true, sizeBytes: true, leadId: true, lead: { select: { number: true, status: true } } },
      });
      // Stage follows the lead_status lookup order; a lead the viewer cannot see sorts as having none (its status is not shown).
      const stages = sort === 'stage'
        ? new Map((await prisma.lookupValue.findMany({ where: { group: 'lead_status' }, select: { value: true, sortOrder: true } })).map((l) => [l.value, l.sortOrder]))
        : null;
      const stageLeads = stages ? [...new Set(found.flatMap((c) => (c.leadId ? [c.leadId] : [])))] : [];
      const seen = new Set(stageLeads.length
        ? (await prisma.lead.findMany({ where: { AND: [{ id: { in: stageLeads } }, leadWhere(user, { includeArchived: true })] }, select: { id: true } })).map((l) => l.id)
        : []);
      const candidates: Candidate[] = found.map((c) => ({
        id: c.id, userId: c.userId, threadId: c.threadId, occurredAt: c.occurredAt, fromKey: (c.fromName || c.fromAddress).trim().toLowerCase(),
        leadNumber: c.lead?.number ?? null, sizeBytes: c.sizeBytes,
        stageRank: stages && c.lead && c.leadId !== null && seen.has(c.leadId) ? (stages.get(c.lead.status) ?? null) : null,
      }));
      const ordered = orderCandidates(candidates, sort, dir, conversation);
      total = q.count === '0' ? null : ordered.length;
      const pageIds = ordered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((c) => c.id);
      const byId = new Map((await prisma.emailMessage.findMany({ where: { id: { in: pageIds } }, include })).map((m) => [m.id, m]));
      rows = pageIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      if (conversation) {
        const members = new Map<string, number[]>();
        for (const c of found) {
          const ids = members.get(conversationKey(c)) ?? [];
          if (ids.length < BULK_MAX) members.set(conversationKey(c), [...ids, c.id]);
        }
        conversationIds = (m) => members.get(conversationKey(m)) ?? [m.id];
      }
    }
    // A lead the user cannot see (another owner's) shows its number only: no lead id, no company id, no status.
    const leadIds = [...new Set(rows.flatMap((m) => (m.leadId ? [m.leadId] : [])))];
    const [visibleRows, projects, shown] = await Promise.all([
      leadIds.length ? prisma.lead.findMany({ where: { AND: [{ id: { in: leadIds } }, leadWhere(user, { includeArchived: true })] }, select: { id: true } }) : [],
      visibleProjects(user, rows.map((m) => m.projectId)),
      decorate(rows, scope.where),
    ]);
    const visible = new Set(visibleRows.map((l) => l.id));
    return {
      items: rows.map((m) => ({
        ...listItem({
          ...m, leadRestricted: m.leadId !== null && !visible.has(m.leadId), project: m.projectId ? projects.get(m.projectId) ?? null : null,
        }, user.id, { replied: shown.replied.has(m.id), conversationCount: shown.counts.get(countKey(m)) ?? 1 }),
        conversationIds: conversationIds(m),
      })),
      total, page: q.page, pageSize: q.pageSize,
    };
  });

  // The screen's counts and filter lists follow the list's scope (`mailOf`, as GET /mail); `mailbox` is always the
  // caller's own. `mailUsers` (the "Mail of:" picker): with `view_team_mail`, the other active users who have a
  // personal mailbox, by name; otherwise empty. `counts` (web-mail release 2), by the list's own views: Inbox = unread,
  // Drafts, Scheduled, Flagged and Awaiting reply = messages, Follow-up due today and My leads / Team leads (`leads`) =
  // distinct leads with mail there. `leadOwners`: the Filters panel's Owner choices (active users, by name).
  app.get('/mail/meta', pre, async (request) => {
    const user = request.user!;
    const listScope = mailScope(user, parseQuery(MailMetaQuery, request.query).mailOf);
    const scope = listScope.where;
    const viewWhere = (view: string, chip?: 'unread') => listWhere(user, listScope, { page: 1, pageSize: 1, view, chip });
    const count = async (view: string, chip?: 'unread') => prisma.emailMessage.count({ where: await viewWhere(view, chip) });
    const leadsIn = async (view: string) => (await prisma.emailMessage.findMany({
      where: { AND: [await viewWhere(view), { leadId: { not: null } }] }, distinct: ['leadId'], select: { leadId: true },
    })).length;
    const [mailbox, inbox, drafts, scheduled, flagged, awaiting, due, leadCount, companyIds, leadIds, mailUsers, leadOwners] = await Promise.all([
      prisma.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: { not: 'disconnected' } }, select: { id: true, address: true, status: true, lastSyncAt: true } }),
      count('inbox', 'unread'), count('drafts'), count('scheduled'), count('flagged'), count('awaiting'), leadsIn('due'), leadsIn('mine'),
      prisma.emailMessage.findMany({ where: { AND: [scope, { companyId: { not: null } }] }, distinct: ['companyId'], select: { companyId: true } }),
      prisma.emailMessage.findMany({ where: { AND: [scope, { leadId: { not: null } }] }, distinct: ['leadId'], select: { leadId: true } }),
      canSeeTeamMail(user)
        ? prisma.user.findMany({
          where: { id: { not: user.id }, isActive: true, emailAccounts: { some: { kind: 'personal' } } },
          select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        })
        : [],
      prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
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
    return {
      mailbox, unread: inbox, counts: { inbox, drafts, scheduled, flagged, awaiting, due, leads: leadCount },
      companies, leads, projects, mailUsers, leadOwners,
    };
  });

  // `peek=1`: the first message shown on arrival, which the user has not opened yet, stays unread.
  // Another user's message (team view, view only): never marked read and nothing queued for their mailbox, peek or
  // not; its thread comes from the owner's team-readable mail; every open is audited (who, which message, whose
  // mailbox; never subject, body or addresses).
  app.get<{ Params: { id: string }; Querystring: { peek?: string } }>('/mail/:id', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const found = await messageFor(prisma, user, request.params.id, 'read');
      const viewOnly = found.viewOnly;
      // Recorded before the body is fetched, so an open is audited even when Microsoft fails.
      if (viewOnly) await audit(prisma, { entityType: 'email_message', entityId: found.m.id, action: 'view', userId: user.id, after: { ownerId: found.m.userId } });
      let m = await fillHtmlBody(app.graph, request.log, found.m);
      if (!viewOnly && !m.isRead && request.query.peek !== '1') {
        m = await prisma.emailMessage.update({ where: { id: m.id }, data: { isRead: true } });
        await tellMailbox(prisma, m, 'read');
      }
      const owner = viewOnly ? await prisma.user.findUniqueOrThrow({ where: { id: m.userId }, select: { id: true, name: true } }) : { id: user.id, name: user.name };
      const threadWhere: Prisma.EmailMessageWhereInput = { userId: m.userId, threadId: m.threadId, id: { not: m.id } };
      // Another owner's lead (one the viewer cannot see): its number and company name only; no lead, contact or company.
      const hidden = m.leadId !== null && !(await canSeeLead(prisma, user, m.leadId));
      // The list's scope for this message (its owner's mail, team-readable only in team view), for its conversation count.
      const scopeWhere: Prisma.EmailMessageWhereInput = viewOnly ? { AND: [{ userId: m.userId }, teamReadableWhere] } : { userId: user.id };
      const participants = participantsOf({
        from: m.fromAddress, to: m.toAddresses as string[], cc: m.ccAddresses as string[], bcc: m.bccAddresses as string[],
      });
      const [restricted, lead, contact, company, thread, projects, shown, panel] = await Promise.all([
        hidden ? prisma.lead.findUnique({ where: { id: m.leadId! }, select: { number: true, companyName: true, company: { select: { name: true } } } }) : null,
        m.leadId && !hidden ? prisma.lead.findUnique({ where: { id: m.leadId }, ...leadRef }) : null,
        m.contactId && !hidden ? prisma.contact.findUnique({ where: { id: m.contactId }, select: { id: true, firstName: true, lastName: true } }) : null,
        m.companyId && !hidden ? prisma.company.findUnique({ where: { id: m.companyId }, select: { id: true, name: true } }) : null,
        m.threadId
          ? prisma.emailMessage.findMany({ where: viewOnly ? { AND: [threadWhere, teamReadableWhere] } : threadWhere, orderBy: { occurredAt: 'desc' }, take: THREAD_MAX - 1 })
          : [],
        visibleProjects(user, [m.projectId]),
        decorate([m], scopeWhere),
        // The lead panel: a visible lead only; a restricted lead keeps `restrictedLead` (number and company name) only.
        m.leadId && !hidden ? leadPanel(prisma, user, m.leadId, participants) : null,
      ]);
      return {
        ...listItem({
          ...m, user: owner,
          lead: lead ? { id: lead.id, number: lead.number, status: lead.status } : restricted ? { id: m.leadId!, number: restricted.number } : null,
          leadRestricted: hidden, project: m.projectId ? projects.get(m.projectId) ?? null : null,
        }, user.id, { replied: shown.replied.has(m.id), conversationCount: shown.counts.get(countKey(m)) ?? 1 }),
        restrictedLead: restricted ? { number: restricted.number, companyName: restricted.company?.name ?? restricted.companyName } : null,
        ccAddresses: m.ccAddresses as string[], bodyText: m.bodyText, bodyHtml: m.bodyHtml || null, attachmentNames: m.attachmentNames as string[], loggedAt: m.loggedAt,
        lead: lead ? { id: lead.id, number: lead.number, status: lead.status, priority: lead.priority, nextFollowUp: ymd(lead.nextFollowUp), companyId: lead.companyId } : null,
        contact: contact ? { id: contact.id, name: `${contact.firstName} ${contact.lastName}`.trim() } : null,
        company,
        thread: threadHistory(owner.name, m, thread),
        leadPanel: panel,
      };
    });
  });

  // Mailbox changes (web-mail release 2, mail/changes.ts) go to Outlook first, inline; a refusal changes nothing (the
  // answer says why: mailbox_not_connected, outlook_refused, outlook_busy, sending, draft). Your own messages only:
  // another user's is 403 view_only and Outlook is never asked. Delete moves to Deleted items; Delete in Deleted items
  // deletes for good (the screen confirms first).
  app.post<{ Params: { id: string } }>('/mail/:id/change', pre, async (request, reply) => {
    const change = parseBody(MailChange, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const { m } = await messageFor(prisma, user, request.params.id, 'change');
      return changeMessage(app.graph, user, m, change);
    });
  });

  // The same change to a selection or a conversation's messages (at most BULK_MAX): always 200, each id done or failed
  // with its reason (view_only, not_found or a change error). The log carries counts and reasons only.
  app.post('/mail/bulk', pre, async (request) => {
    const { ids, change } = parseBody(MailBulk, request.body);
    const result = await changeMany(app.graph, request.user!, ids, change);
    if (result.failed.length) {
      const reasons: Record<string, number> = {};
      for (const f of result.failed) reasons[f.error] = (reasons[f.error] ?? 0) + 1;
      request.log.warn({ change: change.type, done: result.done.length, failed: result.failed.length, reasons }, 'bulk mailbox change partly refused');
    }
    return result;
  });

  // Read / unread and archive (release 2B-2 answers kept), now through Outlook inline as /change.
  app.post<{ Params: { id: string } }>('/mail/:id/read', pre, async (request, reply) => {
    const { isRead } = parseBody(MailRead, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const { m } = await messageFor(prisma, user, request.params.id, 'change');
      const changed = await changeMessage(app.graph, user, m, { type: 'read', isRead });
      return { id: changed.id, isRead: changed.isRead };
    });
  });

  app.post<{ Params: { id: string } }>('/mail/:id/archive', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const { m } = await messageFor(prisma, user, request.params.id, 'change');
      const changed = await changeMessage(app.graph, user, m, { type: 'move', folder: 'archive' });
      return { id: changed.id, folder: changed.folder };
    });
  });

  // Log as activity (prototype): once per message, on its lead; the subject is the sender's alone. Also on another
  // user's lead mail in team view: the activity is by the viewer, and the owner's mailbox is not changed.
  app.post<{ Params: { id: string } }>('/mail/:id/log', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const { m } = await messageFor(prisma, user, request.params.id, 'crm');
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

  // Link to lead: your own messages only (another user's is 403 view_only).
  app.post<{ Params: { id: string } }>('/mail/:id/link', pre, async (request, reply) => {
    const { leadId } = parseBody(MailLink, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const { m } = await messageFor(prisma, user, request.params.id, 'change');
      const lead = await assertLeadVisible(prisma, user, leadId);
      const keepContact = m.contactId && lead.companyId && (await prisma.contact.count({ where: { id: m.contactId, companyId: lead.companyId } })) > 0;
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.emailMessage.update({
          where: { id: m.id },
          data: { leadId: lead.id, companyId: lead.companyId, contactId: lead.contactId ?? (keepContact ? m.contactId : null), leadDeletedAt: null },
        });
        await linkConversation(tx, m, lead);
        return u;
      });
      return { id: updated.id, leadId: updated.leadId };
    });
  });

  // Create lead from this email (prototype): the lead form's duplicate check on the sender's domain, source Other,
  // a neutral note (the email itself stays private), a follow-up in 2 days, the allocation rules; the message is linked to it.
  // Your own messages only (another user's is 403 view_only).
  app.post<{ Params: { id: string } }>('/mail/:id/create-lead', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const { m } = await messageFor(prisma, user, request.params.id, 'change');
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
          await tx.emailMessage.update({ where: { id: m.id }, data: { leadId: l.id, companyId: l.companyId, contactId: l.contactId, leadDeletedAt: null } });
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
  // sees the lead, so the title names no sender or subject (Sales reps see only their own mail). Also on another
  // user's lead mail in team view: the task is the viewer's.
  app.post<{ Params: { id: string } }>('/mail/:id/task', pre, async (request, reply) => {
    const user = request.user!;
    return guard(reply, async () => {
      const { m } = await messageFor(prisma, user, request.params.id, 'crm');
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
