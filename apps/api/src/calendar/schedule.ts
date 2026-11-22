import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueue, STALE_AFTER_MS } from '../jobs/queue.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** How often each calendar is read (owner-approved design, release 3C; same as mail). */
export const CALENDAR_SYNC_EVERY_MS = 5 * 60_000;

/** `email_accounts.calendar_sync_state`. */
export interface CalendarSyncState {
  /** Graph next or delta link to continue from. */
  link?: string;
  /** The user the link was read for: another owner starts afresh. */
  userId?: number;
  /** The first listing of a restart is still being read (events it has not touched yet are removed when it ends). */
  full?: boolean;
  /** Last completed run (ISO). */
  at?: string;
}

/** Accounts that already have a calendar sync waiting or running (a run locked longer than STALE_AFTER_MS was interrupted). */
async function pendingAccountIds(db: Db): Promise<Set<number>> {
  const jobs = await db.job.findMany({
    where: {
      type: 'sync_calendar',
      OR: [{ status: 'queued' }, { status: 'running', lockedAt: { gte: new Date(Date.now() - STALE_AFTER_MS) } }],
    },
    select: { payload: true },
  });
  return new Set(jobs.map((j) => Number((j.payload as { accountId?: unknown }).accountId)));
}

/**
 * Queues a `sync_calendar` run for each connected personal mailbox with Sync calendar on, of an active user, that has
 * none waiting, due 5 minutes after its last run (now when never run). The worker calls it every minute. Returns the
 * number queued.
 */
export async function scheduleCalendarSync(db: Db = prisma, now = new Date()): Promise<number> {
  const accounts = await db.emailAccount.findMany({
    where: { kind: 'personal', status: 'connected', syncCalendar: true, userId: { not: null }, user: { isActive: true } },
    select: { id: true, calendarSyncState: true },
    orderBy: { id: 'asc' },
  });
  const pending = await pendingAccountIds(db);
  // A run that failed in the last 5 minutes counts as the last run, so a failing calendar is not retried every minute.
  const failed = await db.job.findMany({
    where: { type: 'sync_calendar', status: 'failed', updatedAt: { gt: new Date(now.getTime() - CALENDAR_SYNC_EVERY_MS) } },
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
    const at = Date.parse((a.calendarSyncState as CalendarSyncState | null)?.at ?? '');
    const last = Math.max(Number.isNaN(at) ? 0 : at, lastFailure.get(a.id) ?? 0);
    const due = last ? new Date(Math.max(now.getTime(), last + CALENDAR_SYNC_EVERY_MS)) : now;
    await enqueue(db, 'sync_calendar', { accountId: a.id }, { runAt: due, maxAttempts: 1 });
    queued += 1;
  }
  return queued;
}

/** Sync calendar switched off or the mailbox disconnected: the copied events go, and the next sync starts afresh. */
export async function dropCalendarCopy(db: Db, accountId: number): Promise<void> {
  await db.calendarEvent.deleteMany({ where: { accountId } });
  await db.emailAccount.update({ where: { id: accountId }, data: { calendarSyncState: Prisma.DbNull, calendarSyncAt: null } });
}
