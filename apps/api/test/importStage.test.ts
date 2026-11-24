import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importFileErrorText, normaliseCompanyName, type RowFields, type RowProblem } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { runOnce } from '../src/jobs/runner';
import { importReadFileHandler } from '../src/jobs/handlers/importReadFile';
import { enqueue } from '../src/jobs/queue';
import { saveImportFile } from '../src/imports/storage';
import type { TableExtract } from '../src/imports/read';
import { applyRowEdit, columnKey, refreshBatch, resortFile, stageHooks, stageTable, updateRow } from '../src/imports/stage';
import { companyKeyOf, findExistingCompanies } from '../src/imports/companies';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeUser, signIn } from './factory';
import { xlsxBook } from './importFixtures';

let app: FastifyInstance;
let storage: string;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  storage = await mkdtemp(path.join(tmpdir(), 'crm-stage-'));
  vi.stubEnv('STORAGE_DIR', storage);
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  stageHooks.beforeEvaluationWrite = undefined;
  stageHooks.beforeResortWrite = undefined;
  await rm(storage, { recursive: true, force: true });
});

type Role = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER';
async function as(role: Role) {
  const user = await makeUser({ role });
  return { user, cookie: await signIn(app, user) };
}
const json = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie } });

let batchSeq = 0;
async function newBatch(status = 'Uploading') {
  batchSeq += 1;
  return prisma.importBatch.create({
    data: { number: `IMPORT-2026-11-24-${batchSeq + 100}`, language: 'en', leadType: 'Prospect', status },
  });
}
async function newFile(batchId: number, name = 'Expo-Dubai-visitors.xlsx', status = 'Read') {
  return prisma.importFile.create({ data: { batchId, name, ext: name.split('.').pop()!, size: 100, storagePath: '', status } });
}
const table = (sheets: Record<string, string[][]>): TableExtract =>
  ({ kind: 'table', sheets: Object.entries(sheets).map(([name, rows]) => ({ name, rows })) });

async function rowsOf(fileId: number) {
  return prisma.importRow.findMany({ where: { fileId }, orderBy: [{ position: 'asc' }, { id: 'asc' }], include: { matchedCompany: true } });
}
const fieldsOf = (r: { fields: unknown }) => r.fields as RowFields;
const problemsOf = (r: { problems: unknown }) => r.problems as RowProblem[];
const codes = (r: { problems: unknown }) => problemsOf(r).map((p) => p.code);

const HEADER = ['Firma', 'Contact', 'E-mail', 'Country', 'Website', 'Phone'];
/** Review Focus 2: title row, header on row 3, a blank line inside the data, a total, a repeated header, trailing blanks. */
const EXPO = table({
  Visitors: [
    ['Expo Dubai visitors 2026'],
    [],
    HEADER,
    ['Al Noor Logistics LLC', 'Omar Haddad', 'omar.h@alnoorlogistics.ae', 'United Arab Emirates', 'alnoorlogistics.ae', '+971 4 555 0192'],
    ['Brightline Dental Clinics', 'Dr. Priya Shah', '', 'Canada', '', '+1 416 555 0144'],
    [],
    ['Northgate Retail Group', '', '', '', 'northgateretail.com', ''],
    ['TOTAL VISITORS DAY 2'],
    HEADER,
    ['Kestrel Freight SL', 'Ana Ruiz', 'ana@kestrelfreight.es', 'España', '', ''],
    [],
    ['', ''],
  ],
  Summary: [
    ['Total visitors', '412'],
    ['Countries', '23'],
  ],
});

