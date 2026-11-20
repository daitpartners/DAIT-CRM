import { Prisma } from '@prisma/client';
import { prisma } from '../src/db';
import { seedLookups as seedLookupsWith } from '../../../prisma/seed-data/lookups';

export async function resetDb(): Promise<void> {
  const tables = Prisma.dmmf.datamodel.models.map((m) => `"${m.dbName ?? m.name}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

export async function seedLookups(): Promise<void> {
  await seedLookupsWith(prisma);
}
