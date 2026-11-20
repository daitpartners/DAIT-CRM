import { setTimeout as sleep } from 'node:timers/promises';
import type { Job } from '@prisma/client';
import type { GraphClient } from '../graph/client.js';
import { claimNext, complete, fail } from './queue.js';
import type { JobType } from './types.js';

export interface JobContext {
  graph: GraphClient;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

export interface RunnerOptions {
  types: JobType[];
  handlers: Partial<Record<JobType, JobHandler>>;
  graph: GraphClient;
  /** Receives one line per failed job; never given payloads or tokens. */
  log?: (msg: string) => void;
}

/** Claims and processes one job. Returns false when nothing was due. */
export async function runOnce(opts: RunnerOptions): Promise<boolean> {
  const job = await claimNext(opts.types);
  if (!job) return false;
  const handler = opts.handlers[job.type as JobType];
  try {
    if (!handler) throw new Error('no_handler');
    await handler(job, { graph: opts.graph });
    await complete(job.id);
  } catch (err) {
    opts.log?.(`job ${job.id} (${job.type}) failed: ${err instanceof Error ? err.message : String(err)}`);
    await fail(job.id, err);
  }
  return true;
}

/** Processes jobs until `signal` aborts; an abort lets the current job finish first. */
export async function runForever(opts: RunnerOptions & { pollMs?: number; signal: AbortSignal }): Promise<void> {
  const { pollMs = 2000, signal } = opts;
  while (!signal.aborted) {
    let worked = false;
    try {
      worked = await runOnce(opts);
    } catch (err) {
      // Database hiccup while claiming or recording a result: back off and try again.
      opts.log?.(`runner error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!worked && !signal.aborted) {
      await sleep(pollMs, undefined, { signal }).catch(() => undefined);
    }
  }
}
