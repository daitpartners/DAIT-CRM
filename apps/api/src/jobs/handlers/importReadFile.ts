import type { Job, Prisma } from '@prisma/client';
import type { ImportExt } from '@dait-crm/shared';
import { prisma } from '../../db.js';
import { readImportFile } from '../../imports/storage.js';
import { READ_FAILURE_TEXT, readImportBuffer } from '../../imports/read/index.js';
import type { ImportReadFilePayload } from '../types.js';
import type { JobContext } from '../runner.js';

/**
 * `import_read_file` (Import leads): reads one stored upload and records its status (Read / Scan / Failed), meta and
 * failure text. Anything thrown marks the file Failed "Could not read this file" and fails the job (one attempt only,
 * so its error stays on the job for diagnosis). Staging the rows after a Read comes in later tasks; staging first
 * deletes the file's existing rows, so reading a file again is harmless.
 */
export async function importReadFileHandler(job: Job, _ctx: JobContext): Promise<void> {
  const { fileId } = job.payload as unknown as ImportReadFilePayload;
  if (!Number.isInteger(fileId)) throw new Error('bad_payload');
  const file = await prisma.importFile.findUnique({ where: { id: fileId } });
  if (!file || file.deletedAt) return;
  try {
    const result = await readImportBuffer(file.ext as ImportExt, await readImportFile(file.storagePath), file.name);
    await prisma.importFile.update({
      where: { id: fileId },
      data: { status: result.status, meta: result.meta as Prisma.InputJsonValue, error: result.error ?? null, readAt: new Date() },
    });
  } catch (e) {
    await prisma.importFile.update({
      where: { id: fileId },
      data: { status: 'Failed', meta: {}, error: READ_FAILURE_TEXT.unreadable, readAt: new Date() },
    });
    throw e;
  }
}
