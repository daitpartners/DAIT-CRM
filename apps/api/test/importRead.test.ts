import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import {
  assertZipSize, decodeText, readImportBuffer, type TableExtract, type TextExtract,
} from '../src/imports/read/index';
import { docx, pdfImageOnly, pdfWithText, xlsBook, xlsxBook, zipBomb } from './importFixtures';

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
    expect(r).toMatchObject({ status: 'Failed', error: 'This file is not a valid .xlsx file' });
    expect(r.extract).toBeUndefined();
  });

  it('refuses a zip bomb from the central directory, before anything is inflated', async () => {
    vi.mocked(XLSX.read).mockClear();
    vi.mocked(mammoth.extractRawText).mockClear();
    const bomb = await zipBomb();
    await expect(assertZipSize(bomb)).rejects.toThrow('This file is too large to read');
    expect(await readImportBuffer('xlsx', bomb)).toMatchObject({ status: 'Failed', error: 'This file is too large to read' });
    expect(await readImportBuffer('docx', bomb)).toMatchObject({ status: 'Failed', error: 'This file is too large to read' });
    expect(XLSX.read).not.toHaveBeenCalled();
    expect(mammoth.extractRawText).not.toHaveBeenCalled();
    // A small zip passes.
    await expect(assertZipSize(xlsxBook({ S: [['a']] }))).resolves.toBeUndefined();
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
    expect(await readImportBuffer('pdf', locked)).toMatchObject({ status: 'Failed', error: 'This file is password-protected' });
    expect(await readImportBuffer('pdf', Buffer.from('Company,Email\n'))).toMatchObject({ status: 'Failed', error: 'This file is not a valid .pdf file' });
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
    expect(await readImportBuffer('docx', OLE)).toMatchObject({ status: 'Failed', error: "Old .doc files can't be read; save it as .docx" });
    expect(await readImportBuffer('docx', Buffer.from('hello'))).toMatchObject({ status: 'Failed', error: 'This file is not a valid .docx file' });
  });
});
