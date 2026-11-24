/* Download all leads + update through Import leads (spec 2026-11-24-leads-export-design.md). */
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { Company, Lead, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importColumnLabel, roleLabel, type Lang, type RowChanges } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import type { AuthUser } from '../src/plugins/auth';
import { EXPORT_COLUMNS } from '../src/imports/leadsExport';
import { classifyColumns, matchHeader } from '../src/imports/columns';
import { readSpreadsheet } from '../src/imports/read/index';
import { knownCountries, stageTable } from '../src/imports/stage';
import { fixRows, rowsToFixWorkbook } from '../src/imports/exports';
import { companyNumberOf, leadNumberOf, planUpdate, resolveTargets, sameValue } from '../src/imports/updates';
import { importCommitHandler } from '../src/jobs/handlers/importCommit';
import { runOnce } from '../src/jobs/runner';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());

let admin: User;
let cookie: string;
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Admin' });
  cookie = await signIn(app, admin);
});

const authOf = (u: User): AuthUser => ({
  id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat,
});
const get = (url: string, c = cookie) => app.inject({ method: 'GET', url, headers: { cookie: c } });
const post = (url: string, payload: unknown, c = cookie) => app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie: c } });

async function sheetOf(buf: Buffer | string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((typeof buf === 'string' ? Buffer.from(buf, 'binary') : buf) as unknown as ExcelJS.Buffer);
  return wb.worksheets[0]!;
}
const colOf = (key: (typeof EXPORT_COLUMNS)[number]) => EXPORT_COLUMNS.indexOf(key) + 1;
/** Every data row of the export, keyed by Lead ID. */
function rowsByLead(ws: ExcelJS.Worksheet): Map<string, ExcelJS.Row> {
  const out = new Map<string, ExcelJS.Row>();
  ws.eachRow((row, n) => { if (n > 1) out.set(String(row.getCell(colOf('leadId')).value), row); });
  return out;
}
async function exportNow(query = '', c = cookie) {
  const res = await app.inject({ method: 'GET', url: `/api/leads/export.xlsx${query}`, headers: { cookie: c } });
  return res;
}

