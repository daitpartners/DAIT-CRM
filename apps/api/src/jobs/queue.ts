import type { Job, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import type { JobType } from './types.js';

type Db = Prisma.TransactionClient | PrismaClient;

const MAX_ERROR_LENGTH = 1000;

export async function enqueue(
  db: Db,
  type: JobType,
  payload: object,
  opts: { runAt?: Date; maxAttempts?: number } = {},
): Promise<Job> {
  return db.job.create({
    data: {
      type,
      payload: payload as Prisma.InputJsonValue,
      runAt: opts.runAt ?? new Date(),
      status: 'queued',
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    },
  });
}

/**
 * Atomically claims the oldest due job of the given types. `FOR UPDATE SKIP LOCKED`
 * lets concurrent workers each take a different row without blocking one another.
 * Columns are `timestamp without time zone` holding UTC (Prisma's convention), so the
 * database clock is read as UTC regardless of the server's TimeZone setting.
 */
export async function claimNext(types: JobType[]): Promise<Job | null> {
  if (types.length === 0) return null;
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    UPDATE jobs SET status = 'running', locked_at = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_at <= (now() AT TIME ZONE 'UTC') AND type = ANY(${types}::text[])
      ORDER BY run_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  const id = rows[0]?.id;
  // Re-read through Prisma so dates and JSON are decoded exactly like every other query.
  return id === undefined ? null : prisma.job.findUnique({ where: { id } });
}

export async function complete(id: number): Promise<void> {
  await prisma.job.update({ where: { id }, data: { status: 'done', lockedAt: null, lastError: null } });
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, MAX_ERROR_LENGTH);
}

/** Records a failed attempt: requeue with backoff of min(2^attempts, 60) minutes, or mark failed. */
export async function fail(id: number, err: unknown): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job) return;
  const attempts = job.attempts + 1;
  const lastError = errorMessage(err);
  if (attempts < job.maxAttempts) {
    const delayMin = Math.min(2 ** attempts, 60);
    await prisma.job.update({
      where: { id },
      data: { attempts, lastError, status: 'queued', lockedAt: null, runAt: new Date(Date.now() + delayMin * 60_000) },
    });
  } else {
    await prisma.job.update({ where: { id }, data: { attempts, lastError, status: 'failed', lockedAt: null } });
  }
}
