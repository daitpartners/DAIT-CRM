import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyUser } from '../leads/notify.js';
import { todayIn, ymd } from '../leads/dates.js';
import { appendHistory } from '../quotations/service.js';

type Db = PrismaClient;

const DAY_MS = 86_400_000;
/** The worker calls the schedule every minute; the check itself runs at most this often. */
export const EXPIRY_CHECK_EVERY_MS = 60 * 60_000;

/**
 * Sent / Negotiating quotations whose valid-until is before today in their owner's time zone become Expired: a history
 * line and a notification to the owner; the lead is left alone. A quotation with a send queued is skipped (the next
 * check takes it once the send is over). Returns how many expired.
 */
export async function expireQuotations(db: Db = prisma, now = new Date()): Promise<number> {
  // No time zone is more than a day ahead of UTC: anything that can be past valid-until anywhere is in this set.
  const latest = new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + DAY_MS);
  const candidates = await db.quotation.findMany({
    where: { status: { in: ['Sent', 'Negotiating'] }, validUntil: { lt: latest }, sendingMessageId: null },
    select: { id: true, validUntil: true, owner: { select: { timezone: true } } },
    orderBy: { id: 'asc' },
  });
  let expired = 0;
  for (const c of candidates) {
    if (ymd(c.validUntil)! >= todayIn(c.owner.timezone, now)) continue;
    const done = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM quotations WHERE id = ${c.id} FOR UPDATE`;
      const q = await tx.quotation.findUniqueOrThrow({ where: { id: c.id } });
      // Re-checked under the lock: accepted, rejected or sent again in the meantime.
      if ((q.status !== 'Sent' && q.status !== 'Negotiating') || q.sendingMessageId !== null || ymd(q.validUntil) !== ymd(c.validUntil)) return false;
      await tx.quotation.update({ where: { id: q.id }, data: { status: 'Expired', history: appendHistory(q, `Expired · valid until ${ymd(q.validUntil)}`) } });
      await notifyUser(tx, q.ownerId, `Quotation expired · ${q.number}`, q.subject, `/quotations/${q.id}`);
      return true;
    });
    if (done) expired += 1;
  }
  return expired;
}

let lastCheckAt = 0;

/**
 * Run from the worker's minute schedule: the expiry check itself at most once an hour (so each owner's midnight is
 * acted on within the hour). Returns the number expired, or null when the check was not due.
 */
export async function scheduleQuotationExpiry(db: Db = prisma, now = new Date()): Promise<number | null> {
  if (now.getTime() - lastCheckAt < EXPIRY_CHECK_EVERY_MS) return null;
  lastCheckAt = now.getTime();
  return expireQuotations(db, now);
}

/** Tests: forget the last check so the next schedule call runs it. */
export function resetQuotationExpiryClock(): void {
  lastCheckAt = 0;
}
