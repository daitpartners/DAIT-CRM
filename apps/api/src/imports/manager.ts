/**
 * Data manager: the list of import batches (filters, search, tiles), one batch's detail, the original file download
 * and the 90-day retention. Batches imported from the command line before Import leads existed have no batch row, so
 * they never appear here.
 */
import { Prisma } from '@prisma/client';
import { IMPORT_RETENTION_DAYS, pageArgs, type ImportBatchListQuery, type ImportCommit } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { startOfDayIn, todayIn } from '../leads/dates.js';
import { NotFoundError } from '../validate.js';
import { ImportError } from './batches.js';
import { importFileStream, removeBatchFiles, removeImportFile, storedFileExists } from './storage.js';
import { canUndo } from './undo.js';

const DAY_MS = 24 * 60 * 60_000;
/** Batch statuses that imported (their counts mean something). */
const IMPORTED = new Set(['Imported', 'Undone', 'Failed']);

export type BatchRow = {
  id: number; number: string; createdAt: Date; by: string | null; language: string;
  files: { first: string; more: number }; rowCount: number;
  importedCount: number | null; newCompanyCount: number | null; skippedCount: number | null;
  research: { done: number; total: number } | 'done' | null;
  status: string; undoneAt: Date | null;
};

export type BatchTilesDm = {
  importedThisMonth: number; importedBatchesThisMonth: number; waitingForReview: number;
  /** Rows waiting or running in Researching batches. */
  stillResearching: number;
  /** Rows skipped as already in the CRM in batches imported this month. */
  duplicatesSkippedThisMonth: number;
};

/** The first day of this month, 00:00, in the viewer's time zone (UTC for an unknown one). */
const monthStart = (timezone: string, now: Date) => startOfDayIn(`${todayIn(timezone, now).slice(0, 8)}01`, timezone);

async function dmTiles(timezone: string, now = new Date()): Promise<BatchTilesDm> {
  const since = monthStart(timezone, now);
  const importedWhere: Prisma.ImportBatchWhereInput = { importedAt: { gte: since }, status: { in: ['Imported', 'Failed'] } };
  const [sum, batches, waiting, researching, duplicates] = await Promise.all([
    prisma.importBatch.aggregate({ where: importedWhere, _sum: { importedCount: true } }),
    prisma.importBatch.count({ where: { ...importedWhere, importedCount: { gt: 0 } } }),
    prisma.importBatch.count({ where: { status: 'Waiting for review' } }),
    prisma.importRow.count({ where: { researchStatus: { in: ['waiting', 'running'] }, batch: { status: 'Researching' } } }),
    prisma.importRow.count({ where: { outcomeCode: 'already_in_crm', batch: { importedAt: { gte: since } } } }),
  ]);
  return {
    importedThisMonth: sum._sum.importedCount ?? 0, importedBatchesThisMonth: batches, waitingForReview: waiting,
    stillResearching: researching, duplicatesSkippedThisMonth: duplicates,
  };
}

const researchOf = (b: { researchTotal: number; researchDone: number }): BatchRow['research'] =>
  b.researchTotal === 0 ? null : b.researchDone >= b.researchTotal ? 'done' : { done: b.researchDone, total: b.researchTotal };

/**
 * The Data manager table, newest first: `total` = batches matching the filters (the pager), `count` = every batch (the
 * tab's count). `q` searches the batch number and the file names. "This month" is the viewer's calendar month.
 */
export async function listBatches(q: ImportBatchListQuery, timezone = 'Europe/London'): Promise<{ items: BatchRow[]; total: number; count: number; tiles: BatchTilesDm }> {
  const where: Prisma.ImportBatchWhereInput = {};
  if (q.language) where.language = q.language;
  if (q.status) where.status = q.status;
  if (q.q) {
    where.OR = [
      { number: { contains: q.q, mode: 'insensitive' } },
      { files: { some: { name: { contains: q.q, mode: 'insensitive' } } } },
    ];
  }
  const [total, count, batches, tiles] = await Promise.all([
    prisma.importBatch.count({ where }),
    prisma.importBatch.count(),
    prisma.importBatch.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(q),
      include: {
        createdBy: { select: { name: true } },
        files: { select: { name: true }, orderBy: { id: 'asc' }, take: 1 },
        _count: { select: { files: true } },
      },
    }),
    dmTiles(timezone),
  ]);
  const items = batches.map((b): BatchRow => {
    const imported = IMPORTED.has(b.status) && b.importedAt !== null;
    return {
      id: b.id, number: b.number, createdAt: b.createdAt, by: b.createdBy?.name ?? null, language: b.language,
      files: { first: b.files[0]?.name ?? '', more: Math.max(0, b._count.files - 1) }, rowCount: b.rowCount,
      importedCount: imported ? b.importedCount : null, newCompanyCount: imported ? b.newCompanyCount : null,
      skippedCount: imported ? b.skippedCount : null, research: researchOf(b), status: b.status, undoneAt: b.undoneAt,
    };
  });
  return { items, total, count, tiles };
}

