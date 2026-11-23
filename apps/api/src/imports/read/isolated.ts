/**
 * Runs a file read in its own child process, with a wall-clock timeout and a heap ceiling, so a hostile file (a page
 * tree that repeats one page endlessly, a sheet of millions of cells) can never block the worker process's event loop
 * (mail, research and the scheduler share it) or take it down. A child process, not a worker thread: V8 can end the
 * whole process with a fatal "heap out of memory" when a thread hits its limit inside a large native allocation,
 * which a separate process contains. Timeout → Failed `timeout`; out of memory (the child aborts or is killed) →
 * Failed `too_large`; any other failure is thrown (the job marks the file `unreadable`).
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ImportExt } from '@dait-crm/shared';
import type { ReadResult } from './index.js';

/** Well under the queue's 15-minute stale limit, so the sweep never releases a file whose read is still running. */
export const READ_TIMEOUT_MS = 120_000;
/** V8 heap of the read process. Buffers (inflated zip entries, file bytes) are outside it: zips are capped separately. */
export const READ_MEMORY_MB = 512;

export interface ReadInWorkerOptions {
  timeoutMs?: number;
  /** Heap limit of the read process (tests use a small one to reach the out-of-memory path). */
  memoryMb?: number;
  /** Test seam: the child keeps itself busy this long (synchronously) before reading, like a slow hostile file. */
  busyMs?: number;
  /** Test seam: the child fills its heap until it runs out, like a runaway parser. */
  exhaustHeap?: boolean;
}

/** From source (tests, tsx) the entry is TypeScript and needs the tsx loader; from dist it is plain JavaScript. */
const fromSource = fileURLToPath(import.meta.url).endsWith('.ts');
const ENTRY = fileURLToPath(new URL(fromSource ? './child.ts' : './child.js', import.meta.url));

type Message = { ok: true; result: ReadResult } | { ok: false; message: string };

export function readInWorker(
  ext: ImportExt, data: Buffer, fileName?: string, opts: ReadInWorkerOptions = {},
): Promise<ReadResult> {
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = fork(ENTRY, [], {
      execArgv: [...(fromSource ? ['--import', 'tsx'] : []), `--max-old-space-size=${opts.memoryMb ?? READ_MEMORY_MB}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => finish(() => resolve({ status: 'Failed', meta: {}, error: 'timeout' })), timeoutMs);
    child.on('message', (m: Message) => finish(() => (m.ok ? resolve(m.result) : reject(new Error(m.message)))));
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code, signal) => finish(() => {
      // V8's fatal "heap out of memory" aborts (SIGABRT / 134); the kernel's OOM killer sends SIGKILL.
      if (signal === 'SIGABRT' || signal === 'SIGKILL' || code === 134) resolve({ status: 'Failed', meta: {}, error: 'too_large' });
      else reject(new Error(`reader stopped (exit ${code ?? signal})`));
    }));
    child.send({ ext, data: new Uint8Array(data), fileName, busyMs: opts.busyMs ?? 0, exhaustHeap: opts.exhaustHeap ?? false });
  });
}
