import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueue, STALE_AFTER_MS } from '../jobs/queue.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** How often each mailbox is read (owner-approved design, release 2B-2). */
export const SYNC_EVERY_MS = 5 * 60_000;

/** Accounts that already have a sync waiting or running (a run locked longer than STALE_AFTER_MS was interrupted). */
async function pendingAccountIds(db: Db): Promise<Set<number>> {
  const jobs = await db.job.findMany({
    where: {
      type: 'sync_mailbox',
      OR: [{ status: 'queued' }, { status: 'running', lockedAt: { gte: new Date(Date.now() - STALE_AFTER_MS) } }],
    },
    select: { payload: true },
  });
  return new Set(jobs.map((j) => Number((j.payload as { accountId?: unknown }).accountId)));
}

/**
 * Queues a `sync_mailbox` run for each connected personal mailbox with Sync mail on that has none waiting, due 5
 * minutes after its last sync (now when never synced). The worker calls it every minute. Returns the number queued.
 */
export async function scheduleMailSync(db: Db = prisma, now = new Date()): Promise<number> {
  const accounts = await db.emailAccount.findMany({
    where: { kind: 'personal', status: 'connected', syncMail: true, userId: { not: null } },
    select: { id: true, lastSyncAt: true },
    orderBy: { id: 'asc' },
  });
  const pending = await pendingAccountIds(db);
  // A run that failed in the last 5 minutes counts as the last run, so a failing mailbox is not retried every minute.
  const failed = await db.job.findMany({
    where: { type: 'sync_mailbox', status: 'failed', updatedAt: { gt: new Date(now.getTime() - SYNC_EVERY_MS) } },
    select: { payload: true, updatedAt: true },
  });
  const lastFailure = new Map<number, number>();
  for (const j of failed) {
    const id = Number((j.payload as { accountId?: unknown }).accountId);
    lastFailure.set(id, Math.max(lastFailure.get(id) ?? 0, j.updatedAt.getTime()));
  }
  let queued = 0;
  for (const a of accounts) {
    if (pending.has(a.id)) continue;
    const last = Math.max(a.lastSyncAt?.getTime() ?? 0, lastFailure.get(a.id) ?? 0);
    const due = last ? new Date(Math.max(now.getTime(), last + SYNC_EVERY_MS)) : now;
    await enqueue(db, 'sync_mailbox', { accountId: a.id }, { runAt: due, maxAttempts: 1 });
    queued += 1;
  }
  return queued;
}

/** Sync now: a waiting run is brought forward, else one is queued now (unless one is already running). */
export async function requestSync(db: Db, accountId: number): Promise<void> {
  const moved = await db.job.updateMany({
    where: { type: 'sync_mailbox', status: 'queued', payload: { path: ['accountId'], equals: accountId } },
    data: { runAt: new Date() },
  });
  if (moved.count > 0 || (await pendingAccountIds(db)).has(accountId)) return;
  await enqueue(db, 'sync_mailbox', { accountId }, { maxAttempts: 1 });
}
