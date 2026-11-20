// Idempotent seed for servers: lookups always; sample users only when SEED_SAMPLE_USERS=1 (test environment).
import { prisma } from '../db.js';
import { seedLookups, seedSampleUsers } from '../seed/lookups.js';

try {
  await seedLookups(prisma);
  if (process.env.SEED_SAMPLE_USERS === '1') await seedSampleUsers(prisma);
  console.log('Seed done');
} catch (err) {
  console.error('Seed failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
