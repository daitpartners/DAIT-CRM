import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import {
  assertZipSize, decodeText, readImportBuffer, type TableExtract, type TextExtract,
} from '../src/imports/read/index';
import { readInWorker } from '../src/imports/read/isolated';
import { readSpreadsheet } from '../src/imports/read/spreadsheet';
import { rebuildZip, ZIP_MAX_BYTES } from '../src/imports/read/zip';
import { PDF_MAX_PAGES } from '../src/imports/read/pdf';
import {
  docx, handZip, localHeaderLieZip, lyingZip, pdfImageOnly, pdfWithText, repeatedPagePdf, xlsBook, xlsxBook, zipBomb,
} from './importFixtures';

// Spies on the parsers: a file refused by the zip size check must never reach them.
vi.mock('xlsx', async (importOriginal) => {
  const m = await importOriginal<typeof import('xlsx')>();
  return { ...m, read: vi.fn(m.read) };
});
vi.mock('mammoth', async (importOriginal) => {
  const m = await importOriginal<{ default: typeof import('mammoth') }>();
  const d = m.default;
  return { default: { ...d, extractRawText: vi.fn(d.extractRawText) } };
});

const table = (r: { extract?: TableExtract | TextExtract }) => r.extract as TableExtract;
const text = (r: { extract?: TableExtract | TextExtract }) => r.extract as TextExtract;
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);

describe('spreadsheets', () => {
  it('reads every sheet of an .xlsx and counts the non-empty rows', async () => {
    const data = xlsxBook({
      Exhibitors: [['Company', 'Email'], ['Acme', 'a@acme.test'], ['Beta', 'b@beta.test']],
      More: [['Company'], ['Gamma'], [], []],
      Notes: [['just a note']],
    });
    const r = await readImportBuffer('xlsx', data);
    expect(r.status).toBe('Read');
    expect(r.meta).toEqual({ sheets: 3, rows: 6 });
    const t = table(r);
    expect(t.kind).toBe('table');
    expect(t.sheets.map((s) => s.name)).toEqual(['Exhibitors', 'More', 'Notes']);
    expect(t.sheets[0].rows).toEqual([['Company', 'Email'], ['Acme', 'a@acme.test'], ['Beta', 'b@beta.test']]);
    // Trailing empty rows are dropped.
    expect(t.sheets[1].rows).toEqual([['Company'], ['Gamma']]);
  });

  it('reads phone numbers stored as numbers as their full digits, keeps text phones and shows dates as displayed', async () => {
    const data = xlsxBook({
      Sheet1: [
        ['Company', 'Phone', 'Mobile', 'Text phone', 'Met on', 'Share', '  Padded  '],
        ['Acme', 971455501920, 4165550144, '+44 161 555 0100', new Date(Date.UTC(2026, 10, 22)), 0.25, '  x  '],
      ],
    });
    const r = await readImportBuffer('xlsx', data);
    const row = table(r).sheets[0].rows[1];
    expect(row[1]).toBe('971455501920');
    expect(row[2]).toBe('4165550144');
    expect(row[3]).toBe('+44 161 555 0100');
    expect(row[4]).toBe('22/11/2026');
    expect(row[5]).toBe('0.25');
    expect(row[6]).toBe('x');
    expect(table(r).sheets[0].rows[0][6]).toBe('Padded');
  });

  it('reads a legacy .xls (BIFF8)', async () => {
    const r = await readImportBuffer('xls', xlsBook({ Sheet1: [['Company', 'Phone'], ['Acme', 971455501920]] }));
    expect(r.status).toBe('Read');
    expect(table(r).sheets[0].rows).toEqual([['Company', 'Phone'], ['Acme', '971455501920']]);
    expect(r.meta).toEqual({ sheets: 1, rows: 2 });
  });

  it('refuses an .xlsx that is really a PDF', async () => {
    const r = await readImportBuffer('xlsx', await pdfWithText(['hello']));
    expect(r).toMatchObject({ status: 'Failed', error: 'invalid' });
    expect(r.extract).toBeUndefined();
  });

  it('refuses a zip bomb from the central directory, before anything is inflated', async () => {
    vi.mocked(XLSX.read).mockClear();
    vi.mocked(mammoth.extractRawText).mockClear();
    const bomb = await zipBomb();
    await expect(assertZipSize(bomb)).rejects.toMatchObject({ code: 'too_large' });
    expect(await readImportBuffer('xlsx', bomb)).toMatchObject({ status: 'Failed', error: 'too_large' });
    expect(await readImportBuffer('docx', bomb)).toMatchObject({ status: 'Failed', error: 'too_large' });
    expect(XLSX.read).not.toHaveBeenCalled();
    expect(mammoth.extractRawText).not.toHaveBeenCalled();
    // A small zip passes.
    await expect(assertZipSize(xlsxBook({ S: [['a']] }))).resolves.toBeUndefined();
  });
});

