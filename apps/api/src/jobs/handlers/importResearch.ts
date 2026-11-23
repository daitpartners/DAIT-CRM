import type { Job } from '@prisma/client';
import type { ImportDeps } from '../../imports/claude.js';
import { continueResearch, researchNextRow } from '../../imports/research.js';
import type { ImportResearchPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** Test seam: the website reader's resolver, a fake Claude runner and the environment. */
export const importResearchDeps: ImportDeps = {};

/**
 * `import_research` (Import leads): researches the batch's next waiting row (website reader, then Claude; up to a few
 * minutes, well inside the queue's 15-minute stale limit), then queues the next job while rows are left, so company
 * research on the same lane waits for one row at most. Paused, finished or stopped at the Claude cap: the chain ends.
 */
export async function importResearchHandler(job: Job, _ctx: JobContext): Promise<void> {
  const { batchId } = job.payload as unknown as ImportResearchPayload;
  if (!Number.isInteger(batchId)) throw new Error('bad_payload');
  if (await researchNextRow(batchId, importResearchDeps) === 'more') await continueResearch(batchId);
}
