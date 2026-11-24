/**
 * Import leads downloads: the "rows to fix" Excel (every row that will not import, or imported still missing details,
 * with the problem cells coloured and "What to fix" in plain words; it uploads again through step 1, where "What to fix"
 * and "From" are ignored), the CSV of every row, and the original file's download headers. Every value written goes
 * through `safeCell`, so nothing a file brought in can run as a formula in Excel; websites are plain text, never links.
 */
import ExcelJS from 'exceljs';
import {
  IMPORT_TABLE_FIELDS, importColumnLabel, importRowStatusText, isUpdateErrorCode, problemText,
  type ImportColumnKey, type ImportCommit, type ImportField, type Lang, type ProblemCode, type RowChanges, type RowFields, type RowProblem,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { activeUser } from '../leads/visibility.js';
import type { AuthUser } from '../plugins/auth.js';
import { conflictProblems, previewUpdates } from './updates.js';
import { NotFoundError } from '../validate.js';
import { safeCell, safeCsvCell } from './cells.js';
import { effectiveFields, planBatch } from './plan.js';
import { evaluateRow, fromLabel, knownCountries, originText, rowOrigin, type RowOrigin } from './stage.js';

export { safeCell, safeCsvCell } from './cells.js';

/** `from` in English; `origin` as parts, worded in the downloader's language in the workbook. */
/** `leadId`: the lead an update row points at (the workbook links its page). */
export type FixRow = { fields: RowFields; from: string; origin: RowOrigin; problems: RowProblem[]; leadId?: number | null };
export type FixOptions = { acceptHigh: boolean; noContactRows: 'import' | 'leave' | null };

/** Batch statuses from which a row's outcome (Imported, Skipped, Error) decides it, rather than the plan. */
const AFTER_IMPORT = new Set(['Importing', 'Imported', 'Undone', 'Failed']);

/**
 * The rows to fix, in position order. Before the import: the rows the plan (with these choices) leaves out, plus the
 * rows it imports that are still Missing details on their effective values. After the import (the batch's own
 * choices): rows Skipped or Error, plus imported rows still Missing details. Problems are the row's problems on its
 * effective values, plus why it was left out (once per code).
 */
export async function fixRows(batchId: number, opts?: FixOptions, user: AuthUser | null = null): Promise<FixRow[]> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { status: true, options: true, createdById: true } });
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
      outcome: true, outcomeCode: true, error: true, problems: true, changes: true, leadId: true,
      matchedCompany: { select: { id: true, number: true } },
      file: { select: { name: true, ext: true } },
    },
  });
  const plans = after ? [] : planBatch(rows, { ...choice, knownCountries: known });
  // Update rows before the import: their conflicts against the CRM as it is now.
  const updating = after ? [] : plans.map((p, i) => (p.action === 'update' ? i : -1)).filter((i) => i >= 0);
  const previewOf = new Map<number, Awaited<ReturnType<typeof previewUpdates>>[number]>();
  if (updating.length > 0) {
    const viewer = user ?? (batch.createdById ? await activeUser(prisma, batch.createdById) : null);
    const previews = await previewUpdates(prisma, viewer, updating.map((i) => rows[i]!.fields as RowFields), known);
    updating.forEach((i, k) => previewOf.set(rows[i]!.id, previews[k] ?? null));
  }
  const out: FixRow[] = [];
  rows.forEach((row, i) => {
    const { fields } = effectiveFields(row, choice.acceptHigh);
    // Header, total and blank lines are never leads: they are not in the file.
    if (row.status === 'Not a lead') return;
    const push = (problems: RowProblem[], leadId?: number | null) => {
      const origin = rowOrigin(row.file.name, row.file.ext, row.originKind, row.originN);
      out.push({ fields: (row.fields ?? {}) as RowFields, from: originText(origin), origin, problems, leadId: leadId ?? null });
    };
    // Update rows (Lead ID / Company ID): an id error, or the values that differ from the CRM (amber, not applied).
    const stored = Array.isArray(row.problems) ? (row.problems as RowProblem[]) : [];
    const idProblem = stored.find((p) => isUpdateErrorCode(p?.code));
    if (row.status === 'Update' || idProblem || isUpdateErrorCode(row.outcomeCode)) {
      if (after) {
        if (row.outcome === 'Updated') {
          const changes = row.changes as unknown as RowChanges | null;
          if (changes?.conflicts?.length) push(conflictProblems(changes.conflicts), row.leadId);
        } else if (row.outcome === 'Error') {
          const f = (row.fields ?? {}) as RowFields;
          push([idProblem ?? (isUpdateErrorCode(row.outcomeCode)
            ? { code: row.outcomeCode, level: 'missing', value: f.leadId ?? f.companyId ?? '' }
            : { code: 'import_error', level: 'info', value: row.error ?? '' })]);
        } else if (row.outcome === 'Skipped') {
          push([{ code: (row.outcomeCode ?? 'unticked') as ProblemCode, level: 'info' }]);
        }
        return;
      }
      const plan = plans[i]!;
      if (idProblem) push([idProblem]);
      else if (plan.action === 'skip') push([{ code: (plan.reason ?? 'unticked') as ProblemCode, level: 'info' }]);
      else {
        const preview = previewOf.get(row.id);
        if (preview?.conflicts.length) push(conflictProblems(preview.conflicts), preview.leadId);
      }
      return;
    }
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
    if (include) {
      const origin = rowOrigin(row.file.name, row.file.ext, row.originKind, row.originN);
      // The row's OWN values: a research value written here would come back as the row's own on re-upload, losing
      // where it came from (the problems above still count the accepted research values).
      out.push({ fields: (row.fields ?? {}) as RowFields, from: originText(origin), origin, problems });
    }
  });
  return out;
}