describe('zips that lie about themselves', () => {
  it('an entry larger than it declares is refused after at most one byte too many, before any parser', async () => {
    vi.mocked(XLSX.read).mockClear();
    vi.mocked(mammoth.extractRawText).mockClear();
    const zip = lyingZip('size');
    const rss = process.memoryUsage().rss;
    await expect(assertZipSize(zip)).rejects.toMatchObject({ code: 'too_large' });
    expect(await readImportBuffer('docx', zip)).toMatchObject({ status: 'Failed', error: 'too_large' });
    expect(await readImportBuffer('xlsx', zip)).toMatchObject({ status: 'Failed', error: 'too_large' });
    expect(XLSX.read).not.toHaveBeenCalled();
    expect(mammoth.extractRawText).not.toHaveBeenCalled();
    // Nothing near the real 64 MB was inflated.
    expect(process.memoryUsage().rss - rss).toBeLessThan(48 * 1024 * 1024);
  });

  it('an end record that counts fewer entries than the directory holds is refused', async () => {
    vi.mocked(XLSX.read).mockClear();
    vi.mocked(mammoth.extractRawText).mockClear();
    const zip = lyingZip('count');
    await expect(assertZipSize(zip)).rejects.toMatchObject({ code: 'invalid' });
    expect(await readImportBuffer('docx', zip)).toMatchObject({ status: 'Failed', error: 'invalid' });
    expect(await readImportBuffer('xlsx', zip)).toMatchObject({ status: 'Failed', error: 'invalid' });
    expect(XLSX.read).not.toHaveBeenCalled();
    expect(mammoth.extractRawText).not.toHaveBeenCalled();
  });

  it('a ZIP64 size cut off in its extra field is not a valid file', async () => {
    expect(await readImportBuffer('docx', lyingZip('zip64'))).toMatchObject({ status: 'Failed', error: 'invalid' });
    expect(await readImportBuffer('xlsx', lyingZip('zip64'))).toMatchObject({ status: 'Failed', error: 'invalid' });
  });

  it('a local header that disagrees with its central entry is refused, with no memory growth', async () => {
    vi.mocked(XLSX.read).mockClear();
    vi.mocked(mammoth.extractRawText).mockClear();
    // Fixtures first (building them allocates the 64 MB being deflated), then measure.
    for (const kind of ['size', 'deferred'] as const) {
      localHeaderLieZip(kind);
      localHeaderLieZip(kind, 'word/document.xml');
    }
    const rss = process.memoryUsage().rss;
    for (const kind of ['size', 'deferred'] as const) {
      const zip = localHeaderLieZip(kind);
      await expect(assertZipSize(zip)).rejects.toMatchObject({ code: 'invalid' });
      expect(await readSpreadsheet(zip, 'xlsx')).toMatchObject({ status: 'Failed', error: 'invalid' });
      expect(await readImportBuffer('docx', localHeaderLieZip(kind, 'word/document.xml'))).toMatchObject({ status: 'Failed', error: 'invalid' });
    }
    expect(XLSX.read).not.toHaveBeenCalled();
    expect(mammoth.extractRawText).not.toHaveBeenCalled();
    expect(process.memoryUsage().rss - rss).toBeLessThan(48 * 1024 * 1024);
    // The same through the read process.
    expect(await readInWorker('xlsx', localHeaderLieZip('size'), 'x.xlsx')).toMatchObject({ status: 'Failed', error: 'invalid' });
  });

  it(`refuses more than ${ZIP_MAX_BYTES / 1024 / 1024} MB uncompressed in total`, async () => {
    const zip = handZip([
      { name: 'a.xml', raw: Buffer.alloc(60 * 1024 * 1024) },
      { name: 'b.xml', raw: Buffer.alloc(60 * 1024 * 1024) },
    ]);
    await expect(assertZipSize(zip)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('parsers get a rebuilt zip that reads exactly like the original', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Company', 'Phone', 'Met'], ['Café Ltd', 971455501920, new Date(Date.UTC(2026, 10, 22))]], { dateNF: 'dd/mm/yyyy' }), 'Exhibitors');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Total', 3]]), 'Summary');
    // Deflated, as Excel writes it.
    const deflated = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
    const rebuilt = rebuildZip(deflated);
    expect(rebuilt.equals(deflated)).toBe(false);
    const rows = (buf: Buffer) => {
      const book = XLSX.read(buf, { type: 'buffer' });
      return book.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(book.Sheets[n], { header: 1, raw: false })]);
    };
    expect(rows(rebuilt)).toEqual(rows(deflated));
    const r = await readSpreadsheet(deflated, 'xlsx');
    expect(r.status).toBe('Read');
    expect((r.extract as TableExtract).sheets[0].rows[1]).toEqual(['Café Ltd', '971455501920', '22/11/2026']);
  });

  it('docProps/app.xml is read through the same capped path', async () => {
    const zip = handZip([
      { name: '[Content_Types].xml', raw: Buffer.from('<Types/>') },
      { name: 'docProps/app.xml', raw: Buffer.alloc(8 * 1024 * 1024), declared: 100 },
    ]);
    expect(await readImportBuffer('docx', zip)).toMatchObject({ status: 'Failed', error: 'too_large' });
  });
});

