// Resets and seeds the end-to-end database. Run with tsx (`npm run e2e:seed -w apps/api`).
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgresql://mac@localhost:5432/dait_crm_e2e';
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

execSync('npx prisma migrate deploy', { cwd: repoRoot, stdio: 'inherit', env: process.env });

// Imported after DATABASE_URL is settled so the Prisma client connects to the e2e database.
const { prisma } = await import('../src/db');
const { resetDb } = await import('./helpers');
const { seedLookups, seedSampleUsers } = await import('../src/seed/lookups');
const { encrypt } = await import('../src/crypto/tokens');

try {
  await resetDb();
  await seedLookups(prisma);
  await seedSampleUsers(prisma);
  const maya = await prisma.user.findUniqueOrThrow({ where: { email: 'maya.pillai@daitpartners.com' } });
  await prisma.emailAccount.create({
    data: {
      address: 'hello@daitpartners.com',
      provider: 'microsoft',
      kind: 'system',
      userId: maya.id,
      refreshTokenEnc: encrypt('fake-refresh-token'),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      status: 'connected',
    },
  });
  console.log('e2e seed complete');
} finally {
  await prisma.$disconnect();
}
