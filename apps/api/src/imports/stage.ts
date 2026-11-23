/**
 * Import leads, step 2 ("Sort the data"): a read spreadsheet becomes staged rows in the lead fields, each with a
 * status decided on its own values (research values never change it), its problems in plain words, and the CRM
 * company it already is. Rows can be edited and ticked; an unsure column is asked about and, once answered, the
 * file's rows are re-sorted from their cells, keeping every cell a person edited.
 */
import { Prisma } from '@prisma/client';
import {
  IMPORT_MAX_ROWS, domainOf, pageArgs,
  type ColumnQuestion, type FileMeta, type ImportColumnAnswer, type ImportField, type ImportIncludeAll,
  type ImportRowUpdate, type ImportRowsQuery, type ResearchValue, type RowFields, type RowFilter, type RowProblem,
  type RowStatus,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { NotFoundError } from '../validate.js';
import { ImportError, isLocked } from './batches.js';
import { classifyColumns, columnName, findHeaderRow, looksLikeEmail, looksLikeWebsite, squash, type ColumnTarget } from './columns.js';
import { findExistingCompanies, type CompanyRef, type Db } from './companies.js';
import { matchCountry } from './countries.js';
import type { TableExtract } from './read/index.js';

/** Longest value a staged cell keeps (the row edit's limit). */
const MAX_VALUE = 500;
/** Rows written per statement. */
const CHUNK = 1000;

/** The CRM's country list (active `country` lookup values). */
export async function knownCountries(): Promise<string[]> {
  const rows = await prisma.lookupValue.findMany({ where: { group: 'country', isActive: true }, select: { value: true }, orderBy: { sortOrder: 'asc' } });
  return rows.map((r) => r.value);
}

/**
 * `ImportFile.columnMap` key of a column: sheet, unit separator (U+001F), column index. Not U+0000: PostgreSQL jsonb
 * cannot hold it. The index is read after the last separator, so a sheet name containing one still works.
 */
export const COLUMN_KEY_SEP = '\u001f';
export const columnKey = (sheet: string, col: number): string => `${sheet}${COLUMN_KEY_SEP}${col}`;

const has = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';
const isBlankCells = (cells: string[]) => cells.every((c) => (c ?? '').trim() === '');

/** One row's cells into fields: first and last names make the contact when there is none, notes join, else the first filled column wins. */
export function buildFields(cells: string[], targets: readonly (ColumnTarget | null | undefined)[]): RowFields {
  const fields: RowFields = {};
  const first: string[] = [];
  const last: string[] = [];
  const notes: string[] = [];
  targets.forEach((target, col) => {
    const value = (cells[col] ?? '').trim().slice(0, MAX_VALUE);
    if (!target || target === 'ignore' || value === '') return;
    if (target === 'firstName') first.push(value);
    else if (target === 'lastName') last.push(value);
    else if (target === 'notes') notes.push(value);
    else if (fields[target] === undefined) fields[target] = value;
  });
  if (fields.contactName === undefined && first.length + last.length > 0) fields.contactName = [...first, ...last].join(' ').slice(0, MAX_VALUE);
  if (notes.length > 0) fields.notes = notes.join('; ').slice(0, MAX_VALUE);
  return fields;
}

/** "Total", "Totals", "Subtotal", "Grand total", "Total général", "Suma" at the start of the company cell; group 2 is the rest. */
const TOTAL_RE = /^(grand ?total|sub-? ?total|total general|totals?|suma)(?![a-z0-9])(.*)$/;
const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** A summary line: a total word that is the whole cell or is followed by ":" or a number ("Total: 45", "TOTAL VISITORS DAY 2"). */
function isTotalLine(company: string): boolean {
  const m = TOTAL_RE.exec(plain(company));
  if (!m) return false;
  const rest = m[2]!.trim();
  return rest === '' || rest.startsWith(':') || /\d/.test(rest);
}

/** Longest header cell kept (and compared) for a sheet. */
export const MAX_HEADER_CELL = 200;
/** Longest raw cell kept on a staged row. */
export const MAX_RAW_CELL = 2000;

function sameCells(a: string[], b: string[]): boolean {
  const norm = (cells: string[]) => {
    const out = cells.map((c) => squash((c ?? '').slice(0, MAX_HEADER_CELL)));
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  };
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && x.length === y.length && x.every((c, i) => c === y[i]);
}

/**
 * Not a lead (ruling 7): a blank line, the header row repeated, a summary line (a total word as the whole company cell
 * or followed by ":" or a number, on a row with no email and no website: "Total Care Ltd" and "Suma Seguros" are
 * companies), or a row with no company, email, phone or website.
 */
export function isNotALead(fields: RowFields, cells: string[], headerCells: string[] | null): boolean {
  if (isBlankCells(cells) && Object.values(fields).every((v) => !has(v))) return true;
  if (headerCells && sameCells(cells, headerCells)) return true;
  if (has(fields.companyName) && !has(fields.email) && !has(fields.website) && isTotalLine(fields.companyName)) return true;
  return !has(fields.companyName) && !has(fields.email) && !has(fields.phone) && !has(fields.website);
}

/** The fields with the country in the CRM's spelling when it matches one of the list. */
function withCountry(fields: RowFields, known: readonly string[]): RowFields {
  const country = has(fields.country) ? matchCountry(fields.country, known) : null;
  return country ? { ...fields, country } : { ...fields };
}

/** The tick a row gets until a person changes it: Already in CRM and Not a lead start unticked. */
export const defaultInclude = (status: RowStatus): boolean => status === 'Ready' || status === 'Missing details';

/**
 * A row's status and problems, on its own values only. Not a lead → Already in CRM → Ready (company + a country,
 * known or not + a valid email) → Missing details. The country comes back as the CRM's spelling when it matches one.
 */
export function evaluateRow(
  fields: RowFields,
  ctx: { knownCountries: readonly string[]; match: CompanyRef | null; notALead: boolean },
): { status: RowStatus; problems: RowProblem[]; fields: RowFields } {
  const out = withCountry(fields, ctx.knownCountries);
  const country = has(out.country) ? matchCountry(out.country, ctx.knownCountries) : null;
  if (ctx.notALead) return { status: 'Not a lead', problems: [{ code: 'not_a_lead', level: 'info' }], fields: out };
  if (ctx.match) return { status: 'Already in CRM', problems: [{ code: 'already_in_crm', level: 'info', value: ctx.match.number }], fields: out };
  const problems: RowProblem[] = [];
  if (!has(out.companyName)) problems.push({ code: 'company_missing', field: 'companyName', level: 'missing' });
  if (!has(out.country)) problems.push({ code: 'country_missing', field: 'country', level: 'missing' });
  else if (!country) problems.push({ code: 'country_unknown', field: 'country', level: 'questionable', value: out.country.trim() });
  const email = has(out.email) ? out.email.trim() : '';
  const validEmail = email !== '' && looksLikeEmail(email);
  if (email && !validEmail) problems.push({ code: 'email_invalid', field: 'email', level: 'questionable', value: email });
  if (!email) {
    if (has(out.phone)) problems.push({ code: 'email_missing', field: 'email', level: 'missing' });
    else {
      problems.push({ code: 'contact_missing', field: 'email', level: 'missing' });
      problems.push({ code: 'contact_missing', field: 'phone', level: 'missing' });
    }
  }
  if (has(out.website) && (!looksLikeWebsite(out.website) || !domainOf(out.website))) {
    problems.push({ code: 'website_invalid', field: 'website', level: 'questionable', value: out.website.trim() });
  }
  const ready = has(out.companyName) && has(out.country) && validEmail;
  return { status: ready ? 'Ready' : 'Missing details', problems, fields: out };
}

type StagedRow = { sheet: string; originN: number; raw: string[]; fields: RowFields };

/**
 * Stages a read spreadsheet: per sheet the header row, the column guesses (stored as the file's column map) and the
 * questions, then one row per data row (trailing blank rows dropped). Replaces the file's earlier rows, so reading a
 * file again is harmless. Refused (file Failed `too_many_rows`, no rows) when the batch would pass 5,000 rows.
 */
export async function stageTable(fileId: number, extract: TableExtract): Promise<void> {
  const file = await prisma.importFile.findUnique({ where: { id: fileId } });
  if (!file) return;
  const known = await knownCountries();
  const columnMap: Record<string, ColumnTarget> = {};
  const questions: ColumnQuestion[] = [];
  const headers: Record<string, string[] | null> = {};
  const staged: StagedRow[] = [];
  for (const { name, rows: cellsRead } of extract.sheets) {
    // jsonb cannot hold U+0000 (a stray NUL in a CSV or an old .xls).
    const sheet = { name: name.replace(/\u0000/g, '').slice(0, 100) };
    const rows = cellsRead.map((r) => r.map((c) => (c ?? '').replace(/\u0000/g, '').trim().slice(0, MAX_RAW_CELL)));
    let end = rows.length;
    while (end > 0 && isBlankCells(rows[end - 1]!)) end -= 1;
    const h = findHeaderRow(rows.slice(0, end), known);
    const headerCells = h >= 0 ? rows[h]!.map((c) => c.slice(0, MAX_HEADER_CELL)) : null;
    let start = h + 1;
    while (start < end && isBlankCells(rows[start]!)) start += 1;
    const data = rows.slice(start, end);
    const width = Math.max(headerCells?.length ?? 0, ...data.map((r) => r.length), 0);
    // Repeated header rows and blank lines say nothing about a column's values.
    const sample = data.filter((r) => !isBlankCells(r) && !(headerCells && sameCells(r, headerCells)));
    const columns = Array.from({ length: width }, (_, c) => sample.map((r) => r[c] ?? ''));
    const headerTexts = Array.from({ length: width }, (_, c) => headerCells?.[c]?.trim() || columnName(c));
    const { map, questions: asked } = classifyColumns(headerTexts, columns, known);
    map.forEach((target, col) => {
      if (target) columnMap[columnKey(sheet.name, col)] = target;
    });
    questions.push(...asked.map((q) => ({ sheet: sheet.name, ...q })));
    headers[sheet.name] = headerCells;
    data.forEach((cells, i) => staged.push({ sheet: sheet.name, originN: start + i + 1, raw: cells, fields: buildFields(cells, map) }));
  }

  const refused = await prisma.$transaction(async (tx) => {
    // One staging per batch at a time, so two files cannot both fit under the row limit.
    await tx.$queryRaw`SELECT id FROM import_batches WHERE id = ${file.batchId} FOR UPDATE`;
    await tx.importRow.deleteMany({ where: { fileId } });
    const others = await tx.importRow.count({ where: { batchId: file.batchId } });
    if (others + staged.length > IMPORT_MAX_ROWS) {
      await tx.importFile.update({ where: { id: fileId }, data: { status: 'Failed', error: 'too_many_rows', columnMap: {}, questions: [] } });
      return true;
    }
    const { _max } = await tx.importRow.aggregate({ where: { batchId: file.batchId }, _max: { position: true } });
    const base = (_max.position ?? 0) + 1;
    for (let i = 0; i < staged.length; i += CHUNK) {
      await tx.importRow.createMany({
        data: staged.slice(i, i + CHUNK).map((r, j) => ({
          batchId: file.batchId, fileId, position: base + i + j, sheet: r.sheet, originKind: 'row', originN: r.originN,
          raw: r.raw, fields: r.fields as Prisma.InputJsonValue, status: 'Missing details', include: false,
        })),
      });
    }
    const meta: FileMeta = { ...(file.meta as FileMeta), rows: staged.length, headers };
    await tx.importFile.update({
      where: { id: fileId },
      data: { columnMap, questions: questions as unknown as Prisma.InputJsonValue, meta: meta as Prisma.InputJsonValue },
    });
    return false;
  }, { timeout: 120_000, maxWait: 30_000 });

  if (refused) {
    await refreshBatch(file.batchId, []);
    return;
  }
  const ids = await prisma.importRow.findMany({ where: { fileId }, select: { id: true } });
  await refreshBatch(file.batchId, ids.map((r) => r.id));
}

type RowUpdate = {
  id: number; status: string; include: boolean; problems: RowProblem[]; fields: RowFields; prev: RowFields; matched: number | null;
};

/** Test seams: run just before a re-evaluation or a re-sort writes (to interleave a person's edit). */
export const stageHooks: { beforeEvaluationWrite?: () => Promise<void>; beforeResortWrite?: () => Promise<void> } = {};

/**
 * Writes re-evaluated rows. Nothing a person did meanwhile is lost: a row whose fields changed since they were read is
 * skipped (the edit's own re-evaluation covers it), and the tick is only written while no person has set it.
 */
async function writeEvaluations(updates: RowUpdate[]): Promise<void> {
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = JSON.stringify(updates.slice(i, i + CHUNK));
    await prisma.$executeRaw`
      UPDATE import_rows AS r
      SET status = v.status, problems = v.problems, fields = v.fields, matched_company_id = v.matched,
          include = CASE WHEN r.include_touched THEN r.include ELSE v.include END
      FROM jsonb_to_recordset(${chunk}::jsonb)
        AS v(id int, status text, include boolean, problems jsonb, fields jsonb, prev jsonb, matched int)
      WHERE r.id = v.id AND r.fields = v.prev`;
  }
}

