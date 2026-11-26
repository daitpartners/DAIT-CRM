// e2e only: runs the queued Import leads jobs (`import_read_file`, `import_research`, `import_commit`) of ONE batch (the
// e2e server runs no worker), so a spec can drive a real import end to end. Jobs of other batches are left alone. Claude
// stays off (no token in the handlers' environment), and the website reader may reach only the hosts on
// RESEARCH_TEST_ALLOW_HOSTS (honoured by safeFetch only under NODE_ENV test/e2e); `*.test` names resolve to 127.0.0.1,
// where the spec serves its fixture site. A research job queues the next one, so the queue is drained until none is left.
// Run with tsx: `npx tsx test/e2e-import-jobs.ts <batchId>`.
import { join } from 'node:path';
import type { Job } from '@prisma/client';
import type { GraphClient } from '../src/graph/client';

process.env.DATABASE_URL ??= 'postgresql://mac@localhost:5432/dait_crm_e2e';
process.env.NODE_ENV = 'test';
process.env.RESEARCH_TEST_ALLOW_HOSTS ??= '127.0.0.1';
// The same uploads folder as the e2e server (e2e/start-server.sh).
process.env.STORAGE_DIR = process.env.E2E_STORAGE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'dait-crm-e2e-storage');

// Never against a database other than an e2e one.
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!dbName.endsWith('_e2e')) {
  console.error(`e2e-import-jobs: refusing to run against database "${dbName}" (its name must end in _e2e)`);
  process.exit(1);
}
const batchId = Number(process.argv[2]);
if (!Number.isInteger(batchId)) {
  console.error('e2e-import-jobs: pass the batch id');
  process.exit(1);
}

// Imported after the environment is settled so the Prisma client connects to the e2e database.
const { prisma } = await import('../src/db');
const { complete, fail } = await import('../src/jobs/queue');
const { importReadFileHandler, importReadDeps } = await import('../src/jobs/handlers/importReadFile');
const { importResearchHandler, importResearchDeps } = await import('../src/jobs/handlers/importResearch');
const { importCommitHandler } = await import('../src/jobs/handlers/importCommit');

// Claude never runs: the handlers see no CLAUDE_CODE_OAUTH_TOKEN. The reader maps the fixture names to 127.0.0.1.
importReadDeps.env = {};
importResearchDeps.env = {};
importResearchDeps.reader = {
  resolve: async (host: string) => (host === '127.0.0.1' || host.endsWith('.test') ? ['127.0.0.1'] : Promise.reject(new Error(`e2e: ${host} is not a fixture host`))),
};

// Import jobs never talk to Microsoft Graph.
const refuse = () => Promise.reject(new Error('not used in e2e'));
const graph: GraphClient = {
  sendMail: refuse, deltaPage: refuse, attachmentNames: refuse, markRead: refuse, moveTo: refuse, reply: refuse, calendarDeltaPage: refuse,
  messageBody: refuse, searchPage: refuse, folderIds: refuse,
};

const handlers = { import_read_file: importReadFileHandler, import_research: importResearchHandler, import_commit: importCommitHandler } as const;

/** This batch's queued import jobs, oldest first. */
async function queuedJobs(): Promise<Job[]> {
  const fileIds = new Set((await prisma.importFile.findMany({ where: { batchId }, select: { id: true } })).map((f) => f.id));
  const queued = await prisma.job.findMany({ where: { type: { in: Object.keys(handlers) }, status: 'queued' }, orderBy: { id: 'asc' } });
  return queued.filter((j) => {
    const p = j.payload as { batchId?: number; fileId?: number };
    return j.type === 'import_read_file' ? fileIds.has(p.fileId ?? -1) : p.batchId === batchId;
  });
}

let run = 0;
try {
  for (let mine = await queuedJobs(); mine.length > 0 && run < 200; mine = await queuedJobs()) {
    for (const job of mine) {
      run += 1;
      await prisma.job.update({ where: { id: job.id }, data: { status: 'running', lockedAt: new Date() } });
      try {
        await handlers[job.type as keyof typeof handlers](job, { graph });
        await complete(job.id);
      } catch (err) {
        console.error(`job ${job.id} (${job.type}) failed: ${err instanceof Error ? err.message : String(err)}`);
        await fail(job.id, err);
      }
    }
  }
  console.log(`e2e: ${run} import job(s) run`);
} finally {
  await prisma.$disconnect();
}
