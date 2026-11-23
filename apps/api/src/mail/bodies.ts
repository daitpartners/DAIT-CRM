import { Worker } from 'node:worker_threads';
import { fallbackText, RAW_MAX, type GraphBody } from './html.js';

/**
 * Email bodies processed off the event loop (security review N1, 24 Nov 2026): whatever an email holds, parsing and
 * sanitising it never blocks the API (on open) or the background worker (sync). One reused worker thread per process
 * takes one body at a time; a body it has not finished within BODY_TIMEOUT_MS has its worker terminated (a new one
 * starts for the next body) and is stored with no HTML and text from fallbackText, which needs no parser.
 */
export const BODY_TIMEOUT_MS = 3000;

export interface StoredBodies {
  bodyHtml: string | null;
  bodyText: string;
  /** The full processing failed or ran out of time: the text is the plain fallback. */
  fellBack?: true;
}

type Job = { id: number; body: GraphBody; max: number; timeoutMs: number; resolve: (r: StoredBodies) => void };

let worker: Worker | null = null;
let current: (Job & { timer: NodeJS.Timeout }) | null = null;
const queue: Job[] = [];
let nextId = 1;

/** The compiled worker next to this file; under tsx / vitest (the .ts sources) it loads through tsx. */
function startWorker(): Worker {
  const ts = import.meta.url.endsWith('.ts');
  const w = new Worker(new URL(ts ? './bodyWorker.ts' : './bodyWorker.js', import.meta.url), ts ? { execArgv: ['--import', 'tsx'] } : {});
  w.on('message', (msg: { id: number; result?: StoredBodies; error?: string }) => {
    if (!current || msg.id !== current.id) return;
    finish(msg.result ?? fallback(current));
  });
  // A worker that crashes (or is terminated) fails the body it had, and the next body gets a new worker.
  w.on('error', () => drop(w));
  w.on('exit', () => drop(w));
  return w;
}

function drop(w: Worker): void {
  if (worker !== w) return;
  worker = null;
  if (current) finish(fallback(current));
}

const fallback = (job: Pick<Job, 'body' | 'max'>): StoredBodies => ({
  bodyHtml: null, bodyText: fallbackText(job.body.content.slice(0, RAW_MAX), job.max), fellBack: true,
});

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
    finish(fallback(job));
    void w?.terminate();
  }, job.timeoutMs);
  current = { ...job, timer };
  worker.postMessage({ id: job.id, body: job.body, max: job.max });
}

/**
 * What to store for a body (as emailBodies in mail/html.ts): the sanitised HTML and the text derived from it, each at
 * most `max` characters, worked out in the worker thread; plain text needs no parsing and is cut here.
 */
export function processEmailBody(body: GraphBody, max: number, opts: { timeoutMs?: number } = {}): Promise<StoredBodies> {
  if (body.contentType !== 'html') return Promise.resolve({ bodyHtml: null, bodyText: body.content.slice(0, max) });
  return new Promise((resolve) => {
    queue.push({ id: nextId++, body, max, timeoutMs: opts.timeoutMs ?? BODY_TIMEOUT_MS, resolve });
    next();
  });
}

/**
 * The columns to store. A body that fell back keeps '' as its HTML, not null: null means "not read as HTML yet" and
 * would have the reader fetch it from Graph and process it again on every open (the API serves '' as null).
 */
export const storedColumns = (r: StoredBodies) => ({ bodyHtml: r.fellBack ? '' : r.bodyHtml, bodyText: r.bodyText });
