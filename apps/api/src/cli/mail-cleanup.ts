// One-time (web-mail release 1): remove stored mail that is not lead mail. Run with tsx or node on the built file.
// No flag (or --dry-run) is a dry run: counts only, nothing changes. The real run needs --apply.
// --accept-unrecorded-deletes goes ahead although some lead-delete audit entries give no address.
// Any other argument is rejected (exit 1), so a mistyped flag never deletes.
import { prisma } from '../db.js';
import { CLEANUP_USAGE, CleanupRefusedError, cleanUpNonLeadMail, parseCleanupArgs } from '../mail/cleanup.js';

const parsed = parseCleanupArgs(process.argv.slice(2));
try {
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${CLEANUP_USAGE}`);
    process.exitCode = 1;
  } else {
    await cleanUpNonLeadMail(prisma, { ...parsed, log: (line) => console.log(line) });
  }
} catch (e) {
  if (!(e instanceof CleanupRefusedError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
