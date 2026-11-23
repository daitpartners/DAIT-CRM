/* In-memory builders for import test files (nothing is committed): spreadsheets, PDFs, Word files and a zip bomb. */
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
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

type HandEntry = { name: string; raw: Buffer; declared?: number; extra?: Buffer };

/** A zip built by hand, so it can lie: `declared` replaces an entry's real size, `count` the end record's entry count. */
export function handZip(entries: HandEntry[], count?: number): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = deflateRawSync(e.raw);
    const size = e.declared ?? e.raw.length;
    const name = Buffer.from(e.name);
    const extra = e.extra ?? Buffer.alloc(0);
    const crc = e.declared === undefined ? crc32(e.raw) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc >>> 0, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(extra.length, 30); cd.writeUInt32LE(offset, 42);
    central.push(cd, name, extra);
    offset += 30 + name.length + comp.length;
  }
  const dir = Buffer.concat(central);
  const n = count ?? entries.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(n, 8); eocd.writeUInt16LE(n, 10);
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

const CONTENT_TYPES = Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
const lying = new Map<string, Buffer>();

/**
 * Zips that lie to a guard that trusts them: `size` declares 1,000 bytes for an entry of 64 MB of zeros; `count` says
 * one entry while the directory holds a second, 300 MB of zeros; `zip64` points at a ZIP64 size its extra field cuts off.
 */
export function lyingZip(kind: 'size' | 'count' | 'zip64'): Buffer {
  const cached = lying.get(kind);
  if (cached) return cached;
  const ct = { name: '[Content_Types].xml', raw: CONTENT_TYPES };
  const zip = kind === 'size'
    ? handZip([ct, { name: 'word/document.xml', raw: Buffer.alloc(64 * 1024 * 1024), declared: 1000 }])
    : kind === 'count'
      ? handZip([ct, { name: 'word/document.xml', raw: Buffer.alloc(300 * 1024 * 1024) }], 1)
      : handZip([ct, { name: 'word/document.xml', raw: Buffer.from('<w:document/>'), declared: 0xffffffff, extra: Buffer.from([1, 0, 4, 0, 0, 0, 0, 0]) }]);
  lying.set(kind, zip);
  return zip;
}

/** A valid PDF whose page tree lists the same page `pages` times (tiny file, very slow for pdf.js to walk). */
export function repeatedPagePdf(pages: number): Buffer {
  const stream = 'BT /F1 12 Tf 72 720 Td (Hello exhibitor list page text here) Tj ET';
  const objs = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array(pages).fill('3 0 R').join(' ')}] >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
