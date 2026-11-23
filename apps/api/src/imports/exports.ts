/**
 * Import leads downloads: the "rows to fix" Excel (every row that will not import, or imported still missing details,
 * with the problem cells coloured and "What to fix" in plain words; it uploads again through step 1, where "What to fix"
 * and "From" are ignored), the CSV of every row, and the original file's download headers. Every value written goes
 * through `safeCell`, so nothing a file brought in can run as a formula in Excel; websites are plain text, never links.
 */
import ExcelJS from 'exceljs';
import {
  IMPORT_TABLE_FIELDS, importColumnLabel, problemText,
  type ImportColumnKey, type ImportCommit, type ImportField, type Lang, type ProblemCode, type RowFields, type RowProblem,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { NotFoundError } from '../validate.js';
import { effectiveFields, planBatch } from './plan.js';
import { evaluateRow, fromLabel, knownCountries } from './stage.js';

/** A cell that would start a formula: = + - @, tab or CR, and their full-width forms (Excel reads those too). */
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
/** A phone number such as "+971 4 555 0192": written as it is (a string cell, so it cannot evaluate either). */
const PHONE = /^\+?[\d\s().-]{7,}$/;

/** A value made safe for a spreadsheet cell: a leading `'` when it would start a formula (a phone number excepted). */
export function safeCell(v: string): string {
  return FORMULA_START.test(v) && !PHONE.test(v) ? `'${v}` : v;
}

export type FixRow = { fields: RowFields; from: string; problems: RowProblem[] };
export type FixOptions = { acceptHigh: boolean; noContactRows: 'import' | 'leave' | null };

/** Batch statuses from which a row's outcome (Imported, Skipped, Error) decides it, rather than the plan. */
const AFTER_IMPORT = new Set(['Importing', 'Imported', 'Undone', 'Failed']);

/**
 * The rows to fix, in position order. Before the import: the rows the plan (with these choices) leaves out, plus the
 * rows it imports that are still Missing details on their effective values. After the import (the batch's own
 * choices): rows Skipped or Error, plus imported rows still Missing details. Problems are the row's problems on its
 * effective values, plus why it was left out (once per code).
 */
export async function fixRows(batchId: number, opts?: FixOptions): Promise<FixRow[]> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { status: true, options: true } });
  if (!batch) throw new NotFoundError();
  const after = AFTER_IMPORT.has(batch.status);
  const saved = (batch.options ?? {}) as Partial<ImportCommit>;
  const choice: FixOptions = after
    ? { acceptHigh: saved.acceptHigh === true, noContactRows: saved.noContactRows ?? null }
    : opts ?? { acceptHigh: false, noContactRows: null };
  const known = await knownCountries();
  const rows = await prisma.importRow.findMany({
    where: { batchId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: {
      id: true, fields: true, research: true, status: true, include: true, matchedCompanyId: true, originKind: true, originN: true,
      outcome: true, outcomeCode: true, error: true,
      matchedCompany: { select: { id: true, number: true } },
      file: { select: { name: true, ext: true } },
    },
  });
  const plans = after ? [] : planBatch(rows, { ...choice, knownCountries: known });
  const out: FixRow[] = [];
  rows.forEach((row, i) => {
    const { fields } = effectiveFields(row, choice.acceptHigh);
    const match = row.status === 'Already in CRM' && row.matchedCompany ? row.matchedCompany : null;
    const ev = evaluateRow(fields, { knownCountries: known, match, notALead: row.status === 'Not a lead' });
    const problems = [...ev.problems];
    const reason = (code: string | null | undefined, value?: string) => {
      if (!code || problems.some((p) => p.code === code)) return;
      problems.push({ code: code as ProblemCode, level: 'info', ...(value !== undefined ? { value } : {}) });
    };
    let include = false;
    if (!after) {
      const plan = plans[i]!;
      if (plan.action === 'skip') {
        include = true;
        reason(plan.reason, plan.reason === 'country_unknown' ? plan.country ?? '' : plan.reason === 'already_in_crm' ? match?.number : undefined);
      } else {
        include = ev.status === 'Missing details';
      }
    } else if (row.outcome === 'Skipped') {
      include = true;
      reason(row.outcomeCode, row.outcomeCode === 'already_in_crm' ? match?.number : undefined);
    } else if (row.outcome === 'Error') {
      include = true;
      problems.push({ code: 'import_error', level: 'info', value: row.error ?? '' });
    } else if (row.outcome === 'Imported') {
      include = ev.status === 'Missing details';
    }
    if (include) out.push({ fields, from: fromLabel(row.file.name, row.file.ext, row.originKind, row.originN), problems });
  });
  return out;
}

