/**
 * One-off clean-up for the lead mail timeline (CLI `cli/mail-dedupe.ts`, run once after the release is live): merges
 * the duplicate rows the lead-mail backfill (search, regular Graph ids) and delta sync (immutable ids) left for one
 * email before `storeMessage` matched by internet message id.
 *
 * A group is a user's rows with the same non-null `message_id` on the same side (`mail/direction.ts`, the rule
 * `storeMessage` matches by), more than one row. The kept row is the one delta stored (Graph id `AAkALg…`, so a later
 * delta removal finds it); when none or several are, the lowest id. The kept row takes from the removed rows what it
 * has not got itself (lead, contact, company, project, `logged_at`); timeline lines, replies, Mailer recipients and
 * quotations pointing at a removed row then point at the kept one, and the removed rows are deleted. One transaction
 * per group.
 *
 * Logs counts only (never subjects, bodies or addresses). Safe to run again: a second run finds no groups.
 */
import type { EmailMessage, Prisma, PrismaClient } from '@prisma/client';
import { mailSide } from './direction.js';

export interface DedupeCounts {
  groups: number;
  removed: number;
  /** Kept rows that gained a lead, contact, company, project or `logged_at` from a removed row. */
  linksCarried: number;
  /** Timeline lines, replies, Mailer recipients and quotations moved from a removed row to the kept one. */
  referencesMoved: number;
}

/** Graph immutable ids (what delta sync stores) start with this. */
const DELTA_ID_PREFIX = 'AAkALg';

const CARRIED = ['leadId', 'contactId', 'companyId', 'projectId', 'loggedAt'] as const;

export const DEDUPE_USAGE = 'usage: mail-dedupe [--dry-run | --apply]  (no flag = dry run)';

/**
 * CLI arguments of `cli/mail-dedupe.ts`. The real run needs an explicit `--apply`; no flag or `--dry-run` is a dry run.
 * An unknown argument, or `--apply` with `--dry-run`, is an error (so a mistyped flag never deletes).
 */
export function parseDedupeArgs(argv: string[]): { apply: boolean } | { error: string } {
  const known = new Set(['--dry-run', '--apply']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(' ')}` };
  if (argv.includes('--apply') && argv.includes('--dry-run')) return { error: '--apply and --dry-run together' };
  return { apply: argv.includes('--apply') };
}

/** The duplicate groups: ids of each group, lowest first. */
async function findGroups(db: PrismaClient): Promise<number[][]> {
  const pairs = await db.emailMessage.groupBy({
    by: ['userId', 'messageId'], where: { messageId: { not: null } }, having: { id: { _count: { gt: 1 } } },
  });
  if (pairs.length === 0) return [];
  const rows = await db.emailMessage.findMany({
    where: { OR: pairs.map((p) => ({ userId: p.userId, messageId: p.messageId })) },
    select: { id: true, userId: true, messageId: true, status: true, folder: true },
    orderBy: { id: 'asc' },
  });
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.userId, r.messageId, mailSide(r)]);
    groups.set(key, [...(groups.get(key) ?? []), r.id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

/** The row to keep: the only delta-stored one, else the lowest id. `rows` are lowest id first. */
function keeperOf(rows: EmailMessage[]): EmailMessage {
  const delta = rows.filter((r) => r.graphId?.startsWith(DELTA_ID_PREFIX));
  return delta.length === 1 ? delta[0]! : rows[0]!;
}

/** Merges one group (read again here, in case it changed since it was found); writes only when `apply`. */
async function mergeGroup(db: Prisma.TransactionClient, ids: number[], apply: boolean): Promise<DedupeCounts> {
  const found = await db.emailMessage.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
  const first = found[0];
  const rows = first
    ? found.filter((r) => r.userId === first.userId && r.messageId !== null && r.messageId === first.messageId && mailSide(r) === mailSide(first))
    : [];
  if (rows.length < 2) return { groups: 0, removed: 0, linksCarried: 0, referencesMoved: 0 };

  const kept = keeperOf(rows);
  const removedIds = rows.filter((r) => r.id !== kept.id).map((r) => r.id);
  const carry: Partial<Pick<EmailMessage, (typeof CARRIED)[number]>> = {};
  for (const field of CARRIED) {
    if (kept[field] !== null) continue;
    const from = rows.find((r) => r.id !== kept.id && r[field] !== null);
    if (from) Object.assign(carry, { [field]: from[field] });
  }

  const lines = { relatedType: 'email_message', relatedId: { in: removedIds } };
  const replies = { replyToId: { in: removedIds }, id: { notIn: [kept.id, ...removedIds] } };
  const recipients = { emailMessageId: { in: removedIds } };
  const quotations = { sendingMessageId: { in: removedIds } };
  let referencesMoved: number;
  if (apply) {
    if (Object.keys(carry).length > 0) await db.emailMessage.update({ where: { id: kept.id }, data: carry });
    const moved = await Promise.all([
      db.leadActivity.updateMany({ where: lines, data: { relatedId: kept.id } }),
      db.emailMessage.updateMany({ where: replies, data: { replyToId: kept.id } }),
      db.emailCampaignRecipient.updateMany({ where: recipients, data: { emailMessageId: kept.id } }),
      db.quotation.updateMany({ where: quotations, data: { sendingMessageId: kept.id } }),
    ]);
    referencesMoved = moved.reduce((n, r) => n + r.count, 0);
    await db.emailMessage.deleteMany({ where: { id: { in: removedIds } } });
  } else {
    const counted = await Promise.all([
      db.leadActivity.count({ where: lines }),
      db.emailMessage.count({ where: replies }),
      db.emailCampaignRecipient.count({ where: recipients }),
      db.quotation.count({ where: quotations }),
    ]);
    referencesMoved = counted.reduce((n, c) => n + c, 0);
  }
  return { groups: 1, removed: removedIds.length, linksCarried: Object.keys(carry).length > 0 ? 1 : 0, referencesMoved };
}

export async function dedupeMail(db: PrismaClient, opts: { apply: boolean; log: (line: string) => void }): Promise<DedupeCounts> {
  const total: DedupeCounts = { groups: 0, removed: 0, linksCarried: 0, referencesMoved: 0 };
  for (const ids of await findGroups(db)) {
    const counts = opts.apply ? await db.$transaction((tx) => mergeGroup(tx, ids, true)) : await mergeGroup(db, ids, false);
    total.groups += counts.groups;
    total.removed += counts.removed;
    total.linksCarried += counts.linksCarried;
    total.referencesMoved += counts.referencesMoved;
  }
  opts.log(
    `mail-dedupe: ${opts.apply ? 'applied' : 'dry run'} groups=${total.groups} removed=${total.removed} `
      + `links_carried=${total.linksCarried} references_moved=${total.referencesMoved}`,
  );
  return total;
}
