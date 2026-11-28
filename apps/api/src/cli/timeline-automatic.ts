// One-time (timeline without bounces): take bounces and automatic replies off the lead timelines. Run with tsx or node on the built file.
// No flag (or --dry-run) is a dry run: counts only, nothing changes. The real run needs --apply.
// Any other argument is rejected (exit 1), so a mistyped flag never deletes.
import { prisma } from '../db.js';
import { TIMELINE_AUTOMATIC_USAGE, cleanTimelineAutomatic, parseTimelineAutomaticArgs } from '../mail/automaticCleanup.js';

const parsed = parseTimelineAutomaticArgs(process.argv.slice(2));
try {
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${TIMELINE_AUTOMATIC_USAGE}`);
    process.exitCode = 1;
  } else {
    await cleanTimelineAutomatic(prisma, { ...parsed, log: (line) => console.log(line) });
  }
} finally {
  await prisma.$disconnect();
}
