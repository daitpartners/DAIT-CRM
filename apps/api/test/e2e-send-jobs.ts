// e2e only: runs the queued `send_user_email` jobs against a fake Microsoft Graph that accepts every message, so a
// spec can see a send succeed (the e2e server runs no worker). Run with tsx (`npx tsx test/e2e-send-jobs.ts`).
import type { GraphClient } from '../src/graph/client';

process.env.DATABASE_URL ??= 'postgresql://mac@localhost:5432/dait_crm_e2e';

// Imported after DATABASE_URL is settled so the Prisma client connects to the e2e database.
const { prisma } = await import('../src/db');
const { runOnce } = await import('../src/jobs/runner');
const { sendUserEmailHandler } = await import('../src/jobs/handlers/sendUserEmail');

const refuse = () => Promise.reject(new Error('not used in e2e'));
const graph: GraphClient = {
  sendMail: async () => undefined,
  deltaPage: refuse, attachmentNames: refuse, markRead: refuse, moveTo: refuse, reply: refuse, calendarDeltaPage: refuse,
};

try {
  let n = 0;
  while (await runOnce({ types: ['send_user_email'], handlers: { send_user_email: sendUserEmailHandler }, graph, log: console.error })) n++;
  console.log(`e2e: ${n} send job(s) run`);
} finally {
  await prisma.$disconnect();
}
