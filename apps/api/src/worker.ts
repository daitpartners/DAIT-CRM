import { prisma } from './db.js';
import { createGraphClient, type GraphClient } from './graph/client.js';
import { runForever } from './jobs/runner.js';
import { sendEmailHandler } from './jobs/handlers/sendEmail.js';

export { runOnce, runForever } from './jobs/runner.js';

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

  console.log('worker: started');
  try {
    await runForever({
      types: ['send_email'],
      handlers: { send_email: sendEmailHandler },
      graph: opts.graph ?? createGraphClient(process.env),
      pollMs: opts.pollMs,
      signal: controller.signal,
      log: (msg) => console.warn(`worker: ${msg}`),
    });
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    opts.signal?.removeEventListener('abort', onAbort);
    await prisma.$disconnect();
    console.log('worker: stopped');
  }
}
