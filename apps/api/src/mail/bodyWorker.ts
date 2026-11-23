import { parentPort } from 'node:worker_threads';
import { emailBodies, type GraphBody } from './html.js';

/**
 * Worker thread for mail/bodies.ts: parses and sanitises one email body at a time, off the caller's event loop. A body
 * whose nesting takes more than BUDGET_MS to read is given up at once (the caller stores the plain fallback) rather
 * than running on to the caller's hard time limit.
 */
const BUDGET_MS = 1000;

parentPort!.on('message', (job: { id: number; body: GraphBody; max: number }) => {
  try {
    parentPort!.postMessage({ id: job.id, result: emailBodies(job.body, job.max, { deadline: performance.now() + BUDGET_MS }) });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error)?.name ?? 'Error' });
  }
});
