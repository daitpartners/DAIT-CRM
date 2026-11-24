import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_TABLE_FIELDS, importColumnLabel, type Lang, type ResearchValue, type RowFields } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { fixRows, rowsCsv, rowsToFixWorkbook, safeCell, safeCsvCell } from '../src/imports/exports';
import { unguardCell } from '../src/imports/cells';
import { readSpreadsheet } from '../src/imports/read/index';
import { classifyColumns, findHeaderRow } from '../src/imports/columns';
import { knownCountries, stageTable } from '../src/imports/stage';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeUser, signIn } from './factory';

let app: FastifyInstance;
let storage: string;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  storage = await mkdtemp(path.join(tmpdir(), 'crm-exports-'));
  vi.stubEnv('STORAGE_DIR', storage);
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
  await rm(storage, { recursive: true, force: true });
});

let admin: User;
let cookie: string;
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  admin = await makeUser({ role: 'ADMINISTRATOR' });
  cookie = await signIn(app, admin);
});

const BASE = 'FFF5F1FC';
const RED = 'FFFDE8E8';
const AMBER = 'FFFFF1E0';

type RowSpec = RowFields & { $status?: string; $include?: boolean; $research?: Record<string, ResearchValue>; $outcome?: string; $code?: string; $error?: string };
let seq = 0;
async function batchWith(rows: RowSpec[], o: { status?: string; options?: object } = {}) {
  seq += 1;
  const batch = await prisma.importBatch.create({
    data: {
      number: `IMPORT-2026-11-24-${seq + 200}`, language: 'en', leadType: 'Lead', status: o.status ?? 'Waiting for review',
      createdById: admin.id, options: o.options ?? {},
    },
  });
  const file = await prisma.importFile.create({
    data: { batchId: batch.id, name: 'Expo-visitors.xlsx', ext: 'xlsx', size: 1, storagePath: '', status: 'Read' },
  });
  for (const [i, { $status, $include, $research, $outcome, $code, $error, ...fields }] of rows.entries()) {
    await prisma.importRow.create({
      data: {
        batchId: batch.id, fileId: file.id, position: i + 1, originKind: 'row', originN: i + 2, fields,
        status: $status ?? 'Ready', include: $include ?? true, research: $research ?? {},
        outcome: $outcome ?? null, outcomeCode: $code ?? null, error: $error ?? null,
      },
    });
  }
  return batch;
}

