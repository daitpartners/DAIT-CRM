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

const DAY_MS = 24 * 3600_000;
/** `at`'s local calendar day in `timeZone`, as whole days since 1970-01-01. */
const localDay = (timeZone: string, at: number): number => Math.floor((at + offsetMs(timeZone, new Date(at))) / DAY_MS);

/**
 * The instant the current day began in `timeZone`: the first instant whose local date is today's, exact on
 * daylight-saving days (a local midnight that does not exist begins the day at the change; one that happens twice
 * begins it at whichever is followed only by today's date).
 */
export function startOfDayIn(timeZone: string, at = new Date()): Date {
  const midnightLocal = localDay(timeZone, at.getTime()) * DAY_MS;
  let t = midnightLocal - offsetMs(timeZone, at);
  for (let i = 0; i < 3; i += 1) {
    const next = midnightLocal - offsetMs(timeZone, new Date(t));
    if (next === t) break;
    t = next;
  }
  // Midnight fell in a daylight-saving gap: t is still yesterday, short of midnight by the clocks' jump.
  for (let i = 0; i < 3 && localDay(timeZone, t) * DAY_MS < midnightLocal; i += 1) t += midnightLocal - (t + offsetMs(timeZone, new Date(t)));
  // Clocks went back just after midnight (Havana, 01:00 → 00:00): today's first midnight was the earlier one.
  if (localDay(timeZone, t - 1) * DAY_MS === midnightLocal) {
    const earlier = midnightLocal - offsetMs(timeZone, new Date(t - 1));
    if (earlier < t && localDay(timeZone, earlier) * DAY_MS === midnightLocal) t = earlier;
  }
  return new Date(t);
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
