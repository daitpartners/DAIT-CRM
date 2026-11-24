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
  /**
   * The CRM's countries: when given, a document's deterministic reading (`draftDocument`) runs in the child too and
   * comes back as `draft`, so its pattern matching over untrusted text is bounded by the same timeout and never runs
   * on the worker's event loop.
   */
  knownCountries?: readonly string[];
  /** Heap limit of the read process (tests use a small one to reach the out-of-memory path). */
  memoryMb?: number;
  /** Test seam: the child keeps itself busy this long (synchronously) before reading, like a slow hostile file. */
  busyMs?: number;
  /** Test seam: the child fills its heap until it runs out, like a runaway parser. */
  exhaustHeap?: boolean;
  /** Test seam: the child answers with the names of its environment variables instead of reading. */
  reportEnv?: boolean;
  /** Test seam: the child writes this to stderr and exits with code 3. */
  failWith?: string;
}

/** The only variables the read process gets: never the database URL, Microsoft, Claude or session secrets. */
const CHILD_ENV_KEYS = ['NODE_ENV', 'PATH', 'TZ'] as const;

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_KEYS) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

/** Kept from the child's stderr for the job's error (crash output only; never stored on the file). */
const STDERR_TAIL = 500;

/** Crash output, made safe to keep: printable characters only, whitespace collapsed, the last 500 characters. */
function stderrTail(text: string): string {
  return text.replace(/[^\x20-\x7e\n]/g, '').replace(/\s+/g, ' ').trim().slice(-STDERR_TAIL);
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
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4 * STDERR_TAIL); });
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
    // 'close' (not 'exit'): stderr has been read to the end by then.
    child.on('close', (code, signal) => finish(() => {
      // V8's fatal "heap out of memory" aborts (SIGABRT / 134); the kernel's OOM killer sends SIGKILL.
      if (signal === 'SIGABRT' || signal === 'SIGKILL' || code === 134) resolve({ status: 'Failed', meta: {}, error: 'too_large' });
      else {
        const tail = stderrTail(stderr);
        reject(new Error(`reader stopped (exit ${code ?? signal})${tail ? `: ${tail}` : ''}`));
      }
    }));
    child.send({
      ext, data: new Uint8Array(data), fileName, known: opts.knownCountries ? [...opts.knownCountries] : null, busyMs: opts.busyMs ?? 0, exhaustHeap: opts.exhaustHeap ?? false,
      reportEnv: opts.reportEnv ?? false, failWith: opts.failWith ?? null,
    });
  });
}