describe('csv and text', () => {
  it('detects a ; delimiter and decodes windows-1252', async () => {
    const data = Buffer.from('Company;City;Note\r\n"Caf\xe9 Ltd";Paris;"a, b"\r\nBeta;Lyon\r\n\r\n', 'latin1');
    const r = await readImportBuffer('csv', data, 'exhibitors.csv');
    expect(r.status).toBe('Read');
    expect(r.meta).toEqual({ rows: 3 });
    const t = table(r);
    expect(t.sheets).toHaveLength(1);
    expect(t.sheets[0].name).toBe('exhibitors');
    expect(t.sheets[0].rows).toEqual([['Company', 'City', 'Note'], ['Café Ltd', 'Paris', 'a, b'], ['Beta', 'Lyon']]);
  });

  it('reads a UTF-8 csv with a BOM, tab-separated', async () => {
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Company\tEmail\nZoë\tz@x.test\n', 'utf8')]);
    const r = await readImportBuffer('csv', data, 'a.csv');
    expect(table(r).sheets[0].rows).toEqual([['Company', 'Email'], ['Zoë', 'z@x.test']]);
  });

  it('decodes BOM-marked UTF-16 and falls back to windows-1252 for invalid UTF-8', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Señor €', 'utf16le')]);
    expect(decodeText(le)).toBe('Señor €');
    const be = Buffer.from(le.subarray(2)).swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('Señor €');
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe('Café €');
    expect(decodeText(Buffer.from('plain ünïcode', 'utf8'))).toBe('plain ünïcode');
  });

  it('reads a UTF-16LE text file with a BOM line by line', async () => {
    const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Acme Ltd\r\nsales@acme.test\r\n\r\n+44 161 555 0100\r\n', 'utf16le')]);
    const r = await readImportBuffer('txt', data);
    expect(r.status).toBe('Read');
    expect(r.meta).toEqual({ lines: 3, textFound: true });
    const t = text(r);
    expect(t).toMatchObject({ kind: 'text', unit: 'line' });
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].text).toContain('sales@acme.test');
    expect(t.pages[0].text).not.toContain('\r');
  });
});

describe('pdf', () => {
  it('reads the text of every page', async () => {
    const lines1 = 'Acme Widgets Ltd\nsales@acme.test\n+44 161 555 0100\nStand B12, Hall 3';
    const lines2 = 'Beta Trading LLC\ninfo@beta.test\nDubai, United Arab Emirates\nStand C4, Hall 1';
    const r = await readImportBuffer('pdf', await pdfWithText([lines1, lines2]));
    expect(r.status).toBe('Read');
    expect(r.meta).toEqual({ pages: 2, textFound: true });
    const t = text(r);
    expect(t.unit).toBe('page');
    expect(t.pages.map((p) => p.n)).toEqual([1, 2]);
    expect(t.pages[0].text).toContain('Acme Widgets Ltd');
    expect(t.pages[0].text).toContain('sales@acme.test');
    expect(t.pages[0].text.split('\n').length).toBeGreaterThanOrEqual(4);
    expect(t.pages[1].text).toContain('info@beta.test');
  });

  it('marks an image-only PDF as a scan', async () => {
    const r = await readImportBuffer('pdf', await pdfImageOnly(6));
    expect(r.status).toBe('Scan');
    expect(r.meta).toEqual({ pages: 6, textFound: false });
    expect(r.extract).toBeUndefined();
  });

  it('refuses a password-protected PDF and a file that is not a PDF', async () => {
    const locked = await pdfWithText(['secret text on the page'], { userPassword: 'pw', ownerPassword: 'pw2' });
    expect(await readImportBuffer('pdf', locked)).toMatchObject({ status: 'Failed', error: 'password' });
    expect(await readImportBuffer('pdf', Buffer.from('Company,Email\n'))).toMatchObject({ status: 'Failed', error: 'invalid' });
  });
});

