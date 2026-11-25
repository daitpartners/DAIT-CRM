import { parentPort } from 'node:worker_threads';
import { emailBodies, type GraphBody } from './html.js';

/**
 * Worker thread for mail/bodies.ts: parses and sanitises one email body at a time, off the caller's event loop. A body
 * whose nesting takes more than BUDGET_MS to read is given up at once (the caller stores the plain fallback) rather
 * than running on to the caller's hard time limit.
 */
const BUDGET_MS = 1000;

parentPort!.on('message', (job: { id: number; body: GraphBody; max: number; outgoing?: boolean; whole?: boolean; cids?: string[] }) => {
  try {
    const opts = { deadline: performance.now() + BUDGET_MS, outgoing: job.outgoing, whole: job.whole, cids: job.cids };
    parentPort!.postMessage({ id: job.id, result: emailBodies(job.body, job.max, opts) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error)?.name ?? 'Error' });
  }
});
