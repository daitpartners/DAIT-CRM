import { Prisma } from '@prisma/client';

/** A unique-constraint violation (P2002); with `target`, only one whose meta.target names that constraint or column. */
export function isUniqueViolation(e: unknown, target?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (target === undefined) return true;
  const t = e.meta?.target;
  return Array.isArray(t) ? t.includes(target) : typeof t === 'string' && t.includes(target);
}

/** The record to update or delete was not found (P2025): with an `updatedAt` in the where, a concurrent write. */
export const isNotFound = (e: unknown): boolean => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';

/** The client's `updatedAt` no longer matches the row: answered with 409 `stale`. */
export class StaleError extends Error {
  readonly code = 'stale';
}