describe('pdf limits', () => {
  it(`refuses more than ${PDF_MAX_PAGES} pages before reading any page`, async () => {
    const started = Date.now();
    expect(await readImportBuffer('pdf', repeatedPagePdf(50_000))).toMatchObject({ status: 'Failed', error: 'too_large' });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('reading in a child process', () => {
  it('reads a file and returns the same result', async () => {
    const r = await readInWorker('csv', Buffer.from('Company;City\nAcme;Paris\n'), 'list.csv');
    expect(r).toMatchObject({ status: 'Read', meta: { rows: 2 }, extract: { kind: 'table', sheets: [{ name: 'list', rows: [['Company', 'City'], ['Acme', 'Paris']] }] } });
  });

  it('a read still running at the timeout is stopped: Failed timeout', async () => {
    const started = Date.now();
    // The child starts, then stays busy for 10 s (like a slow parser); the timeout stops it after 1.5 s.
    expect(await readInWorker('csv', Buffer.from('Company\nAcme\n'), 'a.csv', { busyMs: 10_000, timeoutMs: 1500 }))
      .toEqual({ status: 'Failed', meta: {}, error: 'timeout' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(5000);
  });

  it('a read that runs out of its heap is Failed too_large, and this process carries on', async () => {
    const tiny = Buffer.from('Company;City\nAcme;Paris\n');
    // Same small heap: a normal read fits; a runaway one is stopped by V8 in the child, not here.
    expect(await readInWorker('csv', tiny, 'a.csv', { memoryMb: 160 })).toMatchObject({ status: 'Read' });
    expect(await readInWorker('csv', tiny, 'a.csv', { memoryMb: 160, exhaustHeap: true })).toEqual({ status: 'Failed', meta: {}, error: 'too_large' });
    expect(await readInWorker('csv', tiny, 'a.csv')).toMatchObject({ status: 'Read' });
  });

  it('never blocks this thread: timers keep ticking while hostile PDFs are read', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const started = Date.now();
    try {
      const [big, repeated] = await Promise.all([
        readInWorker('pdf', repeatedPagePdf(50_000)),
        readInWorker('pdf', repeatedPagePdf(PDF_MAX_PAGES)),
      ]);
      expect(big).toMatchObject({ status: 'Failed', error: 'too_large' });
      expect(repeated).toMatchObject({ status: 'Read', meta: { pages: PDF_MAX_PAGES, textFound: true } });
    } finally {
      clearInterval(timer);
    }
    const elapsed = Date.now() - started;
    // At least a third of the ticks a free event loop would give (a blocked loop gives none).
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(elapsed / 10 / 3));
    expect(ticks).toBeGreaterThan(5);
  });
});

describe('docx', () => {
  it('reads the text as one card-split page and the page count from app.xml', async () => {
    const r = await readImportBuffer('docx', await docx(['Acme Widgets Ltd', 'sales@acme.test', '', 'Beta Trading LLC'], 4));
    expect(r.status).toBe('Read');
    expect(r.meta).toEqual({ pages: 4, textFound: true });
    const t = text(r);
    expect(t.unit).toBe('card');
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].text).toContain('Acme Widgets Ltd');
    expect(t.pages[0].text).toContain('Beta Trading LLC');
  });

  it('leaves pages out when app.xml has none', async () => {
    const r = await readImportBuffer('docx', await docx(['Acme']));
    expect(r.meta).toEqual({ textFound: true });
  });

  it('refuses an old .doc saved as .docx and a file that is not a .docx', async () => {
    expect(await readImportBuffer('docx', OLE)).toMatchObject({ status: 'Failed', error: 'old_doc' });
    expect(await readImportBuffer('docx', Buffer.from('hello'))).toMatchObject({ status: 'Failed', error: 'invalid' });
  });
});
