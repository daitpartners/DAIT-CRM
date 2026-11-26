// Web-mail release 1 backfill. Run with tsx or node on the built file:
//   --status          rows by status, totals and per mailbox (mailbox addresses only, never lead addresses)
//   --retry           failed and skipped rows are queued again (e.g. after a mailbox reconnect)
//   --mailbox <id>    a mailbox reconnected after its addresses were queued gets a row for every known address (F20)
// The worker picks queued rows up within a minute.
import { prisma } from '../db.js';
import { backfillStatus, ensureBackfillJob, queueMailboxBackfills, retryBackfills } from '../mail/backfill.js';

const args = process.argv.slice(2);
try {
  const mailboxAt = args.indexOf('--mailbox');
  if (mailboxAt >= 0) {
    const accountId = Number(args[mailboxAt + 1]);
    if (!Number.isInteger(accountId) || accountId <= 0) throw new Error('--mailbox needs a mailbox id');
    console.log(`queued: ${await queueMailboxBackfills(prisma, accountId)}`);
    await ensureBackfillJob(prisma);
  } else if (args.includes('--retry')) {
    console.log(`queued again: ${await retryBackfills(prisma)}`);
    await ensureBackfillJob(prisma);
  } else if (args.includes('--status')) {
    console.log(JSON.stringify(await backfillStatus(prisma), null, 2));
  } else {
    console.error('usage: mail-backfill --status | --retry | --mailbox <id>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
