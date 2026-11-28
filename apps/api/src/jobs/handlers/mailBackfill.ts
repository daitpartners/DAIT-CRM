import type { Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { enqueue, errorMessage } from '../queue.js';
import { GraphError, isAuthFailure, searchStartUrl } from '../../graph/client.js';
import { mailUser } from '../../mail/match.js';
import { loadLeadMailRules } from '../../mail/leadMail.js';
import {
  BACKFILL_DAYS, BACKFILL_GAP_MS, BACKFILL_MAX_ATTEMPTS, BACKFILL_PAGES, BACKFILL_TIME_BUDGET_MS, THROTTLE_MIN_MS, folderResolver,
} from '../../mail/backfill.js';
import { storeMessage } from './syncMailbox.js';
import type { JobContext } from '../runner.js';

/** Claims the lowest-id queued row (`running`); null when none is queued. */
async function claimRow(): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    UPDATE mail_backfills SET status = 'running', updated_at = (now() AT TIME ZONE 'UTC')
    WHERE id = (
      SELECT id FROM mail_backfills WHERE status = 'queued' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id`;
  return rows[0]?.id ?? null;
}

/** How long Graph asked us to wait (seconds in the error's `retry-after=`), at least THROTTLE_MIN_MS. */
function throttleDelay(err: GraphError): number {
  const seconds = Number(/retry-after=(\d+)/.exec(err.message)?.[1] ?? 0);
  return Math.max(seconds * 1000, THROTTLE_MIN_MS);
}

/**
 * One step of the backfill chain (web-mail release 1): searches one mailbox for one lead/contact address over the last
 * BACKFILL_DAYS, storing lead mail in the synced folders through `storeMessage` (the same rules as sync). A job reads at
 * most BACKFILL_PAGES pages or BACKFILL_TIME_BUDGET_MS, whichever comes first (F13), and saves its place after every
 * page; the rest is read by a later job. Then the next job is queued BACKFILL_GAP_MS later while rows remain (or after
 * Graph's Retry-After, at least THROTTLE_MIN_MS, when throttled). Logs ids, status and counts only.
 */
export async function mailBackfillHandler(_job: Job, ctx: JobContext): Promise<void> {
  const id = await claimRow();
  if (id === null) return;
  const row = await prisma.mailBackfill.findUniqueOrThrow({ where: { id }, include: { account: true } });
  const { account } = row;
  let found = row.found;
  let stored = row.stored;
  let status: 'queued' | 'done' | 'failed' | 'skipped';
  let nextJobAfter = BACKFILL_GAP_MS;

  const user = account.kind === 'personal' && account.status === 'connected' && account.syncMail && account.userId !== null
    ? await mailUser(prisma, account.userId)
    : null;
  if (!user) {
    status = 'skipped';
    await prisma.mailBackfill.update({ where: { id }, data: { status } });
  } else {
    const started = Date.now();
    let url = row.nextLink ?? searchStartUrl(row.address, new Date(started - BACKFILL_DAYS * 86_400_000));
    try {
      const rules = await loadLeadMailRules(prisma);
      const crmFolderOf = folderResolver(account, ctx.graph);
      status = 'queued';
      for (let pages = 0; pages < BACKFILL_PAGES && Date.now() - started < BACKFILL_TIME_BUDGET_MS; pages++) {
        const page = await ctx.graph.searchPage(account, url);
        for (const item of page.items) {
          found += 1;
          const folder = await crmFolderOf(item.folderId);
          if (folder && (await storeMessage(account, user, folder, item.message, ctx, rules, 'search')) === 'stored') stored += 1;
        }
        if (!page.nextLink) {
          status = 'done';
          break;
        }
        url = page.nextLink;
        // Its place is saved after every page: a failure or a lost job continues from the last page read in full.
        await prisma.mailBackfill.update({ where: { id }, data: { nextLink: url, found, stored } });
      }
      await prisma.mailBackfill.update({
        where: { id },
        data: status === 'done' ? { status, nextLink: null, found, stored, finishedAt: new Date(), lastError: null } : { status, found, stored },
      });
    } catch (err) {
      if (err instanceof GraphError && err.status === 429) {
        status = 'queued';
        nextJobAfter = throttleDelay(err);
        await prisma.mailBackfill.update({ where: { id }, data: { status } });
      } else if (isAuthFailure(err)) {
        status = 'skipped';
        await prisma.mailBackfill.update({ where: { id }, data: { status, lastError: 'mailbox_needs_reconnect' } });
      } else {
        const attempts = row.attempts + 1;
        status = attempts >= BACKFILL_MAX_ATTEMPTS ? 'failed' : 'queued';
        await prisma.mailBackfill.update({ where: { id }, data: { status, attempts, lastError: errorMessage(err) } });
      }
    }
  }

  const saved = await prisma.mailBackfill.findUniqueOrThrow({ where: { id }, select: { found: true, stored: true } });
  console.log(`mail_backfill: row ${id} account ${account.id} ${status} found=${saved.found} stored=${saved.stored}`);
  if (await prisma.mailBackfill.count({ where: { status: 'queued' } })) {
    await enqueue(prisma, 'mail_backfill', {}, { runAt: new Date(Date.now() + nextJobAfter), maxAttempts: 1 });
  }
}