/**
 * "What to fix": each problem once (contact_missing is stored for both Email and Phone), in plain words; an update
 * conflict once per field.
 */
export function whatToFix(problems: readonly RowProblem[], lang: Lang): string {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const p of problems) {
    const key = p.code === 'update_conflict' || p.code === 'industry_unknown' ? `${p.code}:${p.field ?? ''}` : p.code;
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(problemText(p, lang));
  }
  return texts.join('; ');
}

const FILL = { base: 'FFF5F1FC', header: 'FFEFE6FD', missing: 'FFFDE8E8', questionable: 'FFFFF1E0' } as const;
const FONT = { missing: 'FFA32020', questionable: 'FF8A4B00' } as const;
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
/** The table fields, From and What to fix, then the record ids (an update row comes back as one) and the lead page. */
const FIX_COLUMNS: readonly ImportColumnKey[] = [...IMPORT_TABLE_FIELDS, 'from', 'whatToFix', 'leadId', 'companyId', 'leadPage'];

/** The CRM's own page of a lead (PUBLIC_URL; a relative path when it is not set). */
export function leadPageUrl(leadId: number): string {
  const base = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
  return `${base}/leads/${leadId}`;
}

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
export async function rowsToFixWorkbook(batchId: number, lang: Lang, opts?: FixOptions, user: AuthUser | null = null): Promise<Buffer> {
  const rows = await fixRows(batchId, opts, user);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rows to fix', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = FIX_COLUMNS.map((key) => ({ width: key === 'whatToFix' ? 48 : key === 'from' ? 24 : key === 'leadPage' ? 36 : 22 }));
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
      if (key === 'leadPage') {
        // The CRM's own page (never a value from the file), so it is a real link.
        cell.value = r.leadId ? { text: leadPageUrl(r.leadId), hyperlink: leadPageUrl(r.leadId) } : '';
        cell.fill = fill(FILL.base);
        return;
      }
      const raw = key === 'from' ? originText(r.origin, lang) : key === 'whatToFix' ? whatToFix(r.problems, lang)
        : r.fields[key as ImportField | 'leadId' | 'companyId'] ?? '';
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
 * one, else the row's status, in `lang`), Lead (LD-n) and Company number (CO-n, the linked or the matched company).
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
      fromLabel(r.file.name, r.file.ext, r.originKind, r.originN, lang),
      importRowStatusText(r.outcome ?? r.status, lang),
      r.lead?.number ?? '',
      r.company?.number ?? r.matchedCompany?.number ?? '',
    ]);
  }
  return `\uFEFF${lines.map((cells) => cells.map((c) => csvField(safeCsvCell(c))).join(',')).join('\r\n')}\r\n`;
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
