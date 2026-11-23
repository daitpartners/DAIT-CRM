import type { Job } from '@prisma/client';
import { commitBatch } from '../../imports/commit.js';
import type { ImportCommitPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/**
 * `import_commit` (Import leads): imports the batch's planned rows, one transaction per row. Queued with
 * `maxAttempts: 3`: a retry (or a restart after the worker stopped) imports only the rows that have no lead yet.
 */
export async function importCommitHandler(job: Job, _ctx: JobContext): Promise<void> {
  const { batchId } = job.payload as unknown as ImportCommitPayload;
  if (!Number.isInteger(batchId)) throw new Error('bad_payload');
  await commitBatch(batchId);
}
