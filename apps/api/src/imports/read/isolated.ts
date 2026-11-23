/**
 * Runs a file read in its own worker thread, with a wall-clock timeout and a memory ceiling, so a hostile file (a page
 * tree that repeats one page endlessly, a sheet of millions of cells) can never block the worker process's event loop
 * (mail, research and the scheduler share it) or take it down. Timeout → Failed `timeout`; out of memory → Failed
 * `too_large`; any other crash is thrown (the job marks the file `unreadable`).
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { ImportExt } from '@dait-crm/shared';
import type { ReadResult } from './index.js';

/** Well under the queue's 15-minute stale limit, so the sweep never releases a file whose read is still running. */
export const READ_TIMEOUT_MS = 120_000;
export const READ_MEMORY_MB = 512;

/** From source (tests, tsx) the entry is TypeScript and needs the tsx loader; from dist it is plain JavaScript. */
const fromSource = fileURLToPath(import.meta.url).endsWith('.ts');
const ENTRY = new URL(fromSource ? './thread.ts' : './thread.js', import.meta.url);

type Message = { ok: true; result: ReadResult } | { ok: false; message: string };

export function readInWorker(
  ext: ImportExt, data: Buffer, fileName?: string, opts: { timeoutMs?: number } = {},
): Promise<ReadResult> {
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const worker = new Worker(ENTRY, {
      workerData: { ext, data: new Uint8Array(data), fileName },
      execArgv: fromSource ? ['--import', 'tsx'] : [],
      resourceLimits: { maxOldGenerationSizeMb: READ_MEMORY_MB },
      stdout: false,
      stderr: false,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => resolve({ status: 'Failed', meta: {}, error: 'timeout' })), timeoutMs);
    worker.on('message', (m: Message) => finish(() => (m.ok ? resolve(m.result) : reject(new Error(m.message)))));
    worker.on('error', (e: Error & { code?: string }) => finish(() => (
      e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? resolve({ status: 'Failed', meta: {}, error: 'too_large' }) : reject(e)
    )));
    worker.on('exit', (code) => finish(() => reject(new Error(`reader stopped (exit ${code})`))));
  });
}
