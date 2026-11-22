import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Advisory-lock namespace for quotation numbering (the second key is the year). */
const LOCK_NAMESPACE = 3001;

/**
 * The next `Q-YYYY-NNN` for the calendar year of `quotationDate` (UTC date, as stored in the @db.Date column): NNN
 * counts from 001, zero-padded to 3 and growing past 999. Takes a transaction-scoped advisory lock for that year, so
 * call it inside the transaction that inserts the quotation; concurrent creates for the same year then queue on the
 * lock and each sees the previous one's number.
 */
export async function nextQuotationNumber(tx: Tx, quotationDate: Date): Promise<string> {
  const year = quotationDate.getUTCFullYear();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${year}::int)`;
  const prefix = `Q-${year}-`;
  const from = prefix.length + 1;
  const [row] = await tx.$queryRaw<{ last: number | null }[]>`
    SELECT MAX(CASE WHEN substring(number FROM ${from}::int) ~ '^[0-9]+$'
                    THEN CAST(substring(number FROM ${from}::int) AS integer) END) AS last
    FROM quotations
    WHERE number LIKE ${`${prefix}%`}`;
  const next = (row?.last ?? 0) + 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}
