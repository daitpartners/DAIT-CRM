/**
 * Reading an uploaded import file: a spreadsheet becomes tables of cell text, a document becomes page text. A file
 * the reader refuses comes back Failed with the reason's code; anything unexpected is thrown (the job then marks the
 * file `unreadable`). The job never calls these directly: it reads in a worker thread (`isolated.ts`), so a hostile
 * file can only time out or run out of its own memory, never block or crash the worker process.
 */
import type { FileMeta, ImportExt, ImportFileError } from '@dait-crm/shared';
import { readSpreadsheet } from './spreadsheet.js';
import { readCsv } from './csv.js';
import { readPdf } from './pdf.js';
import { readDocx } from './docx.js';
import { readText } from './text.js';

export { assertZipSize } from './zip.js';
export { ReadFailure } from './failure.js';
export { readSpreadsheet, readCsv, readPdf, readDocx, readText };

export type TableExtract = { kind: 'table'; sheets: { name: string; rows: string[][] }[] };
export type TextExtract = { kind: 'text'; unit: 'page' | 'card' | 'line'; pages: { n: number; text: string }[] };
/** `error` (Failed only) is the stable code stored in `import_files.error` (`IMPORT_FILE_ERRORS`, shared). */
export type ReadResult = {
  status: 'Read' | 'Scan' | 'Failed'; meta: FileMeta; extract?: TableExtract | TextExtract; error?: ImportFileError;
};

/**
 * Bytes to text: a BOM decides (UTF-8, UTF-16LE, UTF-16BE); without one, UTF-8 when it is valid, else windows-1252
 * (what Excel on Windows writes for a "CSV" export).
 */
export function decodeText(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(data.subarray(3));
  }
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** Reads one file by its extension; `fileName` names a CSV's one sheet. */
export async function readImportBuffer(ext: ImportExt, data: Buffer, fileName?: string): Promise<ReadResult> {
  switch (ext) {
    case 'xlsx':
    case 'xls':
      return readSpreadsheet(data, ext);
    case 'csv':
      return readCsv(data, fileName);
    case 'pdf':
      return readPdf(data);
    case 'docx':
      return readDocx(data);
    case 'txt':
      return readText(data);
  }
}