describe('staging a spreadsheet (Review Focus 2)', () => {
  it('finds the header, sorts rows, and makes totals, blanks and repeated headers Not a lead', async () => {
    const batch = await newBatch();
    const file = await newFile(batch.id);
    await stageTable(file.id, EXPO);
    const rows = await rowsOf(file.id);
    expect(rows.map((r) => [r.sheet, r.originN, r.status, r.include])).toEqual([
      ['Visitors', 4, 'Ready', true],
      ['Visitors', 5, 'Missing details', true],
      ['Visitors', 6, 'Not a lead', false],
      ['Visitors', 7, 'Missing details', true],
      ['Visitors', 8, 'Not a lead', false],
      ['Visitors', 9, 'Not a lead', false],
      ['Visitors', 10, 'Ready', true],
      ['Summary', 1, 'Not a lead', false],
      ['Summary', 2, 'Not a lead', false],
    ]);
    expect(rows.every((r) => r.originKind === 'row')).toBe(true);
    expect(fieldsOf(rows[0])).toEqual({
      companyName: 'Al Noor Logistics LLC', contactName: 'Omar Haddad', email: 'omar.h@alnoorlogistics.ae',
      country: 'United Arab Emirates', website: 'alnoorlogistics.ae', phone: '+971 4 555 0192',
    });
    expect(rows[0].raw).toEqual(EXPO.sheets[0].rows[3]);
    expect(codes(rows[1])).toEqual(['email_missing']);
    expect(codes(rows[3]).sort()).toEqual(['contact_missing', 'contact_missing', 'country_missing']);
    expect(fieldsOf(rows[6]).country).toBe('Spain');

    const after = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect((after.meta as { rows: number }).rows).toBe(9);
    expect(after.questions).toEqual([
      { sheet: 'Visitors', col: 0, header: 'Firma', guess: 'companyName', samples: ['Al Noor Logistics LLC', 'Brightline Dental Clinics', 'Northgate Retail Group'] },
    ]);
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).rowCount).toBe(9);
  });

  it('staging again replaces the file\'s rows', async () => {
    const batch = await newBatch();
    const file = await newFile(batch.id);
    await stageTable(file.id, EXPO);
    await stageTable(file.id, EXPO);
    expect(await prisma.importRow.count({ where: { fileId: file.id } })).toBe(9);
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).rowCount).toBe(9);
  });

  it('the read job stages a spreadsheet it read', async () => {
    const batch = await newBatch();
    const file = await newFile(batch.id, 'visitors.xlsx', 'Reading');
    const data = xlsxBook({ Visitors: [['Visitors 2026'], [], ['Company', 'Country', 'Email'], ['Acme Tools', 'India', 'sales@acmetools.in']] });
    const storagePath = await saveImportFile(batch.id, file.id, data);
    await prisma.importFile.update({ where: { id: file.id }, data: { storagePath } });
    await enqueue(prisma, 'import_read_file', { fileId: file.id }, { maxAttempts: 1 });
    await runOnce({ types: ['import_read_file'], handlers: { import_read_file: importReadFileHandler }, graph: fakeGraph() });
    const after = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.status).toBe('Read');
    expect(after.meta).toMatchObject({ sheets: 1, rows: 1 });
    const rows = await rowsOf(file.id);
    expect(rows.map((r) => [r.originN, r.status, fieldsOf(r)])).toEqual([
      [4, 'Ready', { companyName: 'Acme Tools', country: 'India', email: 'sales@acmetools.in' }],
    ]);
  });
});

const SIMPLE = ['Company', 'Country', 'Website', 'Email', 'Phone'];
async function stageSimple(rows: string[][]) {
  const batch = await newBatch();
  const file = await newFile(batch.id, 'leads.csv');
  await stageTable(file.id, table({ leads: [SIMPLE, ...rows] }));
  return { batch, file, rows: await rowsOf(file.id) };
}

