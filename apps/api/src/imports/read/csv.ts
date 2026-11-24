/** .csv → one table named after the file; the delimiter (, ; or tab) is detected from the first non-empty line. */
import { parse } from 'csv-parse/sync';
import { IMPORT_MAX_ROWS } from '@dait-crm/shared';
import { decodeText, type ReadResult } from './index.js';
import { MAX_TABLE_CHARS } from './failure.js';

const DELIMITERS = [',', ';', '\t'] as const;

/** The most frequent of , ; tab outside quotes on the first non-empty line (comma when none or tied with it). */
export function detectDelimiter(text: string): string {
  const line = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== '') ?? '';
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best: string = ',';
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** The file name without its extension ("exhibitors.csv" → "exhibitors"). */
const sheetName = (fileName: string | undefined) => (fileName ?? '').replace(/\.[^.]*$/, '').trim() || 'Sheet1';

export async function readCsv(data: Buffer, fileName?: string): Promise<ReadResult> {
  const text = decodeText(data);
  let records: string[][];
  try {
    records = parse(text, {
      delimiter: detectDelimiter(text), relax_column_count: true, relax_quotes: true, bom: true,
      skip_empty_lines: false, to: IMPORT_MAX_ROWS + 50,
    }) as string[][];
  } catch {
    return { status: 'Failed', meta: {}, error: 'invalid' };
  }
  const rows = records.map((r) => {
    const row = r.map((cell) => cell.trim());
    while (row.length > 0 && row[row.length - 1] === '') row.pop();
    return row;
  });
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  if (rows.reduce((n, r) => n + r.reduce((m, c) => m + c.length, 0), 0) > MAX_TABLE_CHARS) {
    return { status: 'Failed', meta: {}, error: 'too_large' };
  }
  return {
    status: 'Read',
    meta: { rows: rows.filter((r) => r.length > 0).length },
    extract: { kind: 'table', sheets: [{ name: sheetName(fileName), rows }] },
  };
}