/**
 * Writes re-sorted fields; the fields a person edited keep their current value (or stay empty), read at write time,
 * so an edit made while the file was being re-sorted wins.
 */
async function writeFields(db: Db, updates: { id: number; fields: RowFields }[]): Promise<void> {
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = JSON.stringify(updates.slice(i, i + CHUNK));
    await db.$executeRaw`
      UPDATE import_rows AS r
      SET fields = (v.fields - ARRAY(SELECT jsonb_array_elements_text(r.edited)))
        || COALESCE((SELECT jsonb_object_agg(k, r.fields -> k) FROM jsonb_array_elements_text(r.edited) AS k WHERE r.fields ? k), '{}'::jsonb)
      FROM jsonb_to_recordset(${chunk}::jsonb) AS v(id int, fields jsonb)
      WHERE r.id = v.id`;
  }
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Re-evaluates rows (all of the batch, or `rowIds`): country spelling, Not a lead, the CRM company, status and problems.
 * A tick a person set is kept; otherwise it follows the new status. Rows already imported are left alone. Updates the
 * batch's row count.
 */
export async function refreshBatch(batchId: number, rowIds?: number[]): Promise<void> {
  if (!rowIds || rowIds.length > 0) {
    const rows = await prisma.importRow.findMany({
      where: { batchId, outcome: null, ...(rowIds ? { id: { in: rowIds } } : {}) },
      select: { id: true, fileId: true, sheet: true, raw: true, fields: true, status: true, include: true, includeTouched: true, matchedCompanyId: true, problems: true },
      orderBy: { id: 'asc' },
    });
    const files = await prisma.importFile.findMany({ where: { batchId }, select: { id: true, meta: true } });
    const headersOf = new Map(files.map((f) => [f.id, (f.meta as FileMeta).headers ?? {}]));
    const known = await knownCountries();
    const notLead = rows.map((r) => isNotALead(r.fields as RowFields, r.raw as string[], headersOf.get(r.fileId)?.[r.sheet ?? ''] ?? null));
    const lookup = rows.map((r) => withCountry(r.fields as RowFields, known));
    const toMatch = rows.map((_, i) => i).filter((i) => !notLead[i]);
    const found = await findExistingCompanies(prisma, toMatch.map((i) => lookup[i]!));
    const matchOf = new Map(toMatch.map((i, k) => [i, found[k] ?? null]));
    const updates: RowUpdate[] = [];
    rows.forEach((r, i) => {
      const match = matchOf.get(i) ?? null;
      const e = evaluateRow(r.fields as RowFields, { knownCountries: known, match, notALead: notLead[i]! });
      const include = r.includeTouched ? r.include : defaultInclude(e.status);
      const next: RowUpdate = {
        id: r.id, status: e.status, include, problems: e.problems, fields: e.fields, prev: r.fields as RowFields, matched: match?.id ?? null,
      };
      const same = r.status === next.status && r.include === next.include && r.matchedCompanyId === next.matched
        && json(r.problems) === json(next.problems) && json(r.fields) === json(next.fields);
      if (!same) updates.push(next);
    });
    await stageHooks.beforeEvaluationWrite?.();
    await writeEvaluations(updates);
  }
  const rowCount = await prisma.importRow.count({ where: { batchId } });
  await prisma.importBatch.update({ where: { id: batchId }, data: { rowCount } });
}

