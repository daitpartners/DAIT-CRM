import { Prisma, type EmailMessage } from '@prisma/client';
import { CLOSED_STATUSES, MAIL_VIEWS, type MAIL_CHIPS, type MAIL_SORTS, type MailListQuery, type MailView } from '@dait-crm/shared';
import { prisma } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { dateOnly, startOfDayIn, todayIn, ymd } from '../leads/dates.js';
import { leadWhere } from '../leads/visibility.js';

/**
 * The Email screen's list (web-mail release 2): folders, the Leads views, chips, the Filters panel, sort and conversation
 * view. Every filter is ANDed with the list's scope (mail/access.ts mailScope), so nothing here widens whose mail is read.
 */

/** The list's views (shared with the screen). An unknown view, the retired `unlinked` included, is the Inbox. */
export const VIEWS = MAIL_VIEWS;
export type ListSort = (typeof MAIL_SORTS)[number];
type Chip = (typeof MAIL_CHIPS)[number];
type Scope = { where: Prisma.EmailMessageWhereInput; ownerId: number | null };

/** Upper bound on Awaiting reply candidates; paging applies after the other filters. */
export const AWAITING_MAX = 5000;
/** Upper bound on the messages read to sort or group a list in memory (any sort but date, or conversation view). */
export const LIST_CANDIDATES_MAX = 5000;
/** Upper bound on the messages a Filters panel text field (From, To, Subject) or the Lead field matches. */
const FILTER_MATCH_MAX = 5000;
const DAY_MS = 86_400_000;
/** Messages of yours that answer a conversation (sent, or on their way from the CRM). */
const OUTGOING = ['sent', 'queued', 'sending'];
const NOT_DRAFT_OR_DELETED: Prisma.EmailMessageWhereInput = { folder: { notIn: ['drafts', 'deleted'] } };

export const viewOf = (view: string | undefined): MailView => ((VIEWS as readonly string[]).includes(view ?? '') ? (view as MailView) : 'inbox');

/** `%text%` for ILIKE, with ILIKE's own wildcards (and its escape character) matched literally. */
const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const ownerSql = (ownerId: number | null, alias = '') => (ownerId === null ? Prisma.sql`TRUE` : Prisma.sql`${Prisma.raw(alias)}user_id = ${ownerId}`);

/**
 * Ids of messages matching a search over subject, sender, recipients and text (case-insensitive), in one mailbox or,
 * `ownerId` null, in every mailbox (the caller ANDs the result with the list's scope).
 */
export async function searchIds(ownerId: number | null, s: string): Promise<number[]> {
  const like = likeOf(s);
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM email_messages WHERE ${ownerSql(ownerId)} AND (
      subject ILIKE ${like} OR from_address ILIKE ${like} OR coalesce(from_name, '') ILIKE ${like}
      OR to_addresses::text ILIKE ${like} OR cc_addresses::text ILIKE ${like} OR body_text ILIKE ${like})
    LIMIT 2000`;
  return rows.map((r) => r.id);
}

/**
 * Sent, linked messages with no later received message in their conversation (prototype "Awaiting reply"), in one
 * mailbox or, `ownerId` null, in every mailbox (ANDed with the list's scope by the caller).
 */
export async function awaitingIds(ownerId: number | null): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT s.id FROM email_messages s WHERE ${ownerSql(ownerId, 's.')} AND s.folder = 'sent' AND s.status IN ('sent', 'queued', 'sending')
      AND s.lead_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM email_messages r WHERE r.user_id = s.user_id AND r.status = 'received'
          AND r.thread_id IS NOT NULL AND r.thread_id = s.thread_id AND r.occurred_at > s.occurred_at)
    ORDER BY s.occurred_at DESC LIMIT ${AWAITING_MAX}`;
  return rows.map((r) => r.id);
}

