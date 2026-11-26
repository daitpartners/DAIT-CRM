import type { Prisma, PrismaClient } from '@prisma/client';

export interface AuditEntry {
  entityType: string;
  entityId: string | number;
  action: 'create' | 'update' | 'delete' | 'merge' | 'verify' | 'test_email' | 'view';
  userId: number | null;
  before?: unknown;
  after?: unknown;
}

/** Drops secrets and converts to plain JSON (Dates become strings). */
function sanitize(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const json = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  if (json && typeof json === 'object' && !Array.isArray(json)) delete json.passwordHash;
  return json as Prisma.InputJsonValue;
}

export async function audit(db: Prisma.TransactionClient | PrismaClient, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      entityType: entry.entityType,
      entityId: String(entry.entityId),
      action: entry.action,
      userId: entry.userId,
      before: sanitize(entry.before),
      after: sanitize(entry.after),
    },
  });
}
