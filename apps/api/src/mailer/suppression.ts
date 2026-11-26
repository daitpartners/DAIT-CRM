/**
 * The suppression list (`email_suppressions`, lead delete 25 Nov 2026): addresses kept when a lead marked Do not email,
 * or a contact that unsubscribed, is deleted. Only the address is kept. The Mailer skips them (with the same reasons as a
 * lead marked Do not email / an unsubscribed contact), and a lead or contact created for one later is flagged.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

type Db = Prisma.TransactionClient | PrismaClient;
export type SuppressionReason = 'unsubscribed' | 'do_not_email';

const clean = (a: string | null | undefined) => (a ?? '').trim().toLowerCase();

/** Adds the addresses (lower-cased; an address already listed keeps its first reason). */
export async function suppress(
  db: Db, rows: { email: string | null | undefined; reason: SuppressionReason }[], source: string, userId: number | null,
): Promise<void> {
  const byEmail = new Map<string, SuppressionReason>();
  for (const r of rows) {
    const email = clean(r.email);
    // 'unsubscribed' wins over 'do_not_email' for the same address in one call.
    if (email && email.length <= 320 && (!byEmail.has(email) || r.reason === 'unsubscribed')) byEmail.set(email, r.reason);
  }
  if (byEmail.size === 0) return;
  await db.emailSuppression.createMany({
    data: [...byEmail].map(([email, reason]) => ({ email, reason, source, createdById: userId })),
    skipDuplicates: true,
  });
}

/** The listed addresses among `emails`, with their reason. */
export async function suppressed(db: Db, emails: (string | null | undefined)[]): Promise<Map<string, SuppressionReason>> {
  const list = [...new Set(emails.map(clean).filter(Boolean))];
  if (list.length === 0) return new Map();
  const rows = await db.emailSuppression.findMany({ where: { email: { in: list } }, select: { email: true, reason: true } });
  return new Map(rows.map((r) => [r.email, r.reason as SuppressionReason]));
}

/** Takes the addresses off the list (a person ticked Do not email off again: they may be emailed). */
export async function unsuppress(db: Db, emails: (string | null | undefined)[]): Promise<void> {
  const list = [...new Set(emails.map(clean).filter(Boolean))];
  if (list.length > 0) await db.emailSuppression.deleteMany({ where: { email: { in: list } } });
}

/** The Mailer's skip reason for a listed address (the texts of a lead marked Do not email / an unsubscribed contact). */
export const suppressionBlock = (reason: SuppressionReason) => (reason === 'unsubscribed' ? 'Unsubscribed' : 'Marked do not email');