/** Ids of messages whose sender, recipients and subject contain the Filters panel's texts (each given one), newest first. */
async function filterTextIds(ownerId: number | null, f: { from?: string; to?: string; subject?: string }): Promise<number[]> {
  const conds = [ownerSql(ownerId)];
  if (f.from) conds.push(Prisma.sql`(from_address ILIKE ${likeOf(f.from)} OR coalesce(from_name, '') ILIKE ${likeOf(f.from)})`);
  if (f.to) conds.push(Prisma.sql`to_addresses::text ILIKE ${likeOf(f.to)}`);
  if (f.subject) conds.push(Prisma.sql`subject ILIKE ${likeOf(f.subject)}`);
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT id FROM email_messages WHERE ${Prisma.join(conds, ' AND ')} ORDER BY occurred_at DESC LIMIT ${FILTER_MATCH_MAX}`;
  return rows.map((r) => r.id);
}

/**
 * Leads the Filters panel's Lead field finds: its number contains the text (any lead: the list shows numbers of leads
 * the viewer cannot open), or its company name does, for leads the viewer can see only.
 */
async function leadFilterIds(user: AuthUser, text: string): Promise<number[]> {
  const like = likeOf(text);
  const rows = await prisma.$queryRaw<{ id: number; by_number: boolean }[]>`
    SELECT l.id, (l.number ILIKE ${like}) AS by_number FROM leads l LEFT JOIN companies c ON c.id = l.company_id
    WHERE l.number ILIKE ${like} OR l.company_name ILIKE ${like} OR coalesce(c.name, '') ILIKE ${like}
    LIMIT ${FILTER_MATCH_MAX}`;
  const byName = rows.filter((r) => !r.by_number).map((r) => r.id);
  const visible = byName.length
    ? await prisma.lead.findMany({ where: { AND: [{ id: { in: byName } }, leadWhere(user, { includeArchived: true })] }, select: { id: true } })
    : [];
  return [...rows.filter((r) => r.by_number).map((r) => r.id), ...visible.map((l) => l.id)];
}

const shiftDay = (day: string, days: number) => ymd(new Date(dateOnly(day).getTime() + days * DAY_MS))!;
/** Received today or in the last 7 days / 30 days / 12 months: how many days before today the range starts. */
const DATE_BACK = { today: 0, '7d': 6, '30d': 29, '12m': 364 } as const;

const CHIP_WHERE: Record<Chip, Prisma.EmailMessageWhereInput | null> = {
  all: null,
  unread: { isRead: false },
  flagged: { flagStatus: 'flagged' },
  attachments: { attachmentNames: { not: [] } },
};

async function viewWhere(user: AuthUser, scope: Scope, view: MailView, now: Date): Promise<Prisma.EmailMessageWhereInput> {
  switch (view) {
    // The CRM's outbox: drafts waiting out the Undo window or their scheduled time, and sends on their way.
    case 'scheduled': return { source: 'crm', status: { in: ['queued', 'sending'] } };
    // Drafts and failed sends; a draft being sent stays in folder drafts until it leaves but is listed under Scheduled.
    case 'drafts': return { folder: 'drafts', status: { in: ['draft', 'failed'] } };
    case 'flagged': return { flagStatus: 'flagged', folder: { not: 'deleted' } };
    case 'awaiting': return { id: { in: await awaitingIds(scope.ownerId) } };
    case 'due':
      // Only leads the viewer can see: a hidden lead's status and follow-up are not shown, so they never place mail here.
      return {
        ...NOT_DRAFT_OR_DELETED,
        lead: { AND: [{ status: { notIn: [...CLOSED_STATUSES] }, nextFollowUp: { lte: dateOnly(todayIn(user.timezone, now)) } }, leadWhere(user, { includeArchived: true })] },
      };
    // My leads in your own scope; Team leads (Everyone, or another user's mailbox): any lead mail in the scope (F25).
    case 'mine':
      return scope.ownerId === user.id ? { ...NOT_DRAFT_OR_DELETED, lead: { assignedToId: user.id } } : { ...NOT_DRAFT_OR_DELETED, leadId: { not: null } };
    default: return { folder: view };
  }
}

/**
 * The list's filter: the scope, the view, the client / lead / project / search of release 1, the chip and the Filters
 * panel (From, To, Subject, Lead, Owner = the lead's assignee, Date in the viewer's zone, Has attachments).
 */
export async function listWhere(user: AuthUser, scope: Scope, q: MailListQuery, now: Date = new Date()): Promise<Prisma.EmailMessageWhereInput> {
  const and: Prisma.EmailMessageWhereInput[] = [scope.where, await viewWhere(user, scope, viewOf(q.view), now)];
  const company = Number(q.company);
  // Through a lead only when the user can see that lead (a lead moved to someone else does not place your mail).
  if (q.company && Number.isInteger(company)) {
    and.push({ OR: [{ companyId: company }, { lead: { AND: [{ companyId: company }, leadWhere(user, { includeArchived: true })] } }] });
  }
  const lead = Number(q.lead);
  if (q.lead && Number.isInteger(lead)) and.push({ leadId: lead });
  // Narrows the scope only (the scope filter above stays): a tag never shows mail outside it.
  const project = Number(q.project);
  if (q.project && Number.isInteger(project)) and.push({ projectId: project });
  const s = q.s?.trim().slice(0, 200);
  if (s) and.push({ id: { in: await searchIds(scope.ownerId, s) } });
  const chip = q.chip ? CHIP_WHERE[q.chip] : null;
  if (chip) and.push(chip);
  if (q.attachments === '1') and.push(CHIP_WHERE.attachments!);
  const text = { from: q.from?.trim(), to: q.to?.trim(), subject: q.subject?.trim() };
  if (text.from || text.to || text.subject) and.push({ id: { in: await filterTextIds(scope.ownerId, text) } });
  const leadQ = q.leadQ?.trim();
  if (leadQ) and.push({ leadId: { in: await leadFilterIds(user, leadQ) } });
  // The lead's assignee, of leads the viewer can see only (a hidden lead's owner is not shown).
  if (q.owner) and.push({ lead: { AND: [{ assignedToId: q.owner === 'me' ? user.id : Number(q.owner) }, leadWhere(user, { includeArchived: true })] } });
  if (q.date === 'custom') {
    if (q.since) and.push({ occurredAt: { gte: startOfDayIn(q.since, user.timezone) } });
    if (q.until) and.push({ occurredAt: { lt: startOfDayIn(shiftDay(q.until, 1), user.timezone) } });
  } else if (q.date) {
    const day = shiftDay(todayIn(user.timezone, now), -DATE_BACK[q.date]);
    and.push({ occurredAt: { gte: startOfDayIn(day, user.timezone) } });
  }
  return { AND: and };
}

/** What a list sorts and groups on, read for every message the filter leaves (at most LIST_CANDIDATES_MAX). */
export interface Candidate { id: number; userId: number; threadId: string | null; occurredAt: Date; fromKey: string; leadNumber: string | null; stageRank: number | null; sizeBytes: number }

/** A conversation: one owner's messages with the same thread; a message without a thread is its own. */
export const conversationKey = (m: { id: number; userId: number; threadId: string | null }) => `${m.userId}:${m.threadId ?? `id${m.id}`}`;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function sortKey(r: Candidate, sort: ListSort): string | number | null {
  switch (sort) {
    case 'date': return r.occurredAt.getTime();
    case 'from': return r.fromKey || null;
    case 'lead': return r.leadNumber;
    case 'stage': return r.stageRank;
    case 'size': return r.sizeBytes;
  }
}

const newestFirst = (a: Candidate, b: Candidate) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id;

/**
 * The list order: by the sort key (stage = the lead_status lookup order; lead numbers compare as numbers; a missing key
 * is last in either direction), ties newest first then id desc. In conversation view each conversation is one row, its
 * newest message (Outlook; R2 T7 ruling), whatever the sort and direction; those rows are then sorted by the key.
 */
export function orderCandidates(rows: Candidate[], sort: ListSort, dir: 'asc' | 'desc', conversation: boolean): Candidate[] {
  const sign = dir === 'asc' ? 1 : -1;
  let pool = rows;
  if (conversation) {
    const newest = new Map<string, Candidate>();
    for (const r of [...rows].sort(newestFirst)) if (!newest.has(conversationKey(r))) newest.set(conversationKey(r), r);
    pool = [...newest.values()];
  }
  return [...pool].sort((a, b) => {
    const ka = sortKey(a, sort);
    const kb = sortKey(b, sort);
    if (ka !== kb) {
      if (ka === null) return 1;
      if (kb === null) return -1;
      const c = typeof ka === 'string' ? collator.compare(ka, kb as string) : ka - (kb as number);
      if (c !== 0) return sign * c;
    }
    return newestFirst(a, b);
  });
}

/** The key of `counts` for a row: its conversation's, apart (`deleted:`) for a row in Deleted items, whose count includes deleted mail. */
export const countKey = (m: Pick<EmailMessage, 'id' | 'userId' | 'threadId' | 'folder'>) => `${m.folder === 'deleted' ? 'deleted:' : ''}${conversationKey(m)}`;

/**
 * What a list page shows beside each row: `replied` = received messages with a later message of yours (sent, queued or
 * sending) in the same owner's conversation; `counts` (by countKey) = the messages of each row's conversation in the
 * scope, Deleted items left out unless the row itself is there.
 */
export async function decorate(rows: EmailMessage[], scopeWhere: Prisma.EmailMessageWhereInput): Promise<{ replied: Set<number>; counts: Map<string, number> }> {
  const replied = new Set<number>();
  const counts = new Map<string, number>(rows.map((r) => [countKey(r), 1]));
  const threaded = rows.filter((r) => r.threadId !== null);
  if (!threaded.length) return { replied, counts };
  const pairs = (list: EmailMessage[]): Prisma.EmailMessageWhereInput => {
    const unique = new Map(list.map((r) => [conversationKey(r), { userId: r.userId, threadId: r.threadId }]));
    return { OR: [...unique.values()] };
  };
  const live = threaded.filter((r) => r.folder !== 'deleted');
  const binned = threaded.filter((r) => r.folder === 'deleted');
  const [later, liveCounts, binnedCounts] = await Promise.all([
    prisma.emailMessage.groupBy({ by: ['userId', 'threadId'], where: { AND: [pairs(threaded), { status: { in: OUTGOING } }] }, _max: { occurredAt: true } }),
    live.length
      ? prisma.emailMessage.groupBy({ by: ['userId', 'threadId'], where: { AND: [scopeWhere, pairs(live), { folder: { not: 'deleted' } }] }, _count: { _all: true } })
      : [],
    binned.length ? prisma.emailMessage.groupBy({ by: ['userId', 'threadId'], where: { AND: [scopeWhere, pairs(binned)] }, _count: { _all: true } }) : [],
  ]);
  const lastOut = new Map(later.map((g) => [`${g.userId}:${g.threadId}`, g._max.occurredAt]));
  for (const r of threaded) {
    const out = lastOut.get(conversationKey(r));
    if (r.status === 'received' && out && out > r.occurredAt) replied.add(r.id);
  }
  for (const g of liveCounts) counts.set(`${g.userId}:${g.threadId}`, g._count._all);
  for (const g of binnedCounts) counts.set(`deleted:${g.userId}:${g.threadId}`, g._count._all);
  return { replied, counts };
}