/** One batch for the Data manager: its fields, the counts per tab, its files (with `deletedAt`), choices and canUndo. */
export async function batchDetail(id: number) {
  const b = await prisma.importBatch.findUnique({
    where: { id },
    include: {
      createdBy: { select: { name: true } }, importedBy: { select: { name: true } }, undoneBy: { select: { name: true } },
      files: {
        orderBy: { id: 'asc' },
        select: { id: true, name: true, ext: true, size: true, status: true, error: true, meta: true, createdAt: true, deletedAt: true },
      },
    },
  });
  if (!b) throw new NotFoundError();
  const byOutcome = await prisma.importRow.groupBy({ by: ['outcome'], where: { batchId: id }, _count: { _all: true } });
  const n = (o: string) => byOutcome.find((g) => g.outcome === o)?._count._all ?? 0;
  return {
    id: b.id, number: b.number, status: b.status, language: b.language, leadType: b.leadType, createdAt: b.createdAt,
    by: b.createdBy?.name ?? null, importedAt: b.importedAt, importedBy: b.importedBy?.name ?? null,
    undoneAt: b.undoneAt, undoneBy: b.undoneBy?.name ?? null, undo: b.undo,
    rowCount: b.rowCount, importedCount: b.importedCount, newCompanyCount: b.newCompanyCount,
    existingCompanyCount: b.existingCompanyCount, skippedCount: b.skippedCount, errorCount: b.errorCount,
    research: researchOf(b), researchEngine: b.researchEngine, importError: b.importError,
    options: b.options as Partial<ImportCommit>,
    counts: { imported: n('Imported'), skipped: n('Skipped'), errors: n('Error') },
    files: b.files.map(({ meta, ...f }) => ({ ...f, rows: (meta as { rows?: number } | null)?.rows ?? null })),
    canUndo: await canUndo(b),
  };
}

/** An original file to download: 404 when unknown, 410 `file_deleted` once retention removed it (or it is gone). */
export async function originalFile(fileId: number): Promise<{ name: string; size: number; stream: NodeJS.ReadableStream }> {
  const file = await prisma.importFile.findUnique({ where: { id: fileId }, select: { name: true, size: true, storagePath: true, deletedAt: true } });
  if (!file) throw new NotFoundError();
  if (file.deletedAt || !file.storagePath || !(await storedFileExists(file.storagePath))) throw new ImportError('file_deleted', 410);
  return { name: file.name, size: file.size, stream: importFileStream(file.storagePath) };
}

/** No `import_commit` job is queued or running for the batch. */
const NO_JOB = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM jobs j WHERE j.type = 'import_commit' AND j.status IN ('queued', 'running') AND j.payload->>'batchId' = b.id::text)`;

/** A batch never imported, idle since `before` (nothing changed on it, no file uploaded since). */
const idleNeverImported = (before: Date) => Prisma.sql`
  b.status IN ('Uploading', 'Sorting', 'Waiting for review', 'Researching', 'Failed')
  AND b.imported_at IS NULL
  AND b.updated_at < ${before}
  AND ${NO_JOB}
  AND NOT EXISTS (SELECT 1 FROM import_rows r WHERE r.batch_id = b.id AND (r.lead_id IS NOT NULL OR r.outcome = 'Imported'))
  AND NOT EXISTS (SELECT 1 FROM import_files f WHERE f.batch_id = b.id AND f.created_at >= ${before})`;

/** A batch whose originals may go: Imported or Undone (or Failed with no job left), untouched since `before`. */
const doneSince = (before: Date) => Prisma.sql`
  (b.status IN ('Imported', 'Undone') OR (b.status = 'Failed' AND ${NO_JOB}))
  AND b.updated_at < ${before}`;

/**
 * Retention (hourly, with the job cleanup), each batch re-checked under its row lock just before anything is deleted:
 * - a batch never imported (not Imported or Undone, nothing imported, no import job) untouched for 90 days is deleted
 *   with its rows, then its folder;
 * - the originals of a batch that is done (Imported or Undone, or Failed with no job left) and untouched for 90 days are
 *   removed from disk and marked deleted (the batch and its rows stay as the record). A batch still in use keeps them.
 */
export async function pruneImports(now = new Date()): Promise<{ files: number; batches: number }> {
  const before = new Date(now.getTime() - IMPORT_RETENTION_DAYS * DAY_MS);
  const idle = await prisma.$queryRaw<{ id: number }[]>`SELECT b.id FROM import_batches b WHERE ${idleNeverImported(before)}`;
  let batches = 0;
  for (const { id } of idle) {
    const deleted = await prisma.$transaction(async (tx) => {
      const [still] = await tx.$queryRaw<{ id: number }[]>`
        SELECT b.id FROM import_batches b WHERE b.id = ${id} AND ${idleNeverImported(before)} FOR UPDATE OF b`;
      if (!still) return false;
      await tx.importBatch.delete({ where: { id } });
      return true;
    });
    if (!deleted) continue;
    batches += 1;
    await removeBatchFiles(id);
  }
  const done = await prisma.$queryRaw<{ id: number }[]>`
    SELECT DISTINCT b.id FROM import_batches b JOIN import_files f ON f.batch_id = b.id
    WHERE f.deleted_at IS NULL AND f.created_at < ${before} AND ${doneSince(before)}`;
  let files = 0;
  for (const { id } of done) {
    files += await prisma.$transaction(async (tx) => {
      const [still] = await tx.$queryRaw<{ id: number }[]>`
        SELECT b.id FROM import_batches b WHERE b.id = ${id} AND ${doneSince(before)} FOR UPDATE OF b`;
      if (!still) return 0;
      const old = await tx.importFile.findMany({
        where: { batchId: id, deletedAt: null, createdAt: { lt: before } }, select: { id: true, storagePath: true },
      });
      for (const f of old) if (f.storagePath) await removeImportFile(f.storagePath);
      const { count } = await tx.importFile.updateMany({ where: { id: { in: old.map((f) => f.id) } }, data: { deletedAt: now } });
      return count;
    });
  }
  return { files, batches };
}
