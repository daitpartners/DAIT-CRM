import { prisma } from './db.js';
import { createGraphClient, type GraphClient } from './graph/client.js';
import { runForever } from './jobs/runner.js';
import { sendUserEmailHandler } from './jobs/handlers/sendUserEmail.js';
import { sendEmailHandler } from './jobs/handlers/sendEmail.js';
import { syncMailboxHandler } from './jobs/handlers/syncMailbox.js';
import { scheduleMailSync } from './mail/schedule.js';

export { runOnce, runForever } from './jobs/runner.js';

/** How often the worker checks which mailboxes are due a sync. */
const SCHEDULE_EVERY_MS = 60_000;

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
  const schedule = () => scheduleMailSync().catch((err: unknown) => console.warn(`worker: mail schedule failed: ${err instanceof Error ? err.message : String(err)}`));
  void schedule();
  const scheduler = setInterval(schedule, SCHEDULE_EVERY_MS);

  console.log('worker: started');
  try {
    await runForever({
      types: ['send_email', 'send_user_email', 'sync_mailbox'],
      handlers: { send_email: sendEmailHandler, send_user_email: sendUserEmailHandler, sync_mailbox: syncMailboxHandler },
      graph: opts.graph ?? createGraphClient(process.env),
      pollMs: opts.pollMs,
      signal: controller.signal,
      log: (msg) => console.warn(`worker: ${msg}`),
    });
  } finally {
    clearInterval(scheduler);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    opts.signal?.removeEventListener('abort', onAbort);
    await prisma.$disconnect();
    console.log('worker: stopped');
  }
}
