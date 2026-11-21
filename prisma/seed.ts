import { PrismaClient } from '@prisma/client';
import { seedLookups, seedSampleUsers } from '../apps/api/src/seed/lookups.js';
import { seedSampleCompanies } from '../apps/api/src/seed/companies.js';

const prisma = new PrismaClient();

try {
  await seedLookups(prisma);
  if (process.env.SEED_SAMPLE_USERS === '1') {
    await seedSampleUsers(prisma);
    await seedSampleCompanies(prisma);
  }
} finally {
  await prisma.$disconnect();
}
