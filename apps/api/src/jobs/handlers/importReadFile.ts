import type { Job, Prisma } from '@prisma/client';
import type { ImportExt } from '@dait-crm/shared';
import { prisma } from '../../db.js';
import { readImportFile } from '../../imports/storage.js';
import { readInWorker, type ReadInWorkerOptions } from '../../imports/read/isolated.js';
import type { ReadResult } from '../../imports/read/index.js';
import { knownCountries, refreshBatch, stageTable } from '../../imports/stage.js';
import { stageDocument, type ImportDeps } from '../../imports/claude.js';
import type { ImportReadFilePayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** Test seam: the read process's options (timeout, memory, busy time); defaults in isolated.ts. */
export const importReadOptions: ReadInWorkerOptions = {};
/** Test seam: a fake Claude runner and environment for staging documents. */
export const importReadDeps: ImportDeps = {};

/**
 * `import_read_file` (Import leads): reads one stored upload in a child process (timeout, heap ceiling) and records
 * its status (Read / Scan / Failed), meta and failure code. Anything thrown marks the file Failed `unreadable` and
 * fails the job (one attempt only, so its error stays on the job for diagnosis). Results are written only while the
 * file is still Reading, so the job and the sweep never overwrite each other. A spreadsheet that was Read is then
 * staged into rows (`stageTable`), a PDF / Word / text file through Claude or the deterministic reader (`stageDocument`);
 * both first delete the file's existing rows, so reading a file again is harmless.
 */
export async function importReadFileHandler(job: Job, _ctx: JobContext): Promise<void> {
  const { fileId } = job.payload as unknown as ImportReadFilePayload;
  if (!Number.isInteger(fileId)) throw new Error('bad_payload');
  const file = await prisma.importFile.findUnique({ where: { id: fileId } });
  if (!file || file.deletedAt || file.status !== 'Reading') return;
  const write = (data: Prisma.ImportFileUpdateManyMutationInput) =>
    prisma.importFile.updateMany({ where: { id: fileId, status: 'Reading' }, data: { ...data, readAt: new Date() } });
  let result: ReadResult;
  let written: boolean;
  try {
    // With the countries, a document's deterministic reading runs in the read process too (untrusted text, bounded).
    result = await readInWorker(file.ext as ImportExt, await readImportFile(file.storagePath), file.name, {
      knownCountries: await knownCountries(), ...importReadOptions,
    });
    written = (await write({ status: result.status, meta: result.meta as Prisma.InputJsonValue, error: result.error ?? null })).count === 1;
  } catch (e) {
    await write({ status: 'Failed', meta: {}, error: 'unreadable' });
    throw e;
  }
  const extract = result.extract;
  if (!written || result.status !== 'Read' || !extract) return;
  try {
    if (extract.kind === 'table') await stageTable(fileId, extract);
    else await stageDocument(fileId, extract, importReadDeps, result.draft);
  } catch (e) {
    // A file whose rows could not be staged is not half-staged: no rows, Failed, the error kept on the job.
    await prisma.importRow.deleteMany({ where: { fileId } });
    await prisma.importFile.update({ where: { id: fileId }, data: { status: 'Failed', error: 'unreadable' } });
    await refreshBatch(file.batchId, []).catch(() => undefined);
    throw e;
  }
}
