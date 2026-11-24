/*
 * Child-process entry: receives one file over IPC, reads it with `readImportBuffer` (a document, given the CRM's
 * countries, also through the deterministic reader: `draftDocument`) and sends the result back (see isolated.ts).
 */
import type { ImportExt } from '@dait-crm/shared';
import { readImportBuffer, type ReadResult } from './index.js';
import { draftDocument } from '../documents.js';

type Job = {
  ext: ImportExt; data: Uint8Array; fileName?: string; known: string[] | null;
  /** Test seams (readInWorker options), honoured only when NODE_ENV is 'test'. */
  busyMs: number; exhaustHeap: boolean; reportEnv: boolean; failWith: string | null;
};

// The parent went away (worker stopped, crashed): nothing will read the answer, so stop.
process.on('disconnect', () => process.exit(1));

const testing = process.env.NODE_ENV === 'test';

process.once('message', (job: Job) => {
  if (testing) {
    if (job.reportEnv) {
      process.send!({ ok: false, message: `env:${JSON.stringify(Object.keys(process.env).sort())}` }, () => process.exit(0));
      return;
    }
    if (job.failWith) {
      process.stderr.write(job.failWith, () => process.exit(3));
      return;
    }
    // Hold the process like a slow parser would, without yielding.
    if (job.busyMs > 0) {
      const until = Date.now() + job.busyMs;
      while (Date.now() < until) { /* busy */ }
    }
    // Fill the heap like a runaway parser, until V8 gives up.
    if (job.exhaustHeap) {
      const hoard: string[][] = [];
      for (;;) hoard.push(Array.from({ length: 100_000 }, (_, i) => `cell ${i} ${hoard.length}`));
    }
  }
  readImportBuffer(job.ext, Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength), job.fileName).then(
    (read) => {
      const result: ReadResult = read.status === 'Read' && read.extract?.kind === 'text' && job.known
        ? { ...read, draft: draftDocument(read.extract, job.known) } : read;
      process.send!({ ok: true, result }, () => process.exit(0));
    },
  ).catch(
    (e: unknown) => process.send!({ ok: false, message: e instanceof Error ? e.message : String(e) }, () => process.exit(0)),
  );
});
