import { Worker } from 'node:worker_threads';
import { fallbackText, RAW_MAX, type GraphBody } from './html.js';

/**
 * Email bodies processed off the event loop (security review N1, 24 Nov 2026): whatever an email holds, parsing and
 * sanitising it never blocks the API (on open) or the background worker (sync). One reused worker thread per process
 * takes one body at a time; a body it has not finished within BODY_TIMEOUT_MS has its worker terminated (a new one
 * starts for the next body) and is stored with no HTML and text from fallbackText, which needs no parser.
 */
export const BODY_TIMEOUT_MS = 3000;
/** Heap of the worker thread: a runaway allocation kills the worker (the body falls back), not the process. */
const WORKER_HEAP_MB = 256;

/**
 * Why a body fell back: `budget` the worker gave it up (nesting too deep to read in time), `error` processing threw,
 * `timeout` the worker was stopped at BODY_TIMEOUT_MS, `crash` the worker died (out of memory, or could not start).
 */
export type FallbackReason = 'budget' | 'error' | 'timeout' | 'crash';

export interface StoredBodies {
  bodyHtml: string | null;
  bodyText: string;
  /** The full processing failed or ran out of time: the text is the plain fallback. */
  fellBack?: true;
  reason?: FallbackReason;
  /** A timeout or crash (likely a busy machine, not the email) met for the first time: try the body again later. */
  retry?: true;
}

type Job = { id: number; body: GraphBody; max: number; outgoing?: boolean; whole?: boolean; timeoutMs: number; retryKey?: string; resolve: (r: StoredBodies) => void };

let worker: Worker | null = null;
let current: (Job & { timer: NodeJS.Timeout }) | null = null;
const queue: Job[] = [];
let nextId = 1;
let heapMb = WORKER_HEAP_MB;

/** Bodies already given their one retry (by the caller's key), oldest first; bounded. */
const retried = new Set<string>();
const RETRIED_MAX = 10_000;

/** Tests only: a smaller worker heap (null restores the default); the current worker is replaced. */
export function setBodyWorkerMemoryForTests(mb: number | null): void {
  heapMb = mb ?? WORKER_HEAP_MB;
  const w = worker;
  worker = null;
  void w?.terminate();
}

/** The compiled worker next to this file; under tsx / vitest (the .ts sources) it loads through tsx. */
function startWorker(): Worker {
  const ts = import.meta.url.endsWith('.ts');
  const w = new Worker(new URL(ts ? './bodyWorker.ts' : './bodyWorker.js', import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: heapMb },
    ...(ts ? { execArgv: ['--import', 'tsx'] } : {}),
  });
  w.on('message', (msg: { id: number; result?: StoredBodies; error?: string }) => {
    if (!current || msg.id !== current.id) return;
    finish(msg.result ?? fallback(current, msg.error === 'BodyTooComplexError' ? 'budget' : 'error'));
  });
  // A worker that crashes (or is terminated) fails the body it had, and the next body gets a new worker.
  w.on('error', () => drop(w));
  w.on('exit', () => drop(w));
  return w;
}

function drop(w: Worker): void {
  if (worker !== w) return;
  worker = null;
  if (current) finish(fallback(current, 'crash'));
}

function fallback(job: Pick<Job, 'body' | 'max' | 'retryKey'>, reason: FallbackReason): StoredBodies {
  const result: StoredBodies = { bodyHtml: null, bodyText: fallbackText(job.body.content, job.max), fellBack: true, reason };
  // At most one retry per body, and only when the email itself is not the likely cause.
  if ((reason === 'timeout' || reason === 'crash') && job.retryKey && !retried.has(job.retryKey)) {
    retried.add(job.retryKey);
    if (retried.size > RETRIED_MAX) retried.delete(retried.values().next().value!);
    result.retry = true;
  }
  return result;
}

function finish(result: StoredBodies): void {
  const job = current;
  if (!job) return;
  clearTimeout(job.timer);
  current = null;
  job.resolve(result);
  next();
}

function next(): void {
  if (current) return;
  const job = queue.shift();
  if (!job) {
    // Idle: the worker must not keep the process alive on its own.
    worker?.unref();
    return;
  }
  worker ??= startWorker();
  worker.ref();
  const timer = setTimeout(() => {
    const w = worker;
    worker = null;
    finish(fallback(job, 'timeout'));
    void w?.terminate();
  }, job.timeoutMs);
  current = { ...job, timer };
  worker.postMessage({ id: job.id, body: job.body, max: job.max, outgoing: job.outgoing, whole: job.whole });
}

/**
 * What to store for a body (as emailBodies in mail/html.ts): the sanitised HTML and the text derived from it, each at
 * most `max` characters, worked out in the worker thread; plain text needs no parsing and is cut here. `retryKey`
 * names the body (user and Graph id) so a timeout or crash is retried once, never more. `outgoing`: HTML the CRM is
 * about to send (formatted templates and messages: links limited to http, https and mailto); `whole`: never cut to `max`
 * (see emailBodies).
 */
export function processEmailBody(
  body: GraphBody, max: number, opts: { timeoutMs?: number; retryKey?: string; outgoing?: boolean; whole?: boolean } = {},
): Promise<StoredBodies> {
  if (body.contentType !== 'html') return Promise.resolve({ bodyHtml: null, bodyText: body.content.slice(0, max) });
  // Only what is read crosses to the worker (a 30 MB body is not copied whole).
  const capped: GraphBody = { contentType: 'html', content: body.content.slice(0, RAW_MAX) };
  return new Promise((resolve) => {
    queue.push({ id: nextId++, body: capped, max, outgoing: opts.outgoing, whole: opts.whole, timeoutMs: opts.timeoutMs ?? BODY_TIMEOUT_MS, retryKey: opts.retryKey, resolve });
    next();
  });
}

/**
 * The columns to store. A body that fell back keeps '' as its HTML (no HTML, show the text, do not ask again), except
 * the first time a timeout or crash met it: then null, so the next sync or open tries it once more. null otherwise
 * means "not read as HTML yet" (the API serves '' as null).
 */
export const storedColumns = (r: StoredBodies) => ({ bodyHtml: r.fellBack ? (r.retry ? null : '') : r.bodyHtml, bodyText: r.bodyText });