/** Column targets of each sheet of a file, from its stored column map. */
function targetsBySheet(columnMap: Record<string, string>): Map<string, ColumnTarget[]> {
  const out = new Map<string, ColumnTarget[]>();
  for (const [key, target] of Object.entries(columnMap)) {
    const at = key.lastIndexOf(COLUMN_KEY_SEP);
    const sheet = key.slice(0, at);
    const col = Number(key.slice(at + 1));
    if (!Number.isInteger(col) || col < 0) continue;
    const list = out.get(sheet) ?? [];
    list[col] = target as ColumnTarget;
    out.set(sheet, list);
  }
  return out;
}

/** Rebuilds a file's fields from its cells with `columnMap` (edited fields keep their value, at write time); returns the row ids. */
async function resortFields(db: Db, fileId: number, columnMap: Record<string, string>): Promise<{ id: number; sheet: string | null; raw: string[] }[]> {
  const targets = targetsBySheet(columnMap);
  const rows = await db.importRow.findMany({ where: { fileId, outcome: null }, select: { id: true, sheet: true, raw: true }, orderBy: { id: 'asc' } });
  const updates = rows.map((r) => ({ id: r.id, fields: buildFields(r.raw as string[], targets.get(r.sheet ?? '') ?? []) }));
  await stageHooks.beforeResortWrite?.();
  await writeFields(db, updates);
  return rows.map((r) => ({ id: r.id, sheet: r.sheet, raw: r.raw as string[] }));
}

