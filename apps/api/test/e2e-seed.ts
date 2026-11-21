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
const { seedSampleCompanies } = await import('../src/seed/companies');
const { encrypt } = await import('../src/crypto/tokens');
const { createLeadWithCompany } = await import('../src/leads/service');
const { todayIn } = await import('../src/leads/dates');
const { LeadCreate, roleLabel } = await import('@dait-crm/shared');

try {
  await resetDb();
  await seedLookups(prisma);
  await seedSampleUsers(prisma);
  await seedSampleCompanies(prisma);
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
  // Release 2B-1: Neha (Manager) has a connected mailbox for the lead-email specs (Maya's is disconnected by connections.spec).
  const neha = await prisma.user.findUniqueOrThrow({ where: { email: 'neha.kapoor@daitpartners.com' } });
  await prisma.emailAccount.create({
    data: {
      address: 'neha.kapoor@daitpartners.com', provider: 'microsoft', kind: 'personal', userId: neha.id,
      refreshTokenEnc: encrypt('fake-personal-token-neha'), status: 'connected',
    },
  });
  // Release 2A: Maya has connected her own mailbox; Arjun has not.
  await prisma.emailAccount.create({
    data: {
      address: 'maya.pillai@daitpartners.com', provider: 'microsoft', kind: 'personal', userId: maya.id,
      refreshTokenEnc: encrypt('fake-personal-token'), status: 'connected',
    },
  });
  await seedLeads(maya.id);
  console.log('e2e seed complete');
} finally {
  await prisma.$disconnect();
}

/**
 * Three leads on seeded companies, created by Maya without notifications or review tasks:
 * Arjun's (Northwind, follow-up tomorrow in his timezone), an unassigned one (Meridian) and Maya's (Orbit).
 */
async function seedLeads(mayaId: number): Promise<void> {
  const user = async (email: string) => prisma.user.findUniqueOrThrow({ where: { email } });
  const maya = await prisma.user.findUniqueOrThrow({ where: { id: mayaId } });
  const arjun = await user('arjun.mehta@daitpartners.com');
  const company = async (number: string) => (await prisma.company.findUniqueOrThrow({ where: { number } })).id;
  const actor = {
    id: maya.id, email: maya.email, name: maya.name, role: roleLabel(maya.role), language: maya.language,
    timezone: maya.timezone, dateFormat: maya.dateFormat,
  };
  const tomorrow = new Date(`${todayIn(arjun.timezone)}T00:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const leads = [
    {
      companyName: 'Northwind Logistics', country: 'India', linkCompanyId: await company('CO-0318'),
      assignedToId: arjun.id, nextFollowUp: tomorrow.toISOString().slice(0, 10), leadSource: 'Website Contact Form',
    },
    { companyName: 'Meridian Textiles', country: 'United Kingdom', linkCompanyId: await company('CO-0245'), leadSource: 'Referral' },
    { companyName: 'Orbit Fintech', country: 'Germany', linkCompanyId: await company('CO-0310'), assignedToId: maya.id, leadSource: 'LinkedIn' },
  ];
  for (const lead of leads) {
    const input = LeadCreate.parse({ ...lead, createCompany: false });
    await prisma.$transaction((tx) => createLeadWithCompany(tx, input, actor, { quiet: true }));
  }
}
