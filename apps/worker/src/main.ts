// Thin launcher: the queue, runner and handlers live in @dait-crm/api (shared Prisma client and Graph code).
// PM2 starts this with `node --env-file=<path>/.env dist/main.js`.
import { startWorker } from '@dait-crm/api/worker';

try {
  await startWorker();
  process.exit(0);
} catch (err) {
  console.error('worker: fatal', err instanceof Error ? err.message : err);
  process.exit(1);
}