/** Re-sorts a file's rows from their cells with its column map, keeping the fields a person edited; then re-evaluates them. */
export async function resortFile(fileId: number): Promise<void> {
  const file = await prisma.importFile.findUnique({ where: { id: fileId }, select: { batchId: true, columnMap: true } });
  if (!file) throw new NotFoundError();
  const rows = await resortFields(prisma, fileId, file.columnMap as Record<string, string>);
  await refreshBatch(file.batchId, rows.map((r) => r.id));
}

/**
 * Runs a staged-row change while holding the batch row (`FOR UPDATE`) and only if the batch is not Importing or later,
 * checked under that lock. Whatever moves the batch to Importing must take the same lock, so no edit lands after an
 * import has started.
 */
async function underBatchLock<T>(batchId: number, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const [batch] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM import_batches WHERE id = ${batchId} FOR UPDATE`;
    if (!batch) throw new NotFoundError();
    if (isLocked(batch.status)) throw new ImportError('batch_locked', 409);
    return fn(tx);
  });
}

async function batchForEdit(batchId: number) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { id: true, status: true } });
  if (!batch) throw new NotFoundError();
  if (isLocked(batch.status)) throw new ImportError('batch_locked', 409);
  return batch;
}

/**
 * Answers an unsure column: the field it holds (or "skip", stored as ignore); the file's rows are re-sorted. Runs under
 * the batch lock, so two answers never lose each other. A field another column of the sheet already holds (one nobody
 * has answered yet) raises a question about that other column, so a person decides which one it is.
 */
export async function answerColumn(fileId: number, body: ImportColumnAnswer): Promise<{ done: string }> {
  const { batchId, ids } = await prisma.$transaction(async (tx) => {
    const file = await tx.importFile.findUnique({ where: { id: fileId }, select: { batchId: true } });
    if (!file) throw new NotFoundError();
    const [batch] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM import_batches WHERE id = ${file.batchId} FOR UPDATE`;
    if (!batch) throw new NotFoundError();
    if (isLocked(batch.status)) throw new ImportError('batch_locked', 409);
    const current = await tx.importFile.findUniqueOrThrow({ where: { id: fileId }, select: { columnMap: true, questions: true, meta: true } });
    let questions = current.questions as ColumnQuestion[];
    const asked = questions.find((q) => q.sheet === body.sheet && q.col === body.col);
    if (!asked) throw new NotFoundError();
    const key = columnKey(body.sheet, body.col);
    const target = body.field === 'skip' ? 'ignore' : body.field;
    const columnMap = { ...(current.columnMap as Record<string, string>), [key]: target };
    const meta = current.meta as FileMeta;
    const answered = [...new Set([...(meta.answered ?? []), key])];
    questions = questions.filter((q) => !(q.sheet === body.sheet && q.col === body.col));
    const rows = await resortFields(tx, fileId, columnMap);
    // Confirming the guess (e.g. a second "Phone" column is a phone too) accepts the duplicate as it was: no follow-up.
    if (target !== 'ignore' && target !== 'notes' && target !== asked.guess) {
      for (const [otherKey, otherTarget] of Object.entries(columnMap)) {
        const at = otherKey.lastIndexOf(COLUMN_KEY_SEP);
        const sheet = otherKey.slice(0, at);
        const col = Number(otherKey.slice(at + 1));
        if (otherKey === key || otherTarget !== target || sheet !== body.sheet || answered.includes(otherKey)) continue;
        if (questions.some((q) => q.sheet === sheet && q.col === col)) continue;
        const headerCells = meta.headers?.[sheet] ?? null;
        const samples = rows
          .filter((r) => r.sheet === sheet && !(headerCells && sameCells(r.raw, headerCells)))
          .map((r) => (r.raw[col] ?? '').trim()).filter((v) => v !== '').slice(0, 3);
        const header = headerCells?.[col]?.trim() || columnName(col);
        questions.push({ sheet, col, header, guess: target, samples });
      }
    }
    await tx.importFile.update({
      where: { id: fileId },
      data: {
        columnMap, questions: questions as unknown as Prisma.InputJsonValue,
        meta: { ...meta, answered } as Prisma.InputJsonValue,
      },
    });
    return { batchId: file.batchId, ids: rows.map((r) => r.id) };
  }, { timeout: 120_000, maxWait: 30_000 });
  await refreshBatch(batchId, ids);
  return { done: body.field };
}

