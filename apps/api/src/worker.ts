import { prisma } from './db.js';
import { createGraphClient, type GraphClient } from './graph/client.js';
import { runForever, type JobHandler } from './jobs/runner.js';
import type { JobType } from './jobs/types.js';
import { pruneJobs } from './jobs/queue.js';
import { sendUserEmailHandler } from './jobs/handlers/sendUserEmail.js';
import { sendEmailHandler } from './jobs/handlers/sendEmail.js';
import { syncMailboxHandler } from './jobs/handlers/syncMailbox.js';
import { syncCalendarHandler } from './jobs/handlers/syncCalendar.js';
import { mailActionHandler } from './jobs/handlers/mailAction.js';
import { campaignStepHandler } from './jobs/handlers/campaignStep.js';
import { researchCompanyHandler } from './jobs/handlers/researchCompany.js';
import { importReadFileHandler } from './jobs/handlers/importReadFile.js';
import { scheduleCampaigns } from './mailer/schedule.js';
import { scheduleMailSync } from './mail/schedule.js';
import { scheduleCalendarSync } from './calendar/schedule.js';
import { scheduleQuotationExpiry } from './jobs/quotationExpiry.js';
import { sweepStuckRuns } from './research/service.js';
import { sweepImportFiles } from './imports/batches.js';

export { runOnce, runForever } from './jobs/runner.js';

const HANDLERS: Partial<Record<JobType, JobHandler>> = {
  send_email: sendEmailHandler, send_user_email: sendUserEmailHandler, sync_mailbox: syncMailboxHandler, mail_action: mailActionHandler,
  campaign_step: campaignStepHandler, sync_calendar: syncCalendarHandler, research_company: researchCompanyHandler,
  import_read_file: importReadFileHandler,
};

/**
 * The worker's job lanes, each claimed by its own loop (concurrency 1 per lane). Mail jobs are quick; an AI research
 * run can take minutes (website read + Claude), so it has its own lane; so does Import leads (reading a 20 MB file,
 * importing a batch row by row), so a big import never holds up mail or research.
 */
export const WORKER_LANES: readonly { name: string; types: readonly JobType[] }[] = [
  { name: 'mail', types: ['send_email', 'send_user_email', 'sync_mailbox', 'mail_action', 'campaign_step', 'sync_calendar'] },
  { name: 'research', types: ['research_company'] },
  { name: 'import', types: ['import_read_file', 'import_commit'] },
];

/** How often the worker checks which mailboxes are due a sync. */
const SCHEDULE_EVERY_MS = 60_000;
/** How often old finished job rows are cleaned up. */
const CLEANUP_EVERY_MS = 60 * 60_000;

export interface StartWorkerOptions {
  graph?: GraphClient;
  pollMs?: number;
  /** Extra stop signal (tests); SIGTERM and SIGINT always stop the worker. */
  signal?: AbortSignal;
}

/** Runs the job worker until SIGTERM/SIGINT, finishing the current job before exiting. */
export async function startWorker(opts: StartWorkerOptions = {}): Promise<void> {
  const controller = new AbortController();
  const stop = (reason: string) => {
    if (controller.signal.aborted) return;
    console.log(`worker: ${reason}, stopping after the current job`);
    controller.abort();
  };
  const onTerm = () => stop('SIGTERM received');
  const onInt = () => stop('SIGINT received');
  const onAbort = () => stop('stop requested');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener('abort', onAbort);

  // Mail sync (release 2B-2): each connected mailbox gets a run queued 5 minutes after its last one.
  const warn = (what: string) => (err: unknown) => console.warn(`worker: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  // Mailer (release 2C): scheduled campaigns start, due ones get their next step.
  // Calendar (release 3C): each calendar with Sync calendar on is copied 5 minutes after its last run.
  // Quotations (release 3A): Sent / Negotiating past valid-until become Expired (checked at most hourly).
  const schedule = () => Promise.all([
    scheduleMailSync().catch(warn('mail schedule')),
    scheduleCampaigns().catch(warn('mailer schedule')),
    scheduleCalendarSync().catch(warn('calendar schedule')),
    scheduleQuotationExpiry().catch(warn('quotation expiry')),
    // AI research (release 4): runs a worker will never finish become Failed "Interrupted".
    sweepStuckRuns().catch(warn('research sweep')),
    // Import leads: files left Reading after their job was lost become Failed "Reading was interrupted".
    sweepImportFiles().catch(warn('import sweep')),
  ]);
  // At startup no research job is running yet, so every Processing run was interrupted.
  await sweepStuckRuns({ startup: true }).catch(warn('research startup sweep'));
  await sweepImportFiles().catch(warn('import startup sweep'));
  void schedule();
  const scheduler = setInterval(schedule, SCHEDULE_EVERY_MS);
  // Old done / failed job rows are deleted at start and hourly.
  const cleanup = () => pruneJobs(prisma).catch(warn('job cleanup'));
  void cleanup();
  const cleaner = setInterval(cleanup, CLEANUP_EVERY_MS);

  console.log('worker: started');
  try {
    const graph = opts.graph ?? createGraphClient(process.env);
    const log = (msg: string) => console.warn(`worker: ${msg}`);
    // One loop per lane, each one job at a time: a slow research run never holds up mail.
    await Promise.all(WORKER_LANES.map((lane) => runForever({
      types: [...lane.types], handlers: HANDLERS, graph, pollMs: opts.pollMs, signal: controller.signal, log,
    })));
  } finally {
    clearInterval(scheduler);
    clearInterval(cleaner);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    opts.signal?.removeEventListener('abort', onAbort);
    await prisma.$disconnect();
    console.log('worker: stopped');
  }
}
