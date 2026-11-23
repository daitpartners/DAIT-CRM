/**
 * .xlsx / .xls → one table per sheet, every cell as the text a person sees, except whole numbers, which are read as
 * their full digits (a phone stored as a number in General format shows "9.71456E+11" but is 971455501920).
 */
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full.mjs';
import { IMPORT_MAX_ROWS } from '@dait-crm/shared';
import type { ReadResult } from './index.js';
import { ReadFailure, isEncryptedPackage, isOle } from './failure.js';
import { assertZipSize, isZip } from './zip.js';

// Legacy .xls text in a Windows code page needs the code page tables.
XLSX.set_cptable(cptable);

/** Whole numbers up to this size print without an exponent through String(). */
const PLAIN_INTEGER_LIMIT = 1e21;

/** A cell as text: whole numbers as digits, dates and other numbers as displayed, text trimmed. */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return '';
  switch (cell.t) {
    case 'n': {
      const v = cell.v as number;
      const isDate = typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z);
      if (!isDate && Number.isInteger(v) && Math.abs(v) < PLAIN_INTEGER_LIMIT) return String(v);
      return (cell.w ?? String(v)).trim();
    }
    case 's':
      return String(cell.v ?? '').trim();
    case 'd':
    case 'b':
      return (cell.w ?? String(cell.v)).trim();
    default:
      // 'e' (a formula error such as #N/A) and 'z' (an empty styled cell) hold no value.
      return '';
  }
}

function sheetRows(sheet: XLSX.WorkSheet): string[][] {
  const dense = (sheet['!data'] ?? []) as (XLSX.CellObject[] | undefined)[];
  const rows: string[][] = [];
  for (let r = 0; r < dense.length; r += 1) {
    const cells = dense[r] ?? [];
    const row: string[] = [];
    for (let c = 0; c < cells.length; c += 1) row.push(cellText(cells[c]));
    while (row.length > 0 && row[row.length - 1] === '') row.pop();
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

export async function readSpreadsheet(data: Buffer, ext: 'xlsx' | 'xls'): Promise<ReadResult> {
  try {
    if (isEncryptedPackage(data)) throw new ReadFailure('password');
    // A renamed .xls / .xlsx still reads (SheetJS looks at the content); anything else is refused before parsing.
    if (isZip(data)) await assertZipSize(data);
    else if (!isOle(data)) throw new ReadFailure('invalid');
    let book: XLSX.WorkBook;
    try {
      book = XLSX.read(data, {
        type: 'buffer', dense: true, cellStyles: false, cellHTML: false, cellNF: true, sheetRows: IMPORT_MAX_ROWS + 50,
      });
    } catch (e) {
      throw new ReadFailure(/password|encrypt/i.test(e instanceof Error ? e.message : '') ? 'password' : 'invalid');
    }
    const sheets = book.SheetNames.map((name) => ({ name, rows: sheetRows(book.Sheets[name]) }));
    const rows = sheets.reduce((n, s) => n + s.rows.filter((r) => r.length > 0).length, 0);
    return { status: 'Read', meta: { sheets: sheets.length, rows }, extract: { kind: 'table', sheets } };
  } catch (e) {
    if (e instanceof ReadFailure) return { status: 'Failed', meta: {}, error: e.text(ext) };
    throw e;
  }
}