describe('row statuses', () => {
  it('a sheet that starts with data keeps its first row (I-4)', async () => {
    const batch = await newBatch();
    const file = await newFile(batch.id, 'list.csv');
    await stageTable(file.id, table({ list: [['Acme Ltd', 'info@acme.com', 'Spain'], ['Beta SL', 'b@beta.es', 'Spain']] }));
    const rows = await rowsOf(file.id);
    expect(rows.map((r) => [r.originN, fieldsOf(r)])).toEqual([
      [1, { email: 'info@acme.com', country: 'Spain' }],
      [2, { email: 'b@beta.es', country: 'Spain' }],
    ]);
    const after = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect((after.meta as { headers: Record<string, unknown> }).headers.list).toBeNull();
  });

  it('caps raw cells at 2,000 and header cells at 200 characters (M-6)', async () => {
    const batch = await newBatch();
    const file = await newFile(batch.id, 'long.csv');
    await stageTable(file.id, table({ long: [[...SIMPLE, 'H'.repeat(500)], ['Acme', 'India', '', 'a@acme.in', '', 'x'.repeat(5000)]] }));
    const [row] = await rowsOf(file.id);
    expect((row!.raw as string[])[5]).toHaveLength(2000);
    const meta = (await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).meta as { headers: Record<string, string[]> };
    expect(meta.headers.long![5]).toHaveLength(200);
  });

  it('company + country + website only → Missing details, contact_missing', async () => {
    const { rows } = await stageSimple([['Acme Tools', 'India', 'acmetools.in', '', '']]);
    expect(rows[0].status).toBe('Missing details');
    expect(codes(rows[0])).toEqual(['contact_missing', 'contact_missing']);
  });

  it('company + website, no country → Missing details, country_missing', async () => {
    const { rows } = await stageSimple([['Acme Tools', '', 'acmetools.in', 'sales@acmetools.in', '']]);
    expect(rows[0].status).toBe('Missing details');
    expect(codes(rows[0])).toEqual(['country_missing']);
  });

  it('a website domain of an existing company → Already in CRM, unticked', async () => {
    const company = await makeCompany({ name: 'Acme Tools Pvt Ltd', website: 'https://www.acmetools.in', country: 'India' });
    const { rows } = await stageSimple([['Acme', 'India', 'http://acmetools.in/contact', 'sales@acmetools.in', '']]);
    expect(rows[0]).toMatchObject({ status: 'Already in CRM', include: false, matchedCompanyId: company.id });
    expect(problemsOf(rows[0])).toEqual([{ code: 'already_in_crm', level: 'info', value: company.number }]);
  });

  it('a normalised name in the same country → Already in CRM', async () => {
    const company = await makeCompany({ name: 'Meridian Textiles Ltd', country: 'United Kingdom' });
    await makeCompany({ name: 'Meridian Textiles Ltd', country: 'India' });
    const { rows } = await stageSimple([['Meridian Textiles Limited', 'UK', '', 'j.booth@gmail.com', '']]);
    expect(rows[0]).toMatchObject({ status: 'Already in CRM', matchedCompanyId: company.id });
    expect(fieldsOf(rows[0]).country).toBe('United Kingdom');
  });

  it('a country not in the CRM list → Ready with country_unknown', async () => {
    const { rows } = await stageSimple([['Andes Foods', 'Chile', '', 'ventas@andesfoods.cl', '']]);
    expect(rows[0].status).toBe('Ready');
    expect(problemsOf(rows[0])).toEqual([{ code: 'country_unknown', field: 'country', level: 'questionable', value: 'Chile' }]);
  });

  it('research values never change a status', async () => {
    const { batch, rows } = await stageSimple([['Acme Tools', 'India', 'acmetools.in', '', '+91 22 5555 0100']]);
    await prisma.importRow.update({
      where: { id: rows[0].id },
      data: { research: { email: { value: 'sales@acmetools.in', sourceUrl: 'https://acmetools.in', sourceLabel: 'acmetools.in', confidence: 90 } } },
    });
    await refreshBatch(batch.id);
    const row = await prisma.importRow.findUniqueOrThrow({ where: { id: rows[0].id } });
    expect(row.status).toBe('Missing details');
    expect(codes(row)).toEqual(['email_missing']);
  });

  it('refuses a batch over 5,000 rows: file Failed, no rows', async () => {
    const batch = await newBatch();
    const file = await newFile(batch.id, 'big.csv');
    const rows = Array.from({ length: 5001 }, (_, i) => [`Company ${i}`, 'India', '', `a${i}@x${i}.com`, '']);
    await stageTable(file.id, table({ big: [SIMPLE, ...rows] }));
    const after = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.status).toBe('Failed');
    expect(importFileErrorText(after.error!, after.ext, 'en')).toBe('This import would have more than 5,000 rows');
    expect(await prisma.importRow.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it('counts rows already staged from other files of the batch', async () => {
    const batch = await newBatch();
    const first = await newFile(batch.id, 'a.csv');
    await stageTable(first.id, table({ a: [SIMPLE, ...Array.from({ length: 4999 }, (_, i) => [`C${i}`, 'India', '', '', ''])] }));
    const second = await newFile(batch.id, 'b.csv');
    await stageTable(second.id, table({ b: [SIMPLE, ['X', 'India', '', '', ''], ['Y', 'India', '', '', '']] }));
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('Failed');
    expect(await prisma.importRow.count({ where: { batchId: batch.id } })).toBe(4999);
  }, 60_000);
});

describe('companies', () => {
  it('free-mail domains never match or group, even when a CRM company was given one (I-1)', async () => {
    const wrong = await prisma.company.create({
      data: { name: 'Old Mistake', nameNormalised: 'old mistake', country: 'Spain', domain: 'hotmail.es', website: 'hotmail.es' },
    });
    const found = await findExistingCompanies(prisma, [
      { companyName: 'Andes Foods', email: 'pedro@hotmail.es', country: 'Spain' },
      { companyName: 'Andes Foods', website: 'www.hotmail.es', country: 'Spain' },
      { companyName: 'Old Mistake', email: 'x@yahoo.com.mx', country: 'Spain' },
    ]);
    expect(found.map((f) => f?.id ?? null)).toEqual([null, null, wrong.id]);
    for (const email of ['a@hotmail.es', 'b@yahoo.es', 'c@outlook.es', 'd@hotmail.fr', 'e@orange.fr', 'f@wanadoo.fr', 'g@free.fr',
      'h@live.com.mx', 'i@yahoo.com.mx', 'j@prodigy.net.mx', 'k@telefonica.net']) {
      expect(companyKeyOf({ companyName: 'Andes Foods', email, country: 'Spain' }), email).toBe('n:andes foods|spain');
    }
    expect(companyKeyOf({ companyName: 'Andes Foods', website: 'hotmail.es', email: 'ventas@andesfoods.es' })).toBe('d:andesfoods.es');
    const { rows } = await stageSimple([['Brisa Textil', 'Spain', '', 'brisa@hotmail.es', '']]);
    expect(rows[0].status).toBe('Ready');
  });

  it('the migration\'s normalise_company_name equals normaliseCompanyName (M-1)', async () => {
    const names = [
      'Acme S.L.', 'Acme SL', 'Acme S. A.', 'Construcciones Ibéricas S.A. de C.V.', 'Société Générale', 'Dupont SARL',
      'Rossi S.r.l.', 'Müller AG', 'Van Dijk B.V.', 'Acme Corp.', 'Acme Pvt. Ltd.', 'A.Smith Trading', 'J. Booth & Sons',
      'Banco de España', 'Meridian Textiles Limited', 'Northwind Logistics Private Limited', 'Company Group Ltd',
      'Ørsted A/S', 'Straße GmbH', 'Ｆｕｌｌｗｉｄｔｈ Co', 'İstanbul Lojistik', 'Café-Bar "El Niño", S.L.U.', '  Zenith   Retail LLC ',
      'L\'Oréal S.A.', 'Total Care Ltd.', 'x.y.z', 'S.A.', '', 'Ação Ltda', 'Grupo Bimbo, S.A.B. de C.V.',
      'AG Foods', 'NV Energy', 'Sa Pa Travel', 'LP Gas Co', 'KG Logistics', 'Co-op', 'Eurl', 'Lda Imports', 'Company Group Ltd',
      'Acme S.de R.L.', 'Acme S. de R.L. de C.V.', 'Meridian Group', 'Acme Corporation Inc.', 'Corp', 'ltd ltd ltd',
    ];
    for (const name of names) {
      const [row] = await prisma.$queryRaw<{ n: string }[]>`SELECT normalise_company_name(${name}) AS n`;
      expect(row!.n, name).toBe(normaliseCompanyName(name));
      if (name.trim() !== '') expect(normaliseCompanyName(name), name).not.toBe('');
    }
  });

  it('companyKeyOf: domain first, else name + country', () => {
    expect(companyKeyOf({ companyName: 'Acme Ltd', website: 'https://www.acme.com/x' })).toBe('d:acme.com');
    expect(companyKeyOf({ companyName: 'Acme Ltd', email: 'a@acme.com' })).toBe('d:acme.com');
    expect(companyKeyOf({ companyName: 'Acme Ltd', email: 'a@gmail.com', country: 'India' })).toBe('n:acme|india');
    expect(companyKeyOf({ email: 'a@gmail.com' })).toBeNull();
  });

  it('findExistingCompanies keeps the list order; a name without a country needs a single company', async () => {
    const one = await makeCompany({ name: 'Solo Works', country: 'India' });
    await makeCompany({ name: 'Twin Works', country: 'India' });
    await makeCompany({ name: 'Twin Works', country: 'Spain' });
    const site = await makeCompany({ name: 'Site Co', website: 'site.co', country: 'Spain' });
    const found = await findExistingCompanies(prisma, [
      { companyName: 'Twin Works' }, { companyName: 'Solo Works Pvt Ltd' }, { website: 'www.site.co' }, {},
      { companyName: 'Twin Works', country: 'spain' },
    ]);
    expect(found.map((f) => f?.id ?? null)).toEqual([null, one.id, site.id, null, expect.any(Number)]);
    expect(found[4]!.number).not.toBe(one.number);
  });
});

describe('step-2 API', () => {
  async function staged() {
    const { cookie } = await as('MANAGER');
    const batch = await newBatch();
    const file = await newFile(batch.id);
    await stageTable(file.id, EXPO);
    return { cookie, batch, file, rows: await rowsOf(file.id) };
  }

  it('lists rows with tiles, From and the open question', async () => {
    const { cookie, batch, file } = await staged();
    const res = await json('GET', `/api/imports/batches/${batch.id}/rows`, cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(9);
    expect(body.tiles).toEqual({ rows: 9, files: 1, ready: 2, missing: 2, already: 0, notLead: 5, update: 0 });
    expect(body.items[0]).toMatchObject({
      status: 'Ready', include: true, from: 'Expo xlsx · row 4', fileName: 'Expo-Dubai-visitors.xlsx', matched: null,
      origin: { word: 'Expo', ext: 'xlsx', kind: 'row', n: 4 },
    });
    // The ticked rows of the filter (the header tick), across every page.
    expect(body.included).toBe(await prisma.importRow.count({ where: { batchId: batch.id, include: true } }));
    expect(body.question).toEqual({
      sheet: 'Visitors', col: 0, header: 'Firma', guess: 'companyName', fileId: file.id, fileName: 'Expo-Dubai-visitors.xlsx',
      samples: ['Al Noor Logistics LLC', 'Brightline Dental Clinics', 'Northgate Retail Group'],
    });
    const page2 = await json('GET', `/api/imports/batches/${batch.id}/rows?pageSize=2&page=2`, cookie);
    expect(page2.json()).toMatchObject({ total: 9, included: body.included });
    expect(page2.json().items).toHaveLength(2);
    const missing = await json('GET', `/api/imports/batches/${batch.id}/rows?filter=missing`, cookie);
    expect(missing.json()).toMatchObject({ total: 2, included: 2 });
    expect(missing.json().items.map((r: { fields: RowFields }) => r.fields.companyName)).toEqual(['Brightline Dental Clinics', 'Northgate Retail Group']);
    const search = await json('GET', `/api/imports/batches/${batch.id}/rows?q=kestrel`, cookie);
    expect(search.json().total).toBe(1);
  });

  it('answering "skip" stores ignore and empties that column\'s field', async () => {
    const { cookie, file, rows } = await staged();
    const res = await json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'Visitors', col: 0, field: 'skip' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ done: 'skip' });
    const after = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect((after.columnMap as Record<string, string>)[columnKey('Visitors', 0)]).toBe('ignore');
    expect(after.questions).toEqual([]);
    const row = await prisma.importRow.findUniqueOrThrow({ where: { id: rows[0].id } });
    expect(fieldsOf(row).companyName).toBeUndefined();
    expect(row.status).toBe('Missing details');
    expect(codes(row)).toEqual(['company_missing']);
  });

  it('answering "Firma" with contactName re-sorts the file, keeping an edited cell', async () => {
    const { cookie, file, rows } = await staged();
    const edit = await json('PATCH', `/api/imports/rows/${rows[1].id}`, cookie, { field: 'companyName', value: 'Brightline Dental' });
    expect(edit.statusCode).toBe(200);
    const res = await json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'Visitors', col: 0, field: 'contactName' });
    expect(res.json()).toEqual({ done: 'contactName' });
    const after = await rowsOf(file.id);
    expect(fieldsOf(after[0])).toMatchObject({ contactName: 'Al Noor Logistics LLC' });
    expect(fieldsOf(after[0]).companyName).toBeUndefined();
    expect(fieldsOf(after[1])).toMatchObject({ companyName: 'Brightline Dental', contactName: 'Brightline Dental Clinics' });
    expect(after[1].edited).toEqual(['companyName']);
    // "Contact" already held the contact: it is asked about now (M-4); answering it never re-asks Firma.
    const file1 = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(file1.questions).toEqual([
      { sheet: 'Visitors', col: 1, header: 'Contact', guess: 'contactName', samples: ['Omar Haddad', 'Dr. Priya Shah', 'Ana Ruiz'] },
    ]);
    await json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'Visitors', col: 1, field: 'contactName' });
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).questions).toEqual([]);
    // A total in the contact column is still not a lead (nothing to reach), a repeated header still is.
    expect(after[4].status).toBe('Not a lead');
    expect(after[5].status).toBe('Not a lead');
  });

  it('an answer for a column with no open question → 404', async () => {
    const { cookie, file } = await staged();
    const res = await json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'Visitors', col: 3, field: 'city' });
    expect(res.statusCode).toBe(404);
  });

  it('Include all on Missing details unticks only those rows', async () => {
    const { cookie, batch, file } = await staged();
    const res = await json('POST', `/api/imports/batches/${batch.id}/include`, cookie, { filter: 'missing', include: false });
    expect(res.json()).toEqual({ changed: 2 });
    const rows = await rowsOf(file.id);
    expect(rows.filter((r) => r.include).map((r) => r.status)).toEqual(['Ready', 'Ready']);
    expect(rows.filter((r) => r.status === 'Missing details').every((r) => !r.include && r.includeTouched)).toBe(true);
    // The header tick reads the whole filter: none ticked in Missing details now, some in All.
    const view = await json('GET', `/api/imports/batches/${batch.id}/rows?filter=missing&pageSize=1`, cookie);
    expect(view.json()).toMatchObject({ total: 2, included: 0 });
    const all = await json('POST', `/api/imports/batches/${batch.id}/include`, cookie, { filter: 'all', include: true });
    expect(all.statusCode).toBe(200);
    const every = await json('GET', `/api/imports/batches/${batch.id}/rows?pageSize=1`, cookie);
    expect(every.json()).toMatchObject({ total: 9, included: 9 });
  });

  it('editing the email of a Missing details row makes it Ready; a touched tick is kept', async () => {
    const { cookie, rows } = await staged();
    const untick = await json('PATCH', `/api/imports/rows/${rows[1].id}`, cookie, { include: false });
    expect(untick.json()).toMatchObject({ include: false });
    const res = await json('PATCH', `/api/imports/rows/${rows[1].id}`, cookie, { field: 'email', value: 'priya@brightlinedental.ca' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'Ready', include: false, problems: [] });
    const row = await prisma.importRow.findUniqueOrThrow({ where: { id: rows[1].id } });
    expect(row.edited).toEqual(['email']);
  });

  it('sort: refuses while a file is Reading or with no rows, then moves to Sorting', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const empty = await newBatch();
    expect((await json('POST', `/api/imports/batches/${empty.id}/sort`, cookie)).json()).toEqual({ error: 'no_rows' });
    const batch = await newBatch();
    const file = await newFile(batch.id);
    await stageTable(file.id, EXPO);
    const reading = await newFile(batch.id, 'later.csv', 'Reading');
    const busy = await json('POST', `/api/imports/batches/${batch.id}/sort`, cookie);
    expect([busy.statusCode, busy.json()]).toEqual([409, { error: 'files_reading' }]);
    await prisma.importFile.update({ where: { id: reading.id }, data: { status: 'Failed' } });
    const ok = await json('POST', `/api/imports/batches/${batch.id}/sort`, cookie);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'Sorting' });
  });

  it('rematch picks up a country added to the CRM list and a company created since', async () => {
    const { cookie, batch, file } = await (async () => {
      const { cookie } = await as('ADMINISTRATOR');
      const batch = await newBatch('Sorting');
      const file = await newFile(batch.id, 'leads.csv');
      await stageTable(file.id, table({ leads: [SIMPLE, ['Andes Foods', 'Chile', '', 'ventas@andesfoods.cl', ''], ['Acme', 'India', 'acmetools.in', 'a@acmetools.in', '']] }));
      return { cookie, batch, file };
    })();
    await prisma.lookupValue.create({ data: { group: 'country', value: 'Chile', label: 'Chile', sortOrder: 99 } });
    const company = await makeCompany({ name: 'Acme Tools', website: 'acmetools.in', country: 'India' });
    const res = await json('POST', `/api/imports/batches/${batch.id}/rematch`, cookie);
    expect(res.statusCode).toBe(200);
    const rows = await rowsOf(file.id);
    expect([rows[0].status, problemsOf(rows[0])]).toEqual(['Ready', []]);
    expect(rows[1]).toMatchObject({ status: 'Already in CRM', matchedCompanyId: company.id, include: false });
  });

  it('"Add these countries": a corrected spelling maps the batch\'s rows, an inactive country is switched back on, case-insensitive', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch('Sorting');
    const file = await newFile(batch.id, 'leads.csv');
    await stageTable(file.id, table({ leads: [SIMPLE,
      ['Andes Foods', 'chile', '', 'ventas@andesfoods.cl', ''],
      ['Azteca SA', 'Mexiko', '', 'hola@azteca.mx', ''],
      ['Norte SA', 'MEXIKO', '', 'hola@norte.mx', ''],
    ] }));
    const off = await prisma.lookupValue.create({ data: { group: 'country', value: 'Chile', label: 'Chile', sortOrder: 99, isActive: false } });
    expect((await rowsOf(file.id)).map((r) => r.status)).toEqual(['Ready', 'Ready', 'Ready']);
    expect((await rowsOf(file.id)).every((r) => problemsOf(r).some((p) => p.code === 'country_unknown'))).toBe(true);

    const res = await json('POST', `/api/imports/batches/${batch.id}/countries`, cookie, {
      countries: [{ from: 'chile', to: 'CHILE' }, { from: 'Mexiko', to: 'Mexico' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().countries).toEqual(['Chile', 'Mexico']);
    // The existing (switched off) Chile is reused and switched on, not duplicated; Mexico is added once.
    expect(await prisma.lookupValue.findUniqueOrThrow({ where: { id: off.id } })).toMatchObject({ isActive: true, value: 'Chile' });
    expect(await prisma.lookupValue.count({ where: { group: 'country', value: { in: ['Chile', 'CHILE', 'chile'], mode: 'insensitive' } } })).toBe(1);
    expect(await prisma.lookupValue.count({ where: { group: 'country', value: 'Mexico' } })).toBe(1);
    const rows = await rowsOf(file.id);
    // Both spellings of the corrected country now read "Mexico" (an edit, kept on re-sorts) and match.
    expect(rows.map((r) => fieldsOf(r).country)).toEqual(['Chile', 'Mexico', 'Mexico']);
    expect(rows[1]!.edited).toEqual(['country']);
    expect(rows.every((r) => problemsOf(r).length === 0)).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityType: 'lookup_value' } })).toBe(2);
  });

  it('"Add these countries" needs manage_lookups (a Manager → 403)', async () => {
    const { cookie } = await as('MANAGER');
    const batch = await newBatch('Sorting');
    const res = await json('POST', `/api/imports/batches/${batch.id}/countries`, cookie, { countries: [{ from: 'X', to: 'Y' }] });
    expect(res.statusCode).toBe(403);
  });

  it('edits are refused from Importing on', async () => {
    const { cookie, batch, file, rows } = await staged();
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Importing' } });
    const responses = await Promise.all([
      json('PATCH', `/api/imports/rows/${rows[0].id}`, cookie, { include: false }),
      json('POST', `/api/imports/batches/${batch.id}/include`, cookie, { filter: 'all', include: false }),
      json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'Visitors', col: 0, field: 'skip' }),
      json('POST', `/api/imports/batches/${batch.id}/sort`, cookie),
      json('POST', `/api/imports/batches/${batch.id}/rematch`, cookie),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([409, 409, 409, 409, 409]);
    expect(responses.map((r) => r.json().error)).toEqual(Array(5).fill('batch_locked'));
    // Reading still works.
    expect((await json('GET', `/api/imports/batches/${batch.id}/rows`, cookie)).statusCode).toBe(200);
  });

  it('a tick and an edit made during a re-evaluation are kept (I-3)', async () => {
    const { batch, rows } = await staged();
    stageHooks.beforeEvaluationWrite = async () => {
      stageHooks.beforeEvaluationWrite = undefined;
      await updateRow(rows[0].id, { include: false });
      await updateRow(rows[1].id, { field: 'email', value: 'priya@brightlinedental.ca' });
    };
    await refreshBatch(batch.id);
    const [a, b] = await Promise.all([rows[0].id, rows[1].id].map((id) => prisma.importRow.findUniqueOrThrow({ where: { id } })));
    expect([a!.include, a!.includeTouched]).toEqual([false, true]);
    expect([fieldsOf(b!).email, b!.status]).toEqual(['priya@brightlinedental.ca', 'Ready']);
  });

  it('an untouched tick still follows a new status during the same refresh (I-3)', async () => {
    const { batch, rows } = await staged();
    await makeCompany({ name: 'Al Noor', website: 'alnoorlogistics.ae', country: 'United Arab Emirates' });
    await refreshBatch(batch.id);
    expect(await prisma.importRow.findUniqueOrThrow({ where: { id: rows[0].id } })).toMatchObject({ status: 'Already in CRM', include: false });
  });

  it('an edit made while a file is re-sorted wins (I-3)', async () => {
    const { file, rows } = await staged();
    await prisma.importFile.update({ where: { id: file.id }, data: { columnMap: { [columnKey('Visitors', 0)]: 'ignore', [columnKey('Visitors', 2)]: 'email' } } });
    stageHooks.beforeResortWrite = async () => {
      stageHooks.beforeResortWrite = undefined;
      await applyRowEdit(rows[0].id, { field: 'city', value: 'Dubai' });
    };
    await resortFile(file.id);
    expect(fieldsOf(await prisma.importRow.findUniqueOrThrow({ where: { id: rows[0].id } })))
      .toEqual({ email: 'omar.h@alnoorlogistics.ae', city: 'Dubai' });
  });

  it('two quick edits of one row both stay (I-3)', async () => {
    const { cookie, rows } = await staged();
    await Promise.all([
      json('PATCH', `/api/imports/rows/${rows[1].id}`, cookie, { field: 'email', value: 'priya@brightlinedental.ca' }),
      json('PATCH', `/api/imports/rows/${rows[1].id}`, cookie, { field: 'city', value: 'Toronto' }),
      json('PATCH', `/api/imports/rows/${rows[1].id}`, cookie, { field: 'designation', value: 'Owner' }),
    ]);
    const row = await prisma.importRow.findUniqueOrThrow({ where: { id: rows[1].id } });
    expect(fieldsOf(row)).toMatchObject({ email: 'priya@brightlinedental.ca', city: 'Toronto', designation: 'Owner' });
    expect([...(row.edited as string[])].sort()).toEqual(['city', 'designation', 'email']);
    expect(row.status).toBe('Ready');
  });

  it('two answers at once both stay (M-3)', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch();
    const file = await newFile(batch.id, 'two.csv');
    await stageTable(file.id, table({ two: [['Firma', 'Nombre', 'Email'], ['Acme', 'Ana', 'a@acme.es']] }));
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).questions).toHaveLength(2);
    await Promise.all([
      json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'two', col: 0, field: 'companyName' }),
      json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'two', col: 1, field: 'skip' }),
    ]);
    const after = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.questions).toEqual([]);
    expect(after.columnMap).toMatchObject({ [columnKey('two', 0)]: 'companyName', [columnKey('two', 1)]: 'ignore' });
  });

  it('confirming a duplicate column\'s guess asks nothing more (N-2)', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch();
    const file = await newFile(batch.id, 'phones.csv');
    await stageTable(file.id, table({ phones: [['Company', 'Phone', 'Phone'], ['Acme', '+34 91 555 0100', '+34 600 555 010']] }));
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).questions).toMatchObject([{ col: 2, guess: 'phone' }]);
    await json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'phones', col: 2, field: 'phone' });
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).questions).toEqual([]);
  });

  it('an edit waiting on the batch lock is refused once the batch went to Importing (N-5)', async () => {
    const { cookie, batch, rows } = await staged();
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const starter = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM import_batches WHERE id = ${batch.id} FOR UPDATE`;
      await tx.importBatch.update({ where: { id: batch.id }, data: { status: 'Importing' } });
      locked();
      await held;
    }, { timeout: 20_000 });
    await lockTaken;
    const edit = json('PATCH', `/api/imports/rows/${rows[1].id}`, cookie, { field: 'email', value: 'late@brightline.ca' });
    const tick = json('POST', `/api/imports/batches/${batch.id}/include`, cookie, { filter: 'all', include: false });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await starter;
    expect([(await edit).statusCode, (await tick).statusCode]).toEqual([409, 409]);
    const row = await prisma.importRow.findUniqueOrThrow({ where: { id: rows[1].id } });
    expect(fieldsOf(row).email).toBeUndefined();
    expect(await prisma.importRow.count({ where: { batchId: batch.id, includeTouched: true } })).toBe(0);
  });

  it('Sales Representatives get 403', async () => {
    const { batch, file, rows } = await staged();
    const { cookie } = await as('SALES_REPRESENTATIVE');
    const responses = await Promise.all([
      json('GET', `/api/imports/batches/${batch.id}/rows`, cookie),
      json('PATCH', `/api/imports/rows/${rows[0].id}`, cookie, { include: false }),
      json('POST', `/api/imports/batches/${batch.id}/include`, cookie, { filter: 'all', include: false }),
      json('POST', `/api/imports/files/${file.id}/columns`, cookie, { sheet: 'Visitors', col: 0, field: 'skip' }),
      json('POST', `/api/imports/batches/${batch.id}/sort`, cookie),
      json('POST', `/api/imports/batches/${batch.id}/rematch`, cookie),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403, 403]);
  });

  it('unknown batch, row or file → 404', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    expect((await json('GET', '/api/imports/batches/999999/rows', cookie)).statusCode).toBe(404);
    expect((await json('PATCH', '/api/imports/rows/999999', cookie, { include: true })).statusCode).toBe(404);
    expect((await json('POST', '/api/imports/files/999999/columns', cookie, { sheet: 'x', col: 0, field: 'skip' })).statusCode).toBe(404);
  });
});
