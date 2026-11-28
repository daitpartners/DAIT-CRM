/**
 * One-off clean-up (CLI `cli/timeline-automatic.ts`, run once after the release is live): takes bounces and automatic
 * replies (`isAutomaticMail`) off the lead timelines, where the lead mail timeline put them before they were skipped.
 *
 * A line goes when it is an automatic received line (activity type `email`, related to an `email_message`, title
 * starting `Email received`, no author: `logLeadMail` wrote it, not a person's Log as activity) and its related row is
 * automatic. The row then loses `logged_at` when no other line points at it. The rows stay (Email screen).
 *
 * Logs counts only (never subjects or addresses). Safe to run again: a second run finds no lines.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { isAutomaticMail } from './automatic.js';

export interface TimelineAutomaticCounts {
  /** Timeline lines removed (dry run: that would be removed). */
  lines: number;
}

export const TIMELINE_AUTOMATIC_USAGE = 'usage: timeline-automatic [--dry-run | --apply]  (no flag = dry run)';

/**
 * CLI arguments of `cli/timeline-automatic.ts`. The real run needs an explicit `--apply`; no flag or `--dry-run` is a
 * dry run. An unknown argument, or `--apply` with `--dry-run`, is an error (so a mistyped flag never deletes).
 */
export function parseTimelineAutomaticArgs(argv: string[]): { apply: boolean } | { error: string } {
  const known = new Set(['--dry-run', '--apply']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(' ')}` };
  if (argv.includes('--apply') && argv.includes('--dry-run')) return { error: '--apply and --dry-run together' };
  return { apply: argv.includes('--apply') };
}

/** The automatic received lines: their ids and the rows they point at. */
async function findLines(db: PrismaClient | Prisma.TransactionClient): Promise<{ id: number; relatedId: number }[]> {
  const lines = await db.leadActivity.findMany({
    where: { activityType: 'email', relatedType: 'email_message', relatedId: { not: null }, byUserId: null, title: { startsWith: 'Email received' } },
    select: { id: true, relatedId: true },
    orderBy: { id: 'asc' },
  });
  if (lines.length === 0) return [];
  const rows = await db.emailMessage.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.relatedId!))] } }, select: { id: true, fromAddress: true, subject: true },
  });
  const automatic = new Set(rows.filter(isAutomaticMail).map((r) => r.id));
  return lines.filter((l) => automatic.has(l.relatedId!)).map((l) => ({ id: l.id, relatedId: l.relatedId! }));
}

export async function cleanTimelineAutomatic(
  db: PrismaClient, opts: { apply: boolean; log: (line: string) => void },
): Promise<TimelineAutomaticCounts> {
  const lines = opts.apply
    ? await db.$transaction(async (tx) => {
      const found = await findLines(tx);
      if (found.length === 0) return 0;
      await tx.leadActivity.deleteMany({ where: { id: { in: found.map((l) => l.id) } } });
      const related = [...new Set(found.map((l) => l.relatedId))];
      const stillPointed = await tx.leadActivity.findMany({
        where: { relatedType: 'email_message', relatedId: { in: related } }, select: { relatedId: true },
      });
      const keep = new Set(stillPointed.map((l) => l.relatedId!));
      const clear = related.filter((id) => !keep.has(id));
      if (clear.length > 0) await tx.emailMessage.updateMany({ where: { id: { in: clear } }, data: { loggedAt: null } });
      return found.length;
    })
    : (await findLines(db)).length;
  opts.log(`timeline-automatic: ${opts.apply ? 'applied' : 'dry run'} lines=${lines}`);
  return { lines };
}
