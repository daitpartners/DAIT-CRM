// e2e only: runs the queued `research_company` jobs of ONE company (the e2e server runs no worker), so a spec can see
// a research run complete. Jobs of other companies (automatic runs queued by other specs for seeded websites) are left
// alone, so nothing reaches the real network. The website reader may reach the spec's local fixture site only through
// RESEARCH_TEST_ALLOW_HOSTS, which safeFetch honours only under NODE_ENV test/e2e.
// Run with tsx: `npx tsx test/e2e-research-jobs.ts <companyId>`.
import type { Job } from '@prisma/client';
import type { GraphClient } from '../src/graph/client';

process.env.DATABASE_URL ??= 'postgresql://mac@localhost:5432/dait_crm_e2e';
process.env.NODE_ENV = 'test';
process.env.RESEARCH_TEST_ALLOW_HOSTS ??= '127.0.0.1';

// Never against a database other than an e2e one.
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!dbName.endsWith('_e2e')) {
  console.error(`e2e-research-jobs: refusing to run against database "${dbName}" (its name must end in _e2e)`);
  process.exit(1);
}
const companyId = Number(process.argv[2]);
if (!Number.isInteger(companyId)) {
  console.error('e2e-research-jobs: pass the company id');
  process.exit(1);
}

// Imported after the environment is settled so the Prisma client connects to the e2e database.
const { prisma } = await import('../src/db');
const { complete, fail } = await import('../src/jobs/queue');
const { researchCompanyHandler } = await import('../src/jobs/handlers/researchCompany');

// Research never talks to Microsoft Graph.
const refuse = () => Promise.reject(new Error('not used in e2e'));
const graph: GraphClient = {
  sendMail: refuse, deltaPage: refuse, listAttachments: refuse, attachmentContent: refuse, markRead: refuse, moveTo: refuse, setFlag: refuse, deleteMessage: refuse,
  reply: refuse, replyAll: refuse, forward: refuse, calendarDeltaPage: refuse, messageBody: refuse, searchPage: refuse, folderIds: refuse,
};

try {
  const runIds = (await prisma.enrichmentRun.findMany({ where: { companyId }, select: { id: true } })).map((r) => r.id);
  const queued = await prisma.job.findMany({ where: { type: 'research_company', status: 'queued' }, orderBy: { id: 'asc' } });
  const mine = queued.filter((j: Job) => runIds.includes((j.payload as { runId?: number }).runId ?? -1));
  for (const job of mine) {
    await prisma.job.update({ where: { id: job.id }, data: { status: 'running', lockedAt: new Date() } });
    try {
      await researchCompanyHandler(job, { graph });
      await complete(job.id);
    } catch (err) {
      console.error(`job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      await fail(job.id, err);
    }
  }
  console.log(`e2e: ${mine.length} research job(s) run`);
} finally {
  await prisma.$disconnect();
}
