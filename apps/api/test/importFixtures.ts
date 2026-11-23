/* In-memory builders for import test files (nothing is committed): spreadsheets, PDFs, Word files and a zip bomb. */
import { crc32, deflateSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';

function book(sheets: Record<string, unknown[][]>, bookType: 'xlsx' | 'biff8'): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    // Date cells are written as numbers with this display format (read back as their displayed text).
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { dateNF: 'dd/mm/yyyy' }), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
}

/** A .xlsx workbook: one sheet per key, rows as arrays of cells (numbers stay numbers, Dates become date cells). */
export const xlsxBook = (sheets: Record<string, unknown[][]>): Buffer => book(sheets, 'xlsx');

/** A legacy .xls (BIFF8) workbook. */
export const xlsBook = (sheets: Record<string, unknown[][]>): Buffer => book(sheets, 'biff8');

function pdfBuffer(build: (doc: PDFKit.PDFDocument) => void, options: PDFKit.PDFDocumentOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, ...options });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

/** A PDF with one page per entry; each entry's lines are written as text. */
export const pdfWithText = (pages: string[], options: PDFKit.PDFDocumentOptions = {}): Promise<Buffer> =>
  pdfBuffer((doc) => {
    for (const text of pages) {
      doc.addPage();
      doc.fontSize(12).text(text);
    }
  }, options);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A small solid-colour RGB PNG. */
export function png(width = 16, height = 16): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A scanned-looking PDF: `pages` pages, each one embedded PNG and no text. */
export const pdfImageOnly = (pages: number): Promise<Buffer> =>
  pdfBuffer((doc) => {
    const image = png();
    for (let i = 0; i < pages; i += 1) {
      doc.addPage();
      doc.image(image, 50, 50, { width: 400 });
    }
  });

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal .docx: one paragraph per entry; `pages` is written to docProps/app.xml when given. */
export async function docx(paragraphs: string[], pages?: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`);
  zip.file('docProps/app.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    + `<Application>Microsoft Office Word</Application>${pages !== undefined ? `<Pages>${pages}</Pages>` : ''}</Properties>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

let bomb: Promise<Buffer> | null = null;

/** A zip whose one entry inflates to 300 MB of zeros (a few hundred KB on disk); built once per test file. */
export function zipBomb(): Promise<Buffer> {
  bomb ??= (async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', Buffer.alloc(300 * 1024 * 1024));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  })();
  return bomb;
}
