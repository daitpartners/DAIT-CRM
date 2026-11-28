// One-time (lead mail timeline): merge the duplicate rows search and delta sync left for one email. Run with tsx or node on the built file.
// No flag (or --dry-run) is a dry run: counts only, nothing changes. The real run needs --apply.
// Any other argument is rejected (exit 1), so a mistyped flag never deletes.
import { prisma } from '../db.js';
import { DEDUPE_USAGE, dedupeMail, parseDedupeArgs } from '../mail/dedupe.js';

const parsed = parseDedupeArgs(process.argv.slice(2));
try {
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${DEDUPE_USAGE}`);
    process.exitCode = 1;
  } else {
    await dedupeMail(prisma, { ...parsed, log: (line) => console.log(line) });
  }
} finally {
  await prisma.$disconnect();
}
