import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Advisory-lock namespace for project numbering (quotations use 3001); one sequence, so the second key is fixed. */
const LOCK_NAMESPACE = 3002;

/**
 * The next `PRJ-<n>` (n from 1, unpadded, as the prototype's PRJ-1). Takes a transaction-scoped advisory lock, so call
 * it inside the transaction that inserts the project; concurrent creates then queue on the lock and each sees the
 * previous one's number. Relies on READ COMMITTED (Postgres' default): the MAX read after the lock sees rows committed
 * by earlier holders.
 */
export async function nextProjectNumber(tx: Tx): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, 0)`;
  const prefix = 'PRJ-';
  const from = prefix.length + 1;
  const [row] = await tx.$queryRaw<{ last: number | null }[]>`
    SELECT MAX(CASE WHEN substring(number FROM ${from}::int) ~ '^[0-9]+$'
                    THEN CAST(substring(number FROM ${from}::int) AS integer) END) AS last
    FROM projects
    WHERE number LIKE ${`${prefix}%`}`;
  return `${prefix}${(row?.last ?? 0) + 1}`;
}