async function sheetOf(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet('Rows to fix');
  expect(ws).toBeDefined();
  return ws!;
}
const fillOf = (cell: ExcelJS.Cell) => (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
const COLS = [...IMPORT_TABLE_FIELDS, 'from', 'whatToFix'] as const;
const col = (key: (typeof COLS)[number]) => COLS.indexOf(key) + 1;

const fixBatch = () => batchWith([
  { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es' },
  { companyName: 'No Country SL', email: 'x@nocountry.es', $status: 'Missing details' },
  { companyName: 'Chile Co', country: 'Chile', email: 'a@chile.test', phone: '+56 2 2345 6789' },
  { companyName: 'Silent Co', country: 'Spain', $status: 'Missing details' },
  { companyName: 'Phone Only', country: 'Spain', phone: '+971 4 555 0192', $status: 'Missing details' },
  { companyName: '=HYPERLINK("http://x","y")', country: 'Spain', city: '@SUM(1)', email: 'a@b.test', website: 'javascript:alert(1)' },
]);

describe('safeCell', () => {
  it('prefixes formula starts (also full-width), never a phone number', () => {
    expect(safeCell('=1+1')).toBe("'=1+1");
    expect(safeCell('+cmd')).toBe("'+cmd");
    expect(safeCell('-2+3')).toBe("'-2+3");
    expect(safeCell('@SUM(1)')).toBe("'@SUM(1)");
    expect(safeCell('\tx')).toBe("'\tx");
    expect(safeCell('\rx')).toBe("'\rx");
    expect(safeCell('＝1+1')).toBe("'＝1+1");
    expect(safeCell('＠x')).toBe("'＠x");
    expect(safeCell('+971 4 555 0192')).toBe('+971 4 555 0192');
    expect(safeCell('(044) 555-0192')).toBe('(044) 555-0192');
    expect(safeCell('Hotel Sol')).toBe('Hotel Sol');
    expect(safeCell('')).toBe('');
  });

  it('CSV: every formula start is guarded, phones and -( included; step 1 drops exactly that one apostrophe', () => {
    expect(safeCsvCell('+971 4 555 0192')).toBe("'+971 4 555 0192");
    expect(safeCsvCell('-(1)-(2)')).toBe("'-(1)-(2)");
    expect(safeCsvCell('Hotel Sol')).toBe('Hotel Sol');
    expect(unguardCell("'@Home Realty")).toBe('@Home Realty');
    expect(unguardCell("'+Plus Ltd")).toBe('+Plus Ltd');
    expect(unguardCell("'＝x")).toBe('＝x');
    expect(unguardCell("''=x")).toBe("''=x");
    expect(unguardCell("'Rourke's")).toBe("'Rourke's");
    expect(unguardCell("O'Brien")).toBe("O'Brien");
  });
});

describe('rows to fix', () => {
  it('fixRows: rows the plan skips plus rows still missing details; the skip reason once', async () => {
    const batch = await fixBatch();
    const rows = await fixRows(batch.id, { acceptHigh: false, noContactRows: 'leave' });
    expect(rows.map((r) => r.fields.companyName)).toEqual(['No Country SL', 'Chile Co', 'Silent Co', 'Phone Only']);
    expect(rows[0]!.from).toBe('Expo xlsx · row 3');
    expect(rows[1]!.problems.map((p) => p.code)).toEqual(['country_unknown']);
    expect(rows[2]!.problems.map((p) => p.code)).toEqual(['contact_missing', 'contact_missing', 'no_contact_left_out']);
    expect(rows[3]!.problems.map((p) => p.code)).toEqual(['email_missing']);
  });

  it('header, total and blank lines (Not a lead) never appear; unticked Already in CRM and other skipped rows do', async () => {
    const crm = await makeCompany({ name: 'Old Co', country: 'Spain' });
    const batch = await batchWith([
      { $status: 'Not a lead', $include: false },
      { companyName: 'TOTAL VISITORS DAY 2', $status: 'Not a lead', $include: false },
      { companyName: 'Company', email: 'Email', $status: 'Not a lead', $include: false },
      { companyName: 'Old Co', country: 'Spain', email: 'a@old.test', $status: 'Already in CRM', $include: false },
      { companyName: 'Unticked Co', country: 'Spain', email: 'u@u.test', $include: false },
      { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es' },
    ]);
    await prisma.importRow.updateMany({ where: { batchId: batch.id, status: 'Already in CRM' }, data: { matchedCompanyId: crm.id } });
    const rows = await fixRows(batch.id, { acceptHigh: false, noContactRows: 'import' });
    expect(rows.map((r) => [r.fields.companyName, r.problems.map((p) => p.code)])).toEqual([
      ['Old Co', ['already_in_crm']], ['Unticked Co', ['unticked']],
    ]);
    expect(rows[0]!.problems[0]!.value).toBe(crm.number);
  });

  it('workbook: bold frozen header, light fill, red / amber problem cells, What to fix, injection prefix', async () => {
    const batch = await fixBatch();
    const res = await app.inject({
      method: 'GET', url: `/api/imports/batches/${batch.id}/rows-to-fix.xlsx?acceptHigh=0&noContactRows=import`, headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain(`${batch.number}-rows-to-fix.xlsx`);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    const ws = await sheetOf(res.rawPayload);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const header = ws.getRow(1);
    expect(COLS.map((k, i) => header.getCell(i + 1).value)).toEqual(COLS.map((k) => importColumnLabel(k, 'en')));
    for (let i = 1; i <= COLS.length; i += 1) {
      expect(header.getCell(i).font?.bold).toBe(true);
      expect(fillOf(header.getCell(i))).toBe('FFEFE6FD');
    }
    // Rows: No Country SL, Chile Co, Silent Co (no contact, imported with "Import them" but still missing), Phone Only.
    const byCompany = new Map<string, ExcelJS.Row>();
    ws.eachRow((row, n) => { if (n > 1) byCompany.set(String(row.getCell(1).value), row); });
    expect([...byCompany.keys()]).toEqual(['No Country SL', 'Chile Co', 'Silent Co', 'Phone Only']);

    const noCountry = byCompany.get('No Country SL')!;
    expect(fillOf(noCountry.getCell(col('country')))).toBe(RED);
    expect(noCountry.getCell(col('country')).font?.color?.argb).toBe('FFA32020');
    expect(fillOf(noCountry.getCell(col('companyName')))).toBe(BASE);
    expect(fillOf(noCountry.getCell(col('whatToFix')))).toBe(BASE);
    expect(noCountry.getCell(col('whatToFix')).value).toBe('Add the country');
    expect(noCountry.getCell(col('from')).value).toBe('Expo xlsx · row 3');

    const chile = byCompany.get('Chile Co')!;
    expect(fillOf(chile.getCell(col('country')))).toBe(AMBER);
    expect(chile.getCell(col('country')).font?.color?.argb).toBe('FF8A4B00');
    expect(chile.getCell(col('whatToFix')).value).toBe('Country not in the CRM: Chile');
    expect(fillOf(chile.getCell(col('email')))).toBe(BASE);

    const silent = byCompany.get('Silent Co')!;
    expect(fillOf(silent.getCell(col('email')))).toBe(RED);
    expect(fillOf(silent.getCell(col('phone')))).toBe(RED);
    // contact_missing is stored twice (email and phone) but said once.
    expect(silent.getCell(col('whatToFix')).value).toBe('Add an email or phone');

    const phoneOnly = byCompany.get('Phone Only')!;
    expect(fillOf(phoneOnly.getCell(col('email')))).toBe(RED);
    expect(fillOf(phoneOnly.getCell(col('phone')))).toBe(BASE);
    expect(phoneOnly.getCell(col('phone')).value).toBe('+971 4 555 0192');
    expect(phoneOnly.getCell(col('phone')).type).toBe(ExcelJS.ValueType.String);
    expect(phoneOnly.getCell(col('whatToFix')).value).toBe('Add an email');
  });

  it('every value is a string cell through safeCell (=HYPERLINK, @SUM); websites never become links', async () => {
    const batch = await batchWith([
      { companyName: '=HYPERLINK("http://x","y")', city: '@SUM(1)', website: 'javascript:alert(1)', phone: '+971 4 555 0192', $status: 'Missing details' },
    ]);
    const ws = await sheetOf(await rowsToFixWorkbook(batch.id, 'en', { acceptHigh: false, noContactRows: 'import' }));
    const row = ws.getRow(2);
    expect(row.getCell(col('companyName')).value).toBe('\'=HYPERLINK("http://x","y")');
    expect(row.getCell(col('companyName')).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(col('city')).value).toBe("'@SUM(1)");
    expect(row.getCell(col('website')).value).toBe('javascript:alert(1)');
    expect(row.getCell(col('website')).type).toBe(ExcelJS.ValueType.String);
    expect(row.getCell(col('phone')).value).toBe('+971 4 555 0192');
  });

  it('after import: Skipped and Error rows (with the error text) plus imported rows still missing details', async () => {
    const batch = await batchWith([
      { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es', $outcome: 'Imported' },
      { companyName: 'Chile Co', country: 'Chile', email: 'a@chile.test', $outcome: 'Skipped', $code: 'country_unknown' },
      { companyName: 'Broken Co', country: 'Spain', email: 'b@broken.test', $outcome: 'Error', $code: 'import_error', $error: 'invalid_status' },
      { companyName: 'Quiet Co', country: 'Spain', $status: 'Missing details', $outcome: 'Imported' },
      { companyName: 'Unticked Co', country: 'Spain', email: 'u@u.test', $include: false, $outcome: 'Skipped', $code: 'unticked' },
    ], { status: 'Imported', options: { acceptHigh: false, noContactRows: 'import', notify: false } });
    const rows = await fixRows(batch.id);
    expect(rows.map((r) => [r.fields.companyName, r.problems.map((p) => p.code)])).toEqual([
      ['Chile Co', ['country_unknown']],
      ['Broken Co', ['import_error']],
      ['Quiet Co', ['contact_missing', 'contact_missing']],
      ['Unticked Co', ['unticked']],
    ]);
    const ws = await sheetOf(await rowsToFixWorkbook(batch.id, 'es'));
    expect(ws.getRow(3).getCell(col('whatToFix')).value).toBe('No se pudo importar: invalid_status');
    // From is worded in the downloader's language too.
    expect(ws.getRow(3).getCell(col('from')).value).toMatch(/^\S+ \S+ · fila \d+$/);
    const fr = await sheetOf(await rowsToFixWorkbook(batch.id, 'fr'));
    expect(fr.getRow(3).getCell(col('from')).value).toMatch(/^\S+ \S+ · ligne \d+$/);
  });

  it.each(['es', 'fr'] as Lang[])('round trip (%s): the rows-to-fix file reads and stages cleanly; What to fix / From ignored', async (lang) => {
    const batch = await fixBatch();
    await prisma.importRow.create({
      data: {
        batchId: batch.id, fileId: (await prisma.importFile.findFirstOrThrow({ where: { batchId: batch.id } })).id, position: 7,
        originKind: 'row', originN: 8, fields: { companyName: '@Home Realty', city: '+Plus Ltd', country: 'Spain' }, status: 'Missing details', include: true,
      },
    });
    const buf = await rowsToFixWorkbook(batch.id, lang, { acceptHigh: false, noContactRows: 'import' });
    const read = await readSpreadsheet(buf, 'xlsx');
    expect(read.status).toBe('Read');
    const extract = read.extract;
    if (!extract || extract.kind !== 'table') throw new Error('table expected');
    const rows = extract.sheets[0]!.rows;
    const known = await knownCountries();
    expect(findHeaderRow(rows, known)).toBe(0);
    const header = rows[0]!;
    expect(header).toEqual(COLS.map((k) => importColumnLabel(k, lang)));
    const data = rows.slice(1);
    const columns = header.map((_, c) => data.map((r) => r[c] ?? ''));
    const { map, questions } = classifyColumns(header, columns, known);
    expect(questions).toEqual([]);
    expect(map).toEqual([...IMPORT_TABLE_FIELDS, 'ignore', 'ignore']);

    // Staged into a new batch: the same values come back as the rows' fields.
    const next = await prisma.importBatch.create({
      data: { number: `IMPORT-2026-11-25-${lang}`, language: 'en', leadType: 'Lead', status: 'Uploading', createdById: admin.id },
    });
    const file = await prisma.importFile.create({
      data: { batchId: next.id, name: `fix-${lang}.xlsx`, ext: 'xlsx', size: buf.length, storagePath: '', status: 'Read' },
    });
    await stageTable(file.id, extract);
    const staged = await prisma.importRow.findMany({ where: { fileId: file.id }, orderBy: { position: 'asc' } });
    // The workbook carries the guard ('@Home Realty); staging drops it again.
    expect(rows[5]![0]).toBe("'@Home Realty");
    expect(staged.map((r) => (r.fields as RowFields).companyName)).toEqual(['No Country SL', 'Chile Co', 'Silent Co', 'Phone Only', '@Home Realty']);
    expect((staged[4]!.fields as RowFields).city).toBe('+Plus Ltd');
    expect((staged[3]!.fields as RowFields).phone).toBe('+971 4 555 0192');
    expect(staged.map((r) => r.status)).toEqual(['Missing details', 'Ready', 'Missing details', 'Missing details', 'Missing details']);
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).questions).toEqual([]);
  });
});

describe('rows CSV', () => {
  it('BOM, every row by position, From / Status / Lead / Company number, safeCell and RFC 4180 quoting', async () => {
    const company = await makeCompany({ name: 'Hotel Sol', country: 'Spain' });
    const batch = await batchWith([
      { companyName: 'Hotel "Sol"', country: 'Spain', email: 'ana@hotelsol.es', notes: 'n' },
      { companyName: '=HYPERLINK("http://x","y")', city: '@SUM(1)', phone: '+971 4 555 0192', country: 'Spain', $status: 'Missing details' },
    ]);
    const [first] = await prisma.importRow.findMany({ where: { batchId: batch.id }, orderBy: { position: 'asc' } });
    await prisma.importRow.update({ where: { id: first!.id }, data: { companyId: company.id, outcome: 'Imported' } });
    const res = await app.inject({ method: 'GET', url: `/api/imports/batches/${batch.id}/rows.csv`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`${batch.number}-rows.csv`);
    const text = res.rawPayload.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('Company,Website,Country,City,Contact,Designation,Email,Phone,Industry,From,Status,Lead,Company number');
    expect(lines[1]).toBe(`"Hotel ""Sol""",,Spain,,,,ana@hotelsol.es,,,Expo xlsx · row 2,Imported,,${company.number}`);
    expect(lines[2]).toBe('"\'=HYPERLINK(""http://x"",""y"")",,Spain,\'@SUM(1),,,,\'+971 4 555 0192,,Expo xlsx · row 3,Missing details,,');
    const es = (await rowsCsv(batch.id, 'es')).slice(1).split('\r\n');
    expect(es[0]).toContain('Empresa,Sitio web,País');
    expect(es[1]).toContain(',Importada,');
    expect(es[2]).toContain(',Expo xlsx · fila 3,Faltan datos,');
    expect((await rowsCsv(batch.id, 'fr')).split('\r\n')[2]).toContain(',Expo xlsx · ligne 3,Informations manquantes,');
  });

  it('downloads need import_leads', async () => {
    const batch = await fixBatch();
    const rep = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    for (const url of [`/api/imports/batches/${batch.id}/rows.csv`, `/api/imports/batches/${batch.id}/rows-to-fix.xlsx`]) {
      expect((await app.inject({ method: 'GET', url, headers: { cookie: rep } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/imports/batches/999999/rows.csv', headers: { cookie } })).statusCode).toBe(404);
  });
});
