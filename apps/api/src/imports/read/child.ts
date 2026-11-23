/* Child-process entry: receives one file over IPC, reads it with `readImportBuffer` and sends the result back (see isolated.ts). */
import type { ImportExt } from '@dait-crm/shared';
import { readImportBuffer } from './index.js';

type Job = { ext: ImportExt; data: Uint8Array; fileName?: string; busyMs: number; exhaustHeap: boolean };

process.once('message', (job: Job) => {
  // Test seam (readInWorker's busyMs): hold the process like a slow parser would, without yielding.
  if (job.busyMs > 0) {
    const until = Date.now() + job.busyMs;
    while (Date.now() < until) { /* busy */ }
  }
  // Test seam (readInWorker's exhaustHeap): fill the heap like a runaway parser, until V8 gives up.
  if (job.exhaustHeap) {
    const hoard: string[][] = [];
    for (;;) hoard.push(Array.from({ length: 100_000 }, (_, i) => `cell ${i} ${hoard.length}`));
  }
  readImportBuffer(job.ext, Buffer.from(job.data.buffer, job.data.byteOffset, job.data.byteLength), job.fileName).then(
    (result) => process.send!({ ok: true, result }, () => process.exit(0)),
    (e: unknown) => process.send!({ ok: false, message: e instanceof Error ? e.message : String(e) }, () => process.exit(0)),
  );
});