export type RowView = {
  id: number; fields: RowFields; status: string; include: boolean; problems: RowProblem[];
  matched: CompanyRef | null; from: string; fileName: string;
  research?: Record<string, ResearchValue>; researchStatus?: string;
};

const ORIGIN_LABEL: Record<string, (n: number) => string> = {
  row: (n) => `row ${n}`, page: (n) => `p.${n}`, card: (n) => `card ${n}`, line: (n) => `line ${n}`,
};

/** "Expo xlsx · row 14": the first word of the file name, its type, and where in it the row was. */
export function fromLabel(fileName: string, ext: string, originKind: string, originN: number): string {
  const word = fileName.replace(/\.[^.]*$/, '').split(/[^\p{L}\p{N}]+/u).find((w) => w !== '') ?? fileName;
  return `${word} ${ext} · ${(ORIGIN_LABEL[originKind] ?? ORIGIN_LABEL.row!)(originN)}`;
}

const rowSelect = {
  id: true, fields: true, status: true, include: true, problems: true, originKind: true, originN: true,
  research: true, researchStatus: true,
  matchedCompany: { select: { id: true, number: true } },
  file: { select: { name: true, ext: true } },
} satisfies Prisma.ImportRowSelect;

function rowView(r: Prisma.ImportRowGetPayload<{ select: typeof rowSelect }>): RowView {
  const research = r.research as Record<string, ResearchValue>;
  return {
    id: r.id, fields: r.fields as RowFields, status: r.status, include: r.include, problems: r.problems as RowProblem[],
    matched: r.matchedCompany ? { id: r.matchedCompany.id, number: r.matchedCompany.number } : null,
    from: fromLabel(r.file.name, r.file.ext, r.originKind, r.originN), fileName: r.file.name,
    ...(research && Object.keys(research).length > 0 ? { research } : {}),
    ...(r.researchStatus ? { researchStatus: r.researchStatus } : {}),
  };
}

