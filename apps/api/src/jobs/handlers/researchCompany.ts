import type { Job } from '@prisma/client';
import { runResearch } from '../../research/service.js';
import type { ResearchCompanyPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/**
 * `research_company` (release 4): runs one queued research run. A full website read can take up to ~100 s (4 pages,
 * 10 s timeouts, sequential) plus the Claude call, well inside the queue's 15-minute stale limit; the company stays
 * Processing meanwhile. Provider failures mark the run Failed rather than failing the job (one attempt only).
 */
export async function researchCompanyHandler(job: Job, _ctx: JobContext): Promise<void> {
  const { runId } = job.payload as unknown as ResearchCompanyPayload;
  if (!Number.isInteger(runId)) throw new Error('bad_payload');
  await runResearch(runId);
}