describe('Download all leads · content', () => {
  it('Lead ID, Company ID, the import columns and context columns; CRM values as shown; formula guard; archived left out', async () => {
    const owner = await makeUser({ name: 'Carlos Ruiz' });
    const company = await makeCompany({ name: 'Hotel Sol', website: 'https://hotelsol.es', city: 'Madrid', country: 'Spain' });
    await prisma.company.update({ where: { id: company.id }, data: { industry: 'Hospitality' } });
    const contact = await makeContact({ companyId: company.id, firstName: 'Ana', lastName: 'García', businessEmail: 'ana@hotelsol.es' });
    await prisma.contact.update({ where: { id: contact.id }, data: { designation: 'Owner' } });
    const lead = await makeLead({
      companyId: company.id, contactId: contact.id, companyName: 'Hotel Sol', country: 'Spain', phone: '+34 600 111 222',
      assignedToId: owner.id, notes: '=HYPERLINK("http://evil")', outreachLanguage: 'es', importBatch: 'IMPORT-2026-11-20',
    });
    const archived = await makeLead({ companyName: 'Gone Co', archivedAt: new Date() });

    const res = await exportNow();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.xlsx"/);
    const ws = await sheetOf(res.rawPayload);
    const header = ws.getRow(1);
    expect(EXPORT_COLUMNS.map((_, i) => header.getCell(i + 1).value)).toEqual([
      'Lead ID', 'Company ID', 'Company', 'Website', 'Country', 'City', 'Contact', 'Designation', 'Email', 'Phone', 'Industry', 'Notes',
      'Status', 'Assigned to', 'Language', 'Lead type', 'Source',
    ]);
    expect(header.getCell(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const rows = rowsByLead(ws);
    expect([...rows.keys()]).toEqual([lead.number]);
    expect(rows.has(archived.number)).toBe(false);
    const r = rows.get(lead.number)!;
    const cell = (k: (typeof EXPORT_COLUMNS)[number]) => r.getCell(colOf(k)).value;
    expect(cell('companyId')).toBe(company.number);
    expect(cell('website')).toBe('https://hotelsol.es'); // the company's, the lead has none
    expect(cell('city')).toBe('Madrid');
    expect(cell('contactName')).toBe('Ana García');
    expect(cell('designation')).toBe('Owner');
    expect(cell('email')).toBe('ana@hotelsol.es'); // the contact's
    expect(cell('phone')).toBe('+34 600 111 222');
    expect(cell('industry')).toBe('Hospitality');
    expect(cell('notes')).toBe('\'=HYPERLINK("http://evil")'); // guarded
    expect(cell('assignedTo')).toBe('Carlos Ruiz');
    expect(cell('language')).toBe('Spanish');
    expect(cell('source')).toBe('Import · IMPORT-2026-11-20');

    // Archived shown in the list → exported too.
    const all = rowsByLead(await sheetOf((await exportNow('?archived=1')).rawPayload));
    expect(all.has(archived.number)).toBe(true);
  });

  it('follows the list\'s current filters and search; headers in the downloader\'s language', async () => {
    const a = await makeLead({ companyName: 'Alpha Freight', status: 'New' });
    const b = await makeLead({ companyName: 'Beta Foods', status: 'Contacted' });
    expect([...rowsByLead(await sheetOf((await exportNow('?q=alpha')).rawPayload)).keys()]).toEqual([a.number]);
    expect([...rowsByLead(await sheetOf((await exportNow('?status=Contacted')).rawPayload)).keys()]).toEqual([b.number]);
    await prisma.user.update({ where: { id: admin.id }, data: { language: 'es' } });
    const es = await sheetOf((await exportNow()).rawPayload);
    expect(es.getRow(1).getCell(1).value).toBe('ID del lead');
    expect(es.getRow(1).getCell(colOf('companyId')).value).toBe('ID de empresa');
  });

  it('Administrators and Managers only (import_leads); a Sales Representative gets 403', async () => {
    await makeLead();
    const manager = await makeUser({ role: 'MANAGER' });
    expect((await exportNow('', await signIn(app, manager))).statusCode).toBe(200);
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    expect((await exportNow('', await signIn(app, rep))).statusCode).toBe(403);
    const research = await makeUser({ role: 'DATA_RESEARCH_USER' });
    expect((await exportNow('', await signIn(app, research))).statusCode).toBe(403);
  });

  it('more than 20,000 leads: 400 too_many_rows with the count (narrow the filter)', async () => {
    await prisma.$executeRaw`
      INSERT INTO leads (company_name, country, lead_source, updated_at)
      SELECT 'Bulk ' || g, 'India', 'Manual Entry', now() FROM generate_series(1, 20001) AS g`;
    const res = await exportNow();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'too_many_rows', total: 20001 });
    expect((await exportNow('?q=Bulk%2020001')).statusCode).toBe(200);
  }, 60_000);
});