/**
 * Applies a person's cell edit and / or tick in one statement, so two quick edits of one row never lose each other
 * (an empty value clears the field; either way the field is then kept on re-sorts).
 */
export async function applyRowEdit(rowId: number, body: ImportRowUpdate, db: Db = prisma): Promise<void> {
  const field = body.field ?? null;
  const value = body.value ?? null;
  const include = body.include ?? null;
  await db.$executeRaw`
    UPDATE import_rows SET
      fields = CASE
        WHEN ${field}::text IS NULL THEN fields
        WHEN ${value}::text = '' THEN fields - ${field}::text
        ELSE fields || jsonb_build_object(${field}::text, ${value}::text) END,
      edited = CASE WHEN ${field}::text IS NULL OR edited ? ${field}::text THEN edited ELSE edited || to_jsonb(${field}::text) END,
      include = COALESCE(${include}::boolean, include),
      include_touched = include_touched OR ${include}::boolean IS NOT NULL
    WHERE id = ${rowId}`;
}

/** Edits one cell and / or the row's tick; returns the re-evaluated row. */
export async function updateRow(rowId: number, body: ImportRowUpdate): Promise<RowView> {
  const row = await prisma.importRow.findUnique({ where: { id: rowId }, select: { id: true, batchId: true } });
  if (!row) throw new NotFoundError();
  await underBatchLock(row.batchId, (tx) => applyRowEdit(rowId, body, tx));
  await refreshBatch(row.batchId, [rowId]);
  return rowView(await prisma.importRow.findUniqueOrThrow({ where: { id: rowId }, select: rowSelect }));
}

