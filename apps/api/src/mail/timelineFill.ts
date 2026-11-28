/**
 * One-time fill for the lead mail timeline (CLI `cli/lead-mail-timeline.ts`, run once after `mail-dedupe`): walks every
 * stored lead-linked email (not drafts, the send queue or failed sends, lead not deleted) oldest first, in batches of
 * 200, and puts the missing ones on their lead's timeline through `logLeadMail` (same rules, same "already logged"
 * check, same Contacted move).
 *
 * The dry run runs exactly the same writes inside one transaction and rolls it back, so its counts match `--apply`
 * (copies of one email in two mailboxes count once). `--apply` commits one transaction per batch.
 *
 * Logs counts only (never subjects, bodies or addresses). Safe to run again: a second run adds 0.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { UNSENT_STATUSES, logLeadMail, teamSenders } from './leadTimeline.js';

type Tx = Prisma.TransactionClient;

export interface FillCounts {
  /** Lead-linked emails walked. */
  examined: number;
  /** Timeline lines added. */
  lines: number;
  /** Leads that got at least one line. */
  leads: number;
  /** Leads moved to Contacted. */
  contacted: number;
}

const BATCH = 200;

/** The dry run holds one transaction for the whole walk (about 600 rows live); a batch of `--apply` holds one per 200. */
const DRY_RUN_TX = { maxWait: 30_000, timeout: 30 * 60_000 };
const BATCH_TX = { maxWait: 30_000, timeout: 5 * 60_000 };

/** Thrown at the end of the dry run to roll its transaction back. */
class DryRunRollback extends Error {}

export const FILL_USAGE = 'usage: lead-mail-timeline [--dry-run | --apply]  (no flag = dry run)';

/**
 * CLI arguments of `cli/lead-mail-timeline.ts`. The real run needs an explicit `--apply`; no flag or `--dry-run` is a
 * dry run. An unknown argument, or `--apply` with `--dry-run`, is an error (so a mistyped flag never writes).
 */
export function parseFillArgs(argv: string[]): { apply: boolean } | { error: string } {
  const known = new Set(['--dry-run', '--apply']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) return { error: `unknown argument: ${unknown.join(' ')}` };
  if (argv.includes('--apply') && argv.includes('--dry-run')) return { error: '--apply and --dry-run together' };
  return { apply: argv.includes('--apply') };
}

/** Rows the walk visits; `logLeadMail` checks the same again under the lead's lock. */
const CANDIDATES: Prisma.EmailMessageWhereInput = {
  leadId: { not: null }, leadDeletedAt: null, folder: { not: 'drafts' }, status: { notIn: UNSENT_STATUSES },
};

/**
 * Walks the candidates oldest first. `read` pages through them; `inBatch` runs one batch's writes in a transaction
 * (the dry run's outer one, or a new one per batch).
 */
async function walk(read: PrismaClient | Tx, inBatch: (fn: (tx: Tx) => Promise<void>) => Promise<void>): Promise<FillCounts> {
  const senders = await teamSenders(read);
  const leads = new Set<number>();
  const contacted = new Set<number>();
  let examined = 0;
  let lines = 0;
  // Keyset paging on (occurred_at, id): a row deleted meanwhile (sync, Outlook) never ends the walk early.
  let last: { id: number; occurredAt: Date } | undefined;
  for (;;) {
    const after: Prisma.EmailMessageWhereInput = last
      ? { OR: [{ occurredAt: { gt: last.occurredAt } }, { occurredAt: last.occurredAt, id: { gt: last.id } }] }
      : {};
    const page = await read.emailMessage.findMany({
      where: { AND: [CANDIDATES, after] }, select: { id: true, leadId: true, occurredAt: true },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: BATCH,
    });
    if (page.length === 0) break;
    await inBatch(async (tx) => {
      for (const r of page) {
        const before = await tx.lead.findUnique({ where: { id: r.leadId! }, select: { status: true } });
        if ((await logLeadMail(tx, r.id, { senders })) !== 'logged') continue;
        lines += 1;
        leads.add(r.leadId!);
        const after = await tx.lead.findUnique({ where: { id: r.leadId! }, select: { status: true } });
        if (before && before.status !== 'Contacted' && after?.status === 'Contacted') contacted.add(r.leadId!);
      }
    });
    examined += page.length;
    last = page[page.length - 1]!;
  }
  return { examined, lines, leads: leads.size, contacted: contacted.size };
}

export async function fillLeadMailTimeline(db: PrismaClient, opts: { apply: boolean; log: (line: string) => void }): Promise<FillCounts> {
  let counts: FillCounts;
  if (opts.apply) {
    counts = await walk(db, async (fn) => { await db.$transaction(fn, BATCH_TX); });
  } else {
    let predicted: FillCounts | undefined;
    try {
      await db.$transaction(async (tx) => {
        predicted = await walk(tx, (fn) => fn(tx));
        throw new DryRunRollback();
      }, DRY_RUN_TX);
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    counts = predicted!;
  }
  opts.log(
    `lead-mail-timeline: ${opts.apply ? 'applied' : 'dry run'} examined=${counts.examined} lines=${counts.lines} `
      + `leads=${counts.leads} contacted=${counts.contacted}`,
  );
  return counts;
}
