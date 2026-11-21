import type { Prisma, PrismaClient } from '@prisma/client';
import { ValidationError } from '../validate.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** 400 validation issue at `field` unless `value` is an active lookup value of `group`. */
export async function assertLookupValue(db: Db, group: string, value: string, field: string): Promise<void> {
  const row = await db.lookupValue.findFirst({ where: { group, value, isActive: true }, select: { id: true } });
  if (!row) throw new ValidationError([{ path: [field], message: `Unknown ${field}` }]);
}