const FILTER_STATUS: Record<RowFilter, RowStatus | null> = { all: null, missing: 'Missing details', already: 'Already in CRM', notlead: 'Not a lead' };
const FILTER_OUTCOME: Record<string, string> = { imported: 'Imported', skipped: 'Skipped', errors: 'Error' };

/** "Include all" / "Leave out all" for the rows a filter shows; returns how many ticks changed. */
export async function includeAll(batchId: number, body: ImportIncludeAll): Promise<{ changed: number }> {
  const status = FILTER_STATUS[body.filter];
  const { count } = await underBatchLock(batchId, (tx) => tx.importRow.updateMany({
    where: { batchId, outcome: null, include: !body.include, ...(status ? { status } : {}) },
    data: { include: body.include, includeTouched: true },
  }));
  return { changed: count };
}

export type BatchTiles = { rows: number; files: number; ready: number; missing: number; already: number; notLead: number };

export async function batchTiles(batchId: number): Promise<BatchTiles> {
  const [byStatus, files] = await Promise.all([
    prisma.importRow.groupBy({ by: ['status'], where: { batchId }, _count: { _all: true } }),
    prisma.importRow.groupBy({ by: ['fileId'], where: { batchId } }),
  ]);
  const n = (s: RowStatus) => byStatus.find((g) => g.status === s)?._count._all ?? 0;
  return {
    rows: byStatus.reduce((t, g) => t + g._count._all, 0), files: files.length,
    ready: n('Ready'), missing: n('Missing details'), already: n('Already in CRM'), notLead: n('Not a lead'),
  };
}

/** The step-2 table: a page of rows (100 at most), the tiles and the first open column question. */
export async function listRows(batchId: number, q: ImportRowsQuery): Promise<{
  items: RowView[]; total: number; tiles: BatchTiles; question: (ColumnQuestion & { fileId: number; fileName: string }) | null;
}> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { id: true } });
  if (!batch) throw new NotFoundError();
  const where: Prisma.ImportRowWhereInput = { batchId };
  if (q.filter in FILTER_OUTCOME) where.outcome = FILTER_OUTCOME[q.filter];
  else if (FILTER_STATUS[q.filter as RowFilter]) where.status = FILTER_STATUS[q.filter as RowFilter]!;
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const hits = await prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM import_rows
      WHERE batch_id = ${batchId} AND EXISTS (SELECT 1 FROM jsonb_each_text(fields) AS e WHERE e.value ILIKE ${like})`;
    where.id = { in: hits.map((h) => h.id) };
  }
  const [total, rows, tiles, files] = await Promise.all([
    prisma.importRow.count({ where }),
    prisma.importRow.findMany({ where, select: rowSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }], ...pageArgs(q) }),
    batchTiles(batchId),
    prisma.importFile.findMany({ where: { batchId, deletedAt: null }, select: { id: true, name: true, questions: true }, orderBy: { id: 'asc' } }),
  ]);
  const withQuestion = files.find((f) => (f.questions as ColumnQuestion[]).length > 0);
  const question = withQuestion
    ? { ...(withQuestion.questions as ColumnQuestion[])[0]!, fileId: withQuestion.id, fileName: withQuestion.name }
    : null;
  return { items: rows.map(rowView), total, tiles, question };
}

/** Step 1 → step 2: refused while a file is still being read (409 `files_reading`) or when nothing was staged (400 `no_rows`). */
export async function sortBatch(batchId: number) {
  return prisma.$transaction(async (tx) => {
    const [batch] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM import_batches WHERE id = ${batchId} FOR UPDATE`;
    if (!batch) throw new NotFoundError();
    if (isLocked(batch.status)) throw new ImportError('batch_locked', 409);
    if (await tx.importFile.count({ where: { batchId, status: 'Reading' } }) > 0) throw new ImportError('files_reading', 409);
    if (await tx.importRow.count({ where: { batchId } }) === 0) throw new ImportError('no_rows', 400);
    if (batch.status === 'Uploading') return tx.importBatch.update({ where: { id: batchId }, data: { status: 'Sorting' } });
    return tx.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  });
}

/** Re-runs country and company matching for the whole batch (after countries were added, or companies created). */
export async function rematchBatch(batchId: number): Promise<BatchTiles> {
  await batchForEdit(batchId);
  await refreshBatch(batchId);
  return batchTiles(batchId);
}
