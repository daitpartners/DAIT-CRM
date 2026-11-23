import type { Job } from '@prisma/client';
import { LeaseLost, commitBatch, failImport, type CommitDeps } from '../../imports/commit.js';
import type { ImportCommitPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** Test seam: passed to `commitBatch` (e.g. a failing `afterRow`). */
export const importCommitDeps: CommitDeps = {};

/**
 * `import_commit` (Import leads): imports the batch's planned rows, one transaction per row. Queued with
 * `maxAttempts: 3`: a retry (or a restart after the worker stopped, see `sweepImportCommit`) imports only the rows that
 * have no lead yet. When the last attempt fails (other than by losing the lease) the batch becomes Failed `job_failed`,
 * and can be continued.
 */
export async function importCommitHandler(job: Job, _ctx: JobContext): Promise<void> {
  const { batchId } = job.payload as unknown as ImportCommitPayload;
  if (!Number.isInteger(batchId)) throw new Error('bad_payload');
  try {
    await commitBatch(batchId, importCommitDeps);
  } catch (e) {
    // A run that lost its lease leaves the batch to the run holding it.
    if (!(e instanceof LeaseLost) && job.attempts + 1 >= job.maxAttempts) await failImport(batchId, 'job_failed');
    throw e;
  }
}