describe('Import leads · the matcher knows Lead ID and Company ID', () => {
  it.each(['en', 'es', 'fr'] as Lang[])('%s headers', (lang) => {
    expect(matchHeader(importColumnLabel('leadId', lang))).toEqual({ target: 'leadId', strength: 'strong' });
    expect(matchHeader(importColumnLabel('companyId', lang))).toEqual({ target: 'companyId', strength: 'strong' });
    for (const k of ['status', 'assignedTo', 'language', 'leadType', 'source', 'leadPage'] as const) {
      expect(matchHeader(importColumnLabel(k, lang))?.target, k).toBe('ignore');
    }
    const header = EXPORT_COLUMNS.map((k) => importColumnLabel(k, lang));
    const { map, questions } = classifyColumns(header, header.map(() => ['LD-1001']), []);
    expect(questions).toEqual([]);
    expect(map.slice(0, 2)).toEqual(['leadId', 'companyId']);
    expect(map.slice(-5)).toEqual(['ignore', 'ignore', 'ignore', 'ignore', 'ignore']);
  });

  it('id cells in any form; normalised comparisons', () => {
    expect(leadNumberOf(' ld 1001 ')).toBe('LD-1001');
    expect(leadNumberOf('1001')).toBeNull();
    expect(companyNumberOf('co-42')).toBe('CO-0042');
    expect(sameValue('website', 'https://www.sol.es/', 'sol.es', [])).toBe(true);
    expect(sameValue('email', 'Ana@Sol.es', 'ana@sol.es ', [])).toBe(true);
    expect(sameValue('phone', '+34 600 111 222', '0034-600111222', [])).toBe(true);
    expect(sameValue('country', 'United Kingdom', 'UK', ['United Kingdom'])).toBe(true);
    expect(sameValue('contactName', 'Dr. Ana García', 'ana garcia', [])).toBe(true);
    expect(sameValue('city', 'Leeds', 'York', [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The round trip: export → fill blanks, change a value → upload → import → undo

let seq = 0;
/** Stages a workbook buffer into a new batch (as step 1 would) and returns the batch. */
async function stage(buf: Buffer, name = 'leads.xlsx') {
  seq += 1;
  const batch = await prisma.importBatch.create({
    data: { number: `IMPORT-2026-11-25-${seq + 300}`, language: 'en', leadType: 'Lead', status: 'Sorting', createdById: admin.id },
  });
  const file = await prisma.importFile.create({ data: { batchId: batch.id, name, ext: 'xlsx', size: buf.length, storagePath: '', status: 'Reading' } });
  const read = await readSpreadsheet(buf, 'xlsx');
  if (read.extract?.kind !== 'table') throw new Error('table expected');
  await stageTable(file.id, read.extract);
  return batch;
}
const runJob = () => runOnce({ types: ['import_commit'], handlers: { import_commit: importCommitHandler }, graph: fakeGraph() });
const rowsOf = (batchId: number) => prisma.importRow.findMany({ where: { batchId }, orderBy: { position: 'asc' } });

type World = { a: Company; b: Company; l1: Lead; l2: Lead; hidden: Lead; rep: User };
async function world(): Promise<World> {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Rita Rep' });
  const other = await makeUser({ name: 'Otto Other' });
  const a = await makeCompany({ name: 'Acme Freight', country: 'United Kingdom' });
  const ana = await makeContact({ companyId: a.id, firstName: 'Ana', lastName: 'Smith', businessEmail: 'ana@acme.test' });
  const l1 = await makeLead({
    companyId: a.id, contactId: ana.id, companyName: 'Acme Freight', country: 'United Kingdom', businessEmail: 'ana@acme.test',
    phone: '+44 20 1234 5678', assignedToId: rep.id,
  });
  const b = await makeCompany({ name: 'Beta Retail', country: 'United Kingdom' });
  // A verified industry (release-4 golden rule): never touched.
  await prisma.company.update({ where: { id: b.id }, data: { industry: 'Retail', verifiedFields: { industry: true } } });
  const l2 = await makeLead({ companyId: b.id, companyName: 'Beta Retail', country: 'United Kingdom', assignedToId: rep.id });
  const hidden = await makeLead({ companyName: 'Other Co', country: 'United Kingdom', assignedToId: other.id });
  return { a, b, l1, l2, hidden, rep };
}

/** The export, edited as a person would: blanks filled, one value changed, an unknown and a mismatched id, a new row. */
async function editedExport(w: World): Promise<Buffer> {
  const ws0 = await sheetOf((await exportNow()).rawPayload);
  const rows = rowsByLead(ws0);
  const set = (lead: Lead, key: (typeof EXPORT_COLUMNS)[number], v: string) => { rows.get(lead.number)!.getCell(colOf(key)).value = v; };
  set(w.l1, 'website', 'acme.test'); // blank → lead + company (+ domain)
  set(w.l1, 'city', 'Leeds'); // blank → lead + company
  set(w.l1, 'designation', 'CEO'); // blank → contact
  set(w.l1, 'email', 'ANA@acme.test'); // the same, normalised → nothing
  set(w.l1, 'phone', '+44 20 9999 0000'); // differs → conflict
  set(w.l1, 'notes', 'Met at the expo'); // blank → lead
  set(w.l1, 'status', 'Won'); // read-only: ignored
  set(w.l2, 'industry', 'Logistics & Supply Chain'); // verified Retail → conflict
  set(w.l2, 'contactName', 'Bob Stone'); // the lead has none → a new contact
  set(w.l2, 'designation', 'Buyer');
  const ws = ws0;
  const add = (cells: Partial<Record<(typeof EXPORT_COLUMNS)[number], string>>) => {
    const row = ws.getRow(ws.rowCount + 1);
    for (const [k, v] of Object.entries(cells)) row.getCell(colOf(k as (typeof EXPORT_COLUMNS)[number])).value = v;
  };
  add({ leadId: 'LD-99999', companyName: 'Ghost Co', country: 'Spain' });
  add({ leadId: w.l1.number, companyId: w.b.number, companyName: 'Acme Freight', country: 'United Kingdom' });
  add({ companyName: 'New Co', country: 'United Kingdom', email: 'hi@newco.test', contactName: 'Nia New' });
  return Buffer.from(await ws.workbook.xlsx.writeBuffer());
}

describe('Import leads · update rows', () => {
  it('stages update rows, counts them in step 4, fills blanks only, reports conflicts, creates new rows normally', async () => {
    const w = await world();
    const batch = await stage(await editedExport(w));
    const rows = await rowsOf(batch.id);
    const byCompany = new Map(rows.map((r) => [`${(r.fields as Record<string, string>).leadId ?? ''}|${(r.fields as Record<string, string>).companyName}`, r]));
    expect(rows.map((r) => r.status)).toEqual(['Update', 'Update', 'Update', 'Missing details', 'Missing details', 'Ready']);
    const hiddenRow = byCompany.get(`${w.hidden.number}|Other Co`)!;
    expect(hiddenRow.status).toBe('Update'); // an Administrator sees every lead
    const ghost = byCompany.get('LD-99999|Ghost Co')!;
    expect(ghost.problems).toEqual([{ code: 'lead_not_found', level: 'missing', value: 'LD-99999' }]);
    expect(ghost.include).toBe(false);
    const mismatch = rows[4]!;
    expect(mismatch.problems).toEqual([{ code: 'company_mismatch', level: 'missing', value: w.b.number, crm: w.a.number }]);
    // The batch's tiles and filter count update rows.
    const list = (await get(`/api/imports/batches/${batch.id}/rows?filter=update`)).json();
    expect(list).toMatchObject({ total: 3, tiles: { update: 3 } });

    const review = await get(`/api/imports/batches/${batch.id}/review?acceptHigh=0&noContactRows=import`);
    expect(review.statusCode, review.body).toBe(200);
    // l1: website, city, designation, notes (4); l2: contact + designation (2); the hidden lead: nothing changed.
    expect(review.json()).toMatchObject({ willImport: 1, updates: { rows: 3, fields: 6, conflicts: 2, errors: 2 } });

    const before = await prisma.lead.findUniqueOrThrow({ where: { id: w.l1.id } });
    const res = await post(`/api/imports/batches/${batch.id}/import`, { acceptHigh: false, noContactRows: 'import', notify: false });
    expect(res.statusCode, res.body).toBe(202);
    expect(await runJob()).toBe(true);

    const l1 = await prisma.lead.findUniqueOrThrow({ where: { id: w.l1.id }, include: { contact: true, company: true } });
    expect(l1).toMatchObject({ website: 'https://acme.test', city: 'Leeds', notes: 'Met at the expo', status: before.status });
    expect(l1.phone).toBe('+44 20 1234 5678'); // NOT overwritten
    expect(l1.businessEmail).toBe('ana@acme.test');
    expect(l1.company).toMatchObject({ website: 'https://acme.test', domain: 'acme.test', city: 'Leeds' });
    expect(l1.contact).toMatchObject({ designation: 'CEO' });
    const b = await prisma.company.findUniqueOrThrow({ where: { id: w.b.id } });
    expect(b.industry).toBe('Retail'); // verified: never touched
    const l2 = await prisma.lead.findUniqueOrThrow({ where: { id: w.l2.id }, include: { contact: true } });
    expect(l2.contact).toMatchObject({ firstName: 'Bob', lastName: 'Stone', designation: 'Buyer', companyId: w.b.id });

    // Audited like a manual edit, by the importer, with the batch as the source.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'lead', entityId: String(w.l1.id), action: 'update' } });
    expect(audit.userId).toBe(admin.id);
    expect(audit.after).toMatchObject({ website: 'https://acme.test', source: `Import · ${batch.number}` });
    expect(audit.before).toMatchObject({ website: null });

    // The export lists newest first: the hidden lead, l2, l1; then the rows added by hand.
    const after = await rowsOf(batch.id);
    expect(after.map((r) => r.outcome)).toEqual(['Updated', 'Updated', 'Updated', 'Error', 'Error', 'Imported']);
    expect(after[3]).toMatchObject({ outcomeCode: 'lead_not_found', leadId: null });
    const changesOf = (lead: Lead) => after.find((r) => r.leadId === lead.id && r.outcome === 'Updated')!.changes as unknown as RowChanges;
    expect(changesOf(w.l1).conflicts).toEqual([{ field: 'phone', crm: '+44 20 1234 5678', file: '+44 20 9999 0000' }]);
    expect(changesOf(w.l2).conflicts).toEqual([{ field: 'industry', crm: 'Retail', file: 'Logistics & Supply Chain' }]);
    expect(changesOf(w.hidden)).toEqual({ filled: [], conflicts: [], createdContact: null });
    // The new row became a new lead as usual; no lead was created for the unknown id.
    expect(await prisma.lead.count({ where: { companyName: 'New Co' } })).toBe(1);
    expect(await prisma.lead.count({ where: { companyName: 'Ghost Co' } })).toBe(0);

    const detail = (await get(`/api/imports/batches/${batch.id}`)).json();
    expect(detail).toMatchObject({ status: 'Imported', counts: { imported: 1, updated: 3, errors: 2, skipped: 0, conflicts: 2 } });
    const list2 = (await get('/api/imports/batches')).json();
    expect(list2.items[0]).toMatchObject({ importedCount: 1, updatedCount: 3 });

    // Rows to fix: the conflicts (amber, both values, the lead's page) and the id errors.
    const fix = await fixRows(batch.id);
    expect(fix.map((r) => [r.fields.leadId ?? r.fields.companyName, r.problems.map((p) => p.code)])).toEqual([
      [w.l2.number, ['update_conflict']], [w.l1.number, ['update_conflict']], ['LD-99999', ['lead_not_found']], [w.l1.number, ['company_mismatch']],
    ]);
    for (const [lang, text] of [
      ['en', 'Phone: CRM has +44 20 1234 5678, file has +44 20 9999 0000 — update on the lead page if correct'],
      ['es', 'Teléfono: el CRM tiene +44 20 1234 5678, el archivo tiene +44 20 9999 0000 — actualízalo en la página del lead si es correcto'],
      ['fr', 'Téléphone : le CRM a +44 20 1234 5678, le fichier a +44 20 9999 0000 — mettez à jour sur la page du lead si c’est correct'],
    ] as const) {
      const ws = await sheetOf(await rowsToFixWorkbook(batch.id, lang));
      const header = (ws.getRow(1).values as unknown[]).slice(1);
      const col = (key: string) => header.indexOf(importColumnLabel(key as never, lang)) + 1;
      const r = ws.getRow(3); // l2's conflict is row 2, l1's row 3
      expect(r.getCell(col('whatToFix')).value).toBe(text);
      expect(r.getCell(col('phone')).value).toBe('+44 20 9999 0000');
      expect((r.getCell(col('phone')).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFF1E0');
      expect(r.getCell(col('leadId')).value).toBe(w.l1.number);
      expect(r.getCell(col('leadPage')).value).toMatchObject({ hyperlink: `http://localhost:5173/leads/${w.l1.id}` });
    }
  });

  it('a Lead ID the uploader cannot see is an error ("not yours"); Company ID only updates the company', async () => {
    const w = await world();
    const rep = authOf(w.rep);
    const hiddenCompany = await prisma.company.findUniqueOrThrow({ where: { id: w.hidden.companyId! } });
    const [visible, hidden, companyOnly, unknownCo, ownCompany] = await resolveTargets(prisma, rep, [
      { leadId: w.l1.number }, { leadId: w.hidden.number }, { companyId: hiddenCompany.number }, { companyId: 'CO-9999' }, { companyId: w.a.number },
    ]);
    expect(ownCompany).toMatchObject({ kind: 'update', leadId: null, companyId: w.a.id }); // a company with one of their leads
    expect(visible).toMatchObject({ kind: 'update', leadId: w.l1.id, companyId: w.a.id });
    expect(hidden).toEqual({ kind: 'error', code: 'lead_not_found', value: w.hidden.number });
    expect(companyOnly).toMatchObject({ kind: 'error', code: 'company_not_found' }); // a Sales Representative sees only theirs
    expect(unknownCo).toMatchObject({ kind: 'error', code: 'company_not_found' });
    const [asAdmin, foreign] = await resolveTargets(prisma, authOf(admin), [{ companyId: w.a.number }, { leadId: '4567', companyId: 'ACME-9' }]);
    expect(asAdmin).toMatchObject({ kind: 'update', leadId: null, companyId: w.a.id });
    // Another system's ids are not the CRM's: the row is an ordinary new row.
    expect(foreign).toBeNull();
  });

  it('planUpdate: verified empty field skipped; same value ignored; lead website wins over the company\'s', async () => {
    const w = await world();
    const company = await prisma.company.update({
      where: { id: w.a.id }, data: { website: 'https://acme.test', city: null, verifiedFields: { city: true } },
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: w.l1.id } });
    const plan = planUpdate({ website: 'www.acme.test/', city: 'Leeds' }, { lead, company, contact: null }, { knownCountries: [], industries: [] });
    expect(plan.conflicts).toEqual([]);
    // The lead's website is empty but the CRM shows the company's (the same): nothing; the city fills the lead only.
    expect(plan.fills).toEqual([{ entity: 'lead', field: 'city', value: 'Leeds', source: 'city' }]);
  });

  it('Undo reverts the blanks the batch filled (only while untouched) and removes the contact it created', async () => {
    const w = await world();
    const batch = await stage(await editedExport(w));
    expect((await post(`/api/imports/batches/${batch.id}/import`, { acceptHigh: false, noContactRows: 'import', notify: false })).statusCode).toBe(202);
    expect(await runJob()).toBe(true);
    // Someone changes the city on the lead page afterwards: that one stays.
    await prisma.lead.update({ where: { id: w.l1.id }, data: { city: 'York' } });

    const preview = await get(`/api/imports/batches/${batch.id}/undo`);
    expect(preview.statusCode, preview.body).toBe(200);
    // l1: website (lead, company), city (company; the lead's was changed), designation, notes; l2: the contact link.
    expect(preview.json().filled).toEqual({ revert: 6, keep: 1 });
    const res = await post(`/api/imports/batches/${batch.id}/undo`, {});
    expect(res.statusCode, res.body).toBe(200);

    const l1 = await prisma.lead.findUniqueOrThrow({ where: { id: w.l1.id }, include: { contact: true, company: true } });
    expect(l1).toMatchObject({ website: null, notes: null, city: 'York', phone: '+44 20 1234 5678' });
    expect(l1.company).toMatchObject({ website: null, domain: null, city: null });
    expect(l1.contact?.designation).toBeNull();
    const l2 = await prisma.lead.findUniqueOrThrow({ where: { id: w.l2.id } });
    expect(l2.contactId).toBeNull();
    expect(await prisma.contact.count({ where: { firstName: 'Bob', lastName: 'Stone' } })).toBe(0);
    // The existing leads stay; the new lead goes.
    expect(await prisma.lead.count({ where: { id: { in: [w.l1.id, w.l2.id] } } })).toBe(2);
    expect(await prisma.lead.count({ where: { companyName: 'New Co' } })).toBe(0);
  });
});