/** "What to fix": each problem once (contact_missing is stored for both Email and Phone), in plain words. */
export function whatToFix(problems: readonly RowProblem[], lang: Lang): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const p of problems) {
    if (seen.has(p.code)) continue;
    seen.add(p.code);
    texts.push(problemText(p, lang));
  }
  return texts.join('; ');
}

const FILL = { base: 'FFF5F1FC', header: 'FFEFE6FD', missing: 'FFFDE8E8', questionable: 'FFFFF1E0' } as const;
const FONT = { missing: 'FFA32020', questionable: 'FF8A4B00' } as const;
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const FIX_COLUMNS: readonly ImportColumnKey[] = [...IMPORT_TABLE_FIELDS, 'from', 'whatToFix'];

/** Per field, how its cell is coloured: missing (red) wins over questionable (amber). */
function cellLevels(problems: readonly RowProblem[]): Map<ImportField, 'missing' | 'questionable'> {
  const levels = new Map<ImportField, 'missing' | 'questionable'>();
  for (const p of problems) {
    if (!p.field || p.level === 'info') continue;
    if (p.level === 'missing' || !levels.has(p.field)) levels.set(p.field, p.level);
  }
  return levels;
}

/**
 * The "Rows to fix" workbook in the downloader's language: one sheet, a bold frozen header, every data cell lightly
 * filled, the problem cells red (missing) or amber (questionable), "From" and "What to fix" last. Values are strings.
 */
export async function rowsToFixWorkbook(batchId: number, lang: Lang, opts?: FixOptions): Promise<Buffer> {
  const rows = await fixRows(batchId, opts);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rows to fix', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = FIX_COLUMNS.map((key) => ({ width: key === 'whatToFix' ? 48 : key === 'from' ? 24 : 22 }));
  const header = ws.getRow(1);
  FIX_COLUMNS.forEach((key, c) => {
    const cell = header.getCell(c + 1);
    cell.value = safeCell(importColumnLabel(key, lang));
    cell.font = { bold: true };
    cell.fill = fill(FILL.header);
  });
  rows.forEach((r, i) => {
    const row = ws.getRow(i + 2);
    const levels = cellLevels(r.problems);
    FIX_COLUMNS.forEach((key, c) => {
      const cell = row.getCell(c + 1);
      const raw = key === 'from' ? r.from : key === 'whatToFix' ? whatToFix(r.problems, lang) : r.fields[key as ImportField] ?? '';
      cell.value = safeCell(raw);
      const level = levels.get(key as ImportField);
      cell.fill = fill(level ? FILL[level] : FILL.base);
      if (level) cell.font = { color: { argb: FONT[level] } };
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** RFC 4180: quoted when it holds a comma, a quote or a line break; quotes doubled. */
const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Every row of the batch by position (UTF-8 with BOM, CRLF): the table fields, From, Status (the outcome once there is
 * one, else the row's status), Lead (LD-n) and Company number (CO-n, the linked or the matched company).
 */
export async function rowsCsv(batchId: number, lang: Lang): Promise<string> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { id: true } });
  if (!batch) throw new NotFoundError();
  const rows = await prisma.importRow.findMany({
    where: { batchId },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: {
      fields: true, status: true, outcome: true, originKind: true, originN: true,
      file: { select: { name: true, ext: true } },
      lead: { select: { number: true } },
      company: { select: { number: true } },
      matchedCompany: { select: { number: true } },
    },
  });
  const keys: ImportColumnKey[] = [...IMPORT_TABLE_FIELDS, 'from', 'status', 'lead', 'company'];
  const lines = [keys.map((k) => importColumnLabel(k, lang))];
  for (const r of rows) {
    const fields = (r.fields ?? {}) as RowFields;
    lines.push([
      ...IMPORT_TABLE_FIELDS.map((f) => fields[f] ?? ''),
      fromLabel(r.file.name, r.file.ext, r.originKind, r.originN),
      r.outcome ?? r.status,
      r.lead?.number ?? '',
      r.company?.number ?? r.matchedCompany?.number ?? '',
    ]);
  }
  return `\uFEFF${lines.map((cells) => cells.map((c) => csvField(safeCell(c))).join(',')).join('\r\n')}\r\n`;
}

/** Control characters and bidi controls (a name like "gpj.exe" shown reversed) never reach a download name. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * `Content-Disposition` for a download, never inline: an ASCII `filename` fallback and the real name RFC 5987-encoded
 * in `filename*`.
 */
export function attachmentHeader(name: string): string {
  const clean = name.replace(UNSAFE_NAME, '').trim() || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
