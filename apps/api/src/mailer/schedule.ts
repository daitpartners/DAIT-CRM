import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueue, STALE_AFTER_MS } from '../jobs/queue.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** Milliseconds `timeZone`'s wall clock is ahead of UTC at `at`. */
function offsetMs(timeZone: string, at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant the current day began in `timeZone`. */
export function startOfDayIn(timeZone: string, at = new Date()): Date {
  const local = new Date(at.getTime() + offsetMs(timeZone, at));
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnightLocal - offsetMs(timeZone, new Date(midnightLocal)));
}

/** The instant the next day begins in `timeZone`. */
export function startOfNextDayIn(timeZone: string, at = new Date()): Date {
  return startOfDayIn(timeZone, new Date(startOfDayIn(timeZone, at).getTime() + 36 * 3600_000));
}

/** Campaigns with a step waiting or running (a step locked longer than STALE_AFTER_MS was interrupted). */
async function pendingCampaignIds(db: Db, exceptJobId?: number): Promise<Set<number>> {
  const jobs = await db.job.findMany({
    where: { type: 'campaign_step', ...(exceptJobId !== undefined ? { id: { not: exceptJobId } } : {}), OR: [{ status: 'queued' }, { status: 'running', lockedAt: { gte: new Date(Date.now() - STALE_AFTER_MS) } }] },
    select: { payload: true },
  });
  return new Set(jobs.map((j) => Number((j.payload as { campaignId?: unknown }).campaignId)));
}

/** Queues a step for a campaign unless one is already waiting (the step queuing it, `fromJobId`, does not count). */
export async function queueStep(db: Db, campaignId: number, runAt: Date, fromJobId?: number): Promise<boolean> {
  if ((await pendingCampaignIds(db, fromJobId)).has(campaignId)) return false;
  await enqueue(db, 'campaign_step', { campaignId }, { runAt, maxAttempts: 1 });
  return true;
}

/**
 * Mailer clock (release 2C), run by the worker every minute: Scheduled campaigns whose start has come begin Sending;
 * every Sending campaign that is due and has no step waiting gets one. Returns the number of steps queued.
 */
export async function scheduleCampaigns(db: Db = prisma, now = new Date()): Promise<number> {
  await db.emailCampaign.updateMany({ where: { status: 'Scheduled', startAt: { lte: now } }, data: { status: 'Sending', nextSendAt: now } });
  const due = await db.emailCampaign.findMany({
    where: { status: 'Sending', OR: [{ nextSendAt: null }, { nextSendAt: { lte: now } }] }, select: { id: true }, orderBy: { id: 'asc' },
  });
  const pending = await pendingCampaignIds(db);
  let queued = 0;
  for (const c of due) {
    if (pending.has(c.id)) continue;
    await enqueue(db, 'campaign_step', { campaignId: c.id }, { runAt: now, maxAttempts: 1 });
    queued += 1;
  }
  return queued;
}
