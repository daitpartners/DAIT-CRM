import type { Job, Prisma } from '@prisma/client';
import type { ImportExt } from '@dait-crm/shared';
import { prisma } from '../../db.js';
import { readImportFile } from '../../imports/storage.js';
import { readInWorker } from '../../imports/read/isolated.js';
import type { ImportReadFilePayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** Test seam: the read timeout (default READ_TIMEOUT_MS). */
export const importReadOptions: { timeoutMs?: number } = {};

/**
 * `import_read_file` (Import leads): reads one stored upload in a worker thread (timeout, memory ceiling) and records
 * its status (Read / Scan / Failed), meta and failure code. Anything thrown marks the file Failed `unreadable` and
 * fails the job (one attempt only, so its error stays on the job for diagnosis). Results are written only while the
 * file is still Reading, so the job and the sweep never overwrite each other. Staging the rows after a Read comes in
 * later tasks; staging first deletes the file's existing rows, so reading a file again is harmless.
 */
export async function importReadFileHandler(job: Job, _ctx: JobContext): Promise<void> {
  const { fileId } = job.payload as unknown as ImportReadFilePayload;
  if (!Number.isInteger(fileId)) throw new Error('bad_payload');
  const file = await prisma.importFile.findUnique({ where: { id: fileId } });
  if (!file || file.deletedAt || file.status !== 'Reading') return;
  const write = (data: Prisma.ImportFileUpdateManyMutationInput) =>
    prisma.importFile.updateMany({ where: { id: fileId, status: 'Reading' }, data: { ...data, readAt: new Date() } });
  try {
    const result = await readInWorker(file.ext as ImportExt, await readImportFile(file.storagePath), file.name, importReadOptions);
    await write({ status: result.status, meta: result.meta as Prisma.InputJsonValue, error: result.error ?? null });
  } catch (e) {
    await write({ status: 'Failed', meta: {}, error: 'unreadable' });
    throw e;
  }
}
