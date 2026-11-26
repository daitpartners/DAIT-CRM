// One-time (web-mail release 1): remove stored mail that is not lead mail. Run with tsx or node on the built file,
// first with --dry-run. --accept-unrecorded-deletes goes ahead although some lead-delete audit entries record no addresses.
import { prisma } from '../db.js';
import { CleanupRefusedError, cleanUpNonLeadMail } from '../mail/cleanup.js';

const args = process.argv.slice(2);
try {
  await cleanUpNonLeadMail(prisma, {
    dryRun: args.includes('--dry-run'),
    acceptUnrecordedDeletes: args.includes('--accept-unrecorded-deletes'),
    log: (line) => console.log(line),
  });
} catch (e) {
  if (!(e instanceof CleanupRefusedError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
