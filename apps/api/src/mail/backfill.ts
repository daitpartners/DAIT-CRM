/**
 * Web-mail release 1 backfill: a 12-month whole-mailbox search for each lead/contact address in every connected mailbox,
 * so mail that predates the address in the CRM (or the release) is stored too. One `mail_backfills` row per mailbox and
 * address, worked through one at a time by the `mail_backfill` job chain (see jobs/handlers/mailBackfill.ts).
 * Each address is queued once (`mail_backfill_addresses`); the first sweep after deploy is the release backfill.
 */
import type { EmailAccount, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueue, STALE_AFTER_MS } from '../jobs/queue.js';
import type { GraphClient, MailFolder } from '../graph/client.js';
import { FOLDERS } from '../jobs/handlers/syncMailbox.js';
import { isOwnAddress, loadMailboxDomains } from './leadMail.js';

type Db = Prisma.TransactionClient | PrismaClient;

export const BACKFILL_DAYS = 365;
export const BACKFILL_PAGES = 5;
export const BACKFILL_GAP_MS = 10_000;
export const BACKFILL_MAX_ATTEMPTS = 3;
export const THROTTLE_MIN_MS = 60_000;
/** A job stops after this long even before BACKFILL_PAGES pages, so a send on the mail lane waits one short job (F13). */
export const BACKFILL_TIME_BUDGET_MS = 20_000;

/** Mailboxes that get backfill rows: personal, connected, Sync mail on, of an active user (as mail sync). */
const syncingMailboxWhere: Prisma.EmailAccountWhereInput = {
  kind: 'personal', status: 'connected', syncMail: true, userId: { not: null }, user: { isActive: true },
};

/**
 * Lead and contact addresses (trimmed, lower-cased, with an `@`) not yet queued for backfill. Addresses at our own or a
 * mailbox's domain are left out (and not recorded): their mail is never lead mail (F18), so searching would be wasted.
 */
async function newAddresses(db: Db): Promise<string[]> {
  const rows = await db.$queryRaw<{ address: string }[]>`
    SELECT DISTINCT a.address FROM (
      SELECT lower(trim(business_email)) AS address FROM leads WHERE business_email IS NOT NULL
      UNION
      SELECT lower(trim(business_email)) AS address FROM contacts WHERE business_email IS NOT NULL
    ) a
    WHERE position('@' IN a.address) > 0 AND length(a.address) <= 320
      AND NOT EXISTS (SELECT 1 FROM mail_backfill_addresses m WHERE m.address = a.address)
    ORDER BY a.address`;
  const mailboxDomains = await loadMailboxDomains(db);
  return rows.map((r) => r.address).filter((address) => !isOwnAddress(address, mailboxDomains));
}

/** Runs `fn` in a transaction when `db` is the client, as is when it already is one. */
function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return '$transaction' in db ? db.$transaction((tx) => fn(tx)) : fn(db);
}

/**
 * Lead/contact addresses not yet in `mail_backfill_addresses` are recorded there and get one queued row per syncing
 * mailbox; returns the rows created. A mailbox connected later gets no rows (its 12-month first sync covers it).
 */
export async function queueNewAddressBackfills(db: Db): Promise<number> {
  const addresses = await newAddresses(db);
  if (addresses.length === 0) return 0;
  const accounts = await db.emailAccount.findMany({ where: syncingMailboxWhere, select: { id: true }, orderBy: { id: 'asc' } });
  return inTransaction(db, async (tx) => {
    await tx.mailBackfillAddress.createMany({ data: addresses.map((address) => ({ address })), skipDuplicates: true });
    const { count } = await tx.mailBackfill.createMany({
      data: accounts.flatMap((a) => addresses.map((address) => ({ accountId: a.id, address }))),
      skipDuplicates: true,
    });
    return count;
  });
}

/**
 * F20: a mailbox that was not syncing when its addresses were first queued (reconnected later) gets a queued row for
 * every known address, and its failed or skipped rows are queued again. Returns the rows created or re-queued.
 */
export async function queueMailboxBackfills(db: Db, accountId: number): Promise<number> {
  const account = await db.emailAccount.findFirst({ where: { id: accountId, kind: 'personal' }, select: { id: true } });
  if (!account) throw new Error('mailbox_not_found');
  const mailboxDomains = await loadMailboxDomains(db);
  const known = (await db.mailBackfillAddress.findMany({ select: { address: true } }))
    .filter((k) => !isOwnAddress(k.address, mailboxDomains));
  return inTransaction(db, async (tx) => {
    const created = await tx.mailBackfill.createMany({ data: known.map((k) => ({ accountId, address: k.address })), skipDuplicates: true });
    const requeued = await tx.mailBackfill.updateMany({
      where: { accountId, status: { in: ['failed', 'skipped'] } }, data: { status: 'queued', attempts: 0, lastError: null },
    });
    return created.count + requeued.count;
  });
}

