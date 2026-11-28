// One-time (lead mail timeline): put past lead mail on the lead timelines, after mail-dedupe. Run with tsx or node on the built file.
// No flag (or --dry-run) is a dry run: counts only, nothing changes. The real run needs --apply.
// Any other argument is rejected (exit 1), so a mistyped flag never writes.
import { prisma } from '../db.js';
import { FILL_USAGE, fillLeadMailTimeline, parseFillArgs } from '../mail/timelineFill.js';

const parsed = parseFillArgs(process.argv.slice(2));
try {
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${FILL_USAGE}`);
    process.exitCode = 1;
  } else {
    await fillLeadMailTimeline(prisma, { ...parsed, log: (line) => console.log(line) });
  }
} finally {
  await prisma.$disconnect();
}
