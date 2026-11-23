/**
 * Import batches (Import leads, step 1): numbering, creation, language / type changes, and file uploads, each stored
 * under the shared storage folder and read by an `import_read_file` job.
 */
import type { ImportBatch, ImportFile, Prisma } from '@prisma/client';
import {
  BATCH_STATUSES, IMPORT_EXTENSIONS, IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES,
  type BatchStatus, type ImportBatchCreate, type ImportBatchUpdate, type ImportExt,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { enqueue, STALE_AFTER_MS } from '../jobs/queue.js';
import { todayIn } from '../leads/dates.js';
import { NotFoundError } from '../validate.js';
import type { AuthUser } from '../plugins/auth.js';
import { removeImportFile, saveImportFile } from './storage.js';

/** A refused batch or file change; the route answers `status` with `{ error: code }`. */
export class ImportError extends Error {
  constructor(
    readonly code:
      | 'batch_locked' | 'too_many_files' | 'file_type' | 'file_size' | 'files_reading' | 'no_rows'
      | 'research_stopped' | 'claude_cap_reached' | 'choice_required' | 'nothing_to_import' | 'cannot_continue' | 'import_running'
      | 'file_deleted',
    readonly status: number,
  ) {
    super(code);
  }
}

/** Serialises batch numbering, so two batches created at once never get the same number. */
const NUMBER_LOCK = 4_042_101;

/**
 * The next free batch number for `day` (YYYY-MM-DD): IMPORT-<day>, then -2, -3 … Numbers already used by a batch or by
 * `leads.import_batch` (batches imported from the command line) are skipped. Call it inside the transaction that
 * inserts the batch: the advisory lock is held until it commits.
 */
export async function nextBatchNumber(tx: Prisma.TransactionClient, day: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NUMBER_LOCK}::bigint)`;
  const base = `IMPORT-${day}`;
  const rows = await tx.$queryRaw<{ number: string }[]>`
    SELECT upper(number) AS number FROM import_batches WHERE upper(number) LIKE ${`${base}%`}
    UNION
    SELECT upper(import_batch) AS number FROM leads WHERE upper(import_batch) LIKE ${`${base}%`}`;
  const used = new Set(rows.map((r) => r.number));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** A new batch, numbered by the creator's local date. */
export async function createBatch(user: AuthUser, body: ImportBatchCreate): Promise<ImportBatch> {
  const day = todayIn(user.timezone);
  return prisma.$transaction(async (tx) => {
    const number = await nextBatchNumber(tx, day);
    return tx.importBatch.create({
      data: { number, language: body.language, leadType: body.leadType, status: 'Uploading', createdById: user.id },
    });
  });
}

/** Statuses from which a batch's language, type and files can no longer change. */
const LOCKED_FROM = BATCH_STATUSES.indexOf('Importing');
export const isLocked = (status: string): boolean => BATCH_STATUSES.indexOf(status as BatchStatus) >= LOCKED_FROM;

export async function updateBatch(id: number, body: ImportBatchUpdate): Promise<ImportBatch> {
  return prisma.$transaction(async (tx) => {
    const [batch] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM import_batches WHERE id = ${id} FOR UPDATE`;
    if (!batch) throw new NotFoundError();
    if (isLocked(batch.status)) throw new ImportError('batch_locked', 409);
    return tx.importBatch.update({
      where: { id },
      data: { ...(body.language ? { language: body.language } : {}), ...(body.leadType ? { leadType: body.leadType } : {}) },
    });
  });
}

/** Files may be added while the batch is still being uploaded or sorted. */
const ACCEPTS_FILES = new Set(['Uploading', 'Sorting']);

/** The extension a file name ends in, lower case ("Expo.PDF" → "pdf"), or null when it is not an import type. */
export function importExt(name: string): ImportExt | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (IMPORT_EXTENSIONS as readonly string[]).includes(ext) ? (ext as ImportExt) : null;
}

/**
 * Adds one uploaded file to a batch: refuses a locked batch (409 `batch_locked`), an 11th file (`too_many_files`), a
 * type not on the list (`file_type`), an empty file or one over 20 MB (`file_size`). The row is created Reading, the
 * bytes are saved and an `import_read_file` job is queued (one attempt: a retry could spend Claude twice).
 */
export async function addFile(user: AuthUser, batchId: number, name: string, data: Buffer): Promise<ImportFile> {
  const fileName = name.trim().slice(0, 255);
  // Set once the bytes are on disk; removed again if anything after that fails (including the commit).
  let saved: string | null = null;
  try {
    return await prisma.$transaction(async (tx) => {
      // Locks the batch row, so two uploads at once cannot both take the tenth place.
      const [batch] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM import_batches WHERE id = ${batchId} FOR UPDATE`;
      if (!batch) throw new NotFoundError();
      if (!ACCEPTS_FILES.has(batch.status)) throw new ImportError('batch_locked', 409);
      if (await tx.importFile.count({ where: { batchId } }) >= IMPORT_MAX_FILES) throw new ImportError('too_many_files', 400);
      const ext = importExt(fileName);
      if (!ext) throw new ImportError('file_type', 400);
      if (data.length === 0 || data.length > IMPORT_MAX_FILE_BYTES) throw new ImportError('file_size', 400);
      const row = await tx.importFile.create({ data: { batchId, name: fileName, ext, size: data.length, storagePath: '', status: 'Reading' } });
      saved = await saveImportFile(batchId, row.id, data);
      await enqueue(tx, 'import_read_file', { fileId: row.id }, { maxAttempts: 1 });
      return tx.importFile.update({ where: { id: row.id }, data: { storagePath: saved } });
      // Uploads queue on the batch lock and each writes up to 20 MB inside it: more than Prisma's 5 s default.
    }, { timeout: 30_000, maxWait: 30_000 });
  } catch (e) {
    if (saved) await removeImportFile(saved).catch(() => undefined);
    throw e;
  }
}

/** A batch's files, in upload order. */
export async function listFiles(batchId: number) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { id: true } });
  if (!batch) throw new NotFoundError();
  return prisma.importFile.findMany({
    where: { batchId }, orderBy: { id: 'asc' },
    select: { id: true, name: true, ext: true, size: true, status: true, meta: true, error: true },
  });
}

/**
 * Files still Reading with no queued or running `import_read_file` job for them for longer than STALE_AFTER_MS were
 * interrupted (worker stopped, host asleep): they become Failed `interrupted` ("Reading was interrupted; upload the file
 * again"). Reads time out after 2 minutes, so a live read is never swept.
 * A running job locked longer than STALE_AFTER_MS counts as lost too. Returns how many were released.
 */
export async function sweepImportFiles(now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
  const reading = await prisma.importFile.findMany({ where: { status: 'Reading', createdAt: { lt: staleBefore } }, select: { id: true } });
  if (reading.length === 0) return 0;
  const jobs = await prisma.job.findMany({
    where: {
      type: 'import_read_file',
      OR: [{ status: 'queued' }, { status: 'running', lockedAt: { gte: staleBefore } }],
    },
    select: { payload: true },
  });
  const alive = new Set(jobs.map((j) => (j.payload as { fileId?: unknown } | null)?.fileId));
  // Still Reading only: a job that finished meanwhile keeps its result.
  const lost = reading.filter((f) => !alive.has(f.id)).map((f) => f.id);
  if (lost.length === 0) return 0;
  const { count } = await prisma.importFile.updateMany({
    where: { id: { in: lost }, status: 'Reading' },
    data: { status: 'Failed', error: 'interrupted', readAt: now },
  });
  return count;
}