/** Enqueues a `mail_backfill` job when rows are queued and no such job is queued or running (non-stale). */
export async function ensureBackfillJob(db: Db): Promise<boolean> {
  const waiting = await db.mailBackfill.count({ where: { status: 'queued' } });
  if (waiting === 0) return false;
  const pending = await db.job.count({
    where: {
      type: 'mail_backfill',
      OR: [{ status: 'queued' }, { status: 'running', lockedAt: { gte: new Date(Date.now() - STALE_AFTER_MS) } }],
    },
  });
  if (pending > 0) return false;
  await enqueue(db, 'mail_backfill', {}, { maxAttempts: 1 });
  return true;
}

/**
 * The worker's minute sweep: rows left `running` by a lost job are queued again, new addresses are queued, and a
 * chain that was lost (or never started) gets a job.
 */
export async function sweepMailBackfill(db: Db = prisma): Promise<void> {
  await db.mailBackfill.updateMany({
    where: { status: 'running', updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    data: { status: 'queued' },
  });
  await queueNewAddressBackfills(db);
  await ensureBackfillJob(db);
}

const countBy = (rows: { status: string; _count: { _all: number } }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.status, r._count._all]));

/** Progress for the CLI: rows by status, totals, and rows by status per mailbox (mailbox addresses only). */
export async function backfillStatus(db: Db): Promise<{
  byStatus: Record<string, number>; found: number; stored: number;
  mailboxes: { accountId: number; address: string; byStatus: Record<string, number> }[];
}> {
  const [byStatus, totals, perMailbox] = await Promise.all([
    db.mailBackfill.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
    db.mailBackfill.aggregate({ _sum: { found: true, stored: true } }),
    db.mailBackfill.groupBy({ by: ['accountId', 'status'], _count: { _all: true }, orderBy: [{ accountId: 'asc' }, { status: 'asc' }] }),
  ]);
  const accountIds = [...new Set(perMailbox.map((r) => r.accountId))];
  const accounts = await db.emailAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, address: true } });
  const addressOf = new Map(accounts.map((a) => [a.id, a.address]));
  return {
    byStatus: countBy(byStatus),
    found: totals._sum.found ?? 0,
    stored: totals._sum.stored ?? 0,
    mailboxes: accountIds.map((accountId) => ({
      accountId, address: addressOf.get(accountId) ?? '', byStatus: countBy(perMailbox.filter((r) => r.accountId === accountId)),
    })),
  };
}

/** Failed and skipped rows are queued again with their attempts reset (e.g. after a mailbox reconnect). */
export async function retryBackfills(db: Db): Promise<number> {
  const { count } = await db.mailBackfill.updateMany({
    where: { status: { in: ['failed', 'skipped'] } }, data: { status: 'queued', attempts: 0, lastError: null },
  });
  return count;
}

/** Per mailbox: Graph folder id → CRM folder for the synced folders, and ids seen that are not synced (Junk, …). */
interface FolderMap {
  synced: Map<string, string>;
  other: Set<string>;
}
const CRM_FOLDER = new Map<MailFolder, string>(FOLDERS.map((f) => [f.graph, f.folder]));
/** F6: folder ids are looked up once per mailbox (not per job), and again when an id shows up that is in neither set. */
const folderCache = new Map<number, FolderMap>();

async function loadFolders(account: EmailAccount, graph: GraphClient): Promise<FolderMap> {
  const ids = await graph.folderIds(account);
  const synced = new Map<string, string>();
  for (const [graphFolder, id] of Object.entries(ids) as [MailFolder, string][]) {
    const folder = CRM_FOLDER.get(graphFolder);
    if (folder && id) synced.set(id, folder);
  }
  const map = { synced, other: new Set<string>() };
  folderCache.set(account.id, map);
  return map;
}

/**
 * For one job: the CRM folder of a message in Graph folder `folderId`, or null when that folder is not one sync reads.
 * The ids come from the mailbox's cache; an id in neither set reads them again (at most once per job), and an id still
 * unknown after that is remembered as not synced.
 */
export function folderResolver(account: EmailAccount, graph: GraphClient): (folderId: string) => Promise<string | null> {
  let readThisJob = false;
  return async (folderId) => {
    let map = folderCache.get(account.id);
    const known = map?.synced.get(folderId);
    if (known) return known;
    if (map?.other.has(folderId)) return null;
    if (!map || !readThisJob) {
      map = await loadFolders(account, graph);
      readThisJob = true;
    }
    const folder = map.synced.get(folderId) ?? null;
    if (!folder) map.other.add(folderId);
    return folder;
  };
}

export function resetFolderCacheForTests(): void {
  folderCache.clear();
}
