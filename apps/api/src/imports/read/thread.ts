/* Worker-thread entry: reads one file with `readImportBuffer` and posts the result back (see isolated.ts). */
import { parentPort, workerData } from 'node:worker_threads';
import type { ImportExt } from '@dait-crm/shared';
import { readImportBuffer } from './index.js';

const { ext, data, fileName } = workerData as { ext: ImportExt; data: Uint8Array; fileName?: string };

readImportBuffer(ext, Buffer.from(data.buffer, data.byteOffset, data.byteLength), fileName).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (e: unknown) => parentPort!.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) }),
);
