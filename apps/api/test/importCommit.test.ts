import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { normalisePhone, roleLabel, type ImportCommit, type ResearchValue, type RowFields } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import type { AuthUser } from '../src/plugins/auth';
import { commitBatch, failImport, importRow, normalisePersonName, splitName, startImport, sweepImportCommit, COMMIT_LEASE_MS } from '../src/imports/commit';
import { knownCountries } from '../src/imports/stage';
import { claimNext, STALE_AFTER_MS } from '../src/jobs/queue';
import { rematchBatch, stageHooks } from '../src/imports/stage';
import { importCommitDeps, importCommitHandler } from '../src/jobs/handlers/importCommit';
import { runOnce } from '../src/jobs/runner';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
afterEach(() => { delete importCommitDeps.afterRow; });

let admin: User;
let cookie: string;
let carlos: User;
let seba: User;
let deepak: User;
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Admin' });
  cookie = await signIn(app, admin);
  carlos = await makeUser({ name: 'Carlos Ruiz' });
  seba = await makeUser({ name: 'Seba Lopez' });
  deepak = await makeUser({ name: 'Deepak Singh' });
  await prisma.allocationRule.create({
    data: { name: 'Spanish market (Español)', matchCountries: ['*'], matchLanguage: 'es', assignTo: [carlos.id, seba.id], priority: 1 },
  });
  await prisma.allocationRule.create({
    data: {
      name: 'English market (US and Canada)', matchCountries: ['United Arab Emirates', 'India', 'Canada'], matchLanguage: 'en',
      assignTo: [deepak.id], priority: 2,
    },
  });
});

const authOf = (u: User): AuthUser => ({
  id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat,
});
const found = (value: string, confidence: number, sourceUrl = `https://source.test/${encodeURIComponent(value)}`): ResearchValue =>
  ({ value, confidence, sourceUrl, sourceLabel: 'source.test' });

type RowSpec = RowFields & {
  $status?: string; $include?: boolean; $research?: Record<string, ResearchValue>; $matched?: number | null;
};
let seq = 0;
async function batchWith(rows: RowSpec[], o: { language?: string; leadType?: string; status?: string } = {}) {
  seq += 1;
  const batch = await prisma.importBatch.create({
    data: {
      number: `IMPORT-2026-11-24-${seq + 100}`, language: o.language ?? 'en', leadType: o.leadType ?? 'Lead',
      status: o.status ?? 'Waiting for review', createdById: admin.id,
    },
  });
  const file = await prisma.importFile.create({
    data: { batchId: batch.id, name: 'Expo-visitors.xlsx', ext: 'xlsx', size: 1, storagePath: '', status: 'Read' },
  });
  for (const [i, { $status, $include, $research, $matched, ...fields }] of rows.entries()) {
    await prisma.importRow.create({
      data: {
        batchId: batch.id, fileId: file.id, position: i + 1, originKind: 'row', originN: i + 2, fields,
        status: $status ?? 'Ready', include: $include ?? true, research: $research ?? {}, matchedCompanyId: $matched ?? null,
      },
    });
  }
  return batch;
}
const rowsOf = (batchId: number) => prisma.importRow.findMany({ where: { batchId }, orderBy: { position: 'asc' } });
const batchOf = (id: number) => prisma.importBatch.findUniqueOrThrow({ where: { id } });
const post = (url: string, payload: unknown, c = cookie) => app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie: c } });
const get = (url: string, c = cookie) => app.inject({ method: 'GET', url, headers: { cookie: c } });
const runJob = () => runOnce({ types: ['import_commit'], handlers: { import_commit: importCommitHandler }, graph: fakeGraph() });
const choose = (o: Partial<ImportCommit> = {}): ImportCommit => ({ acceptHigh: false, noContactRows: 'import', notify: false, ...o });
async function importNow(batchId: number, o: Parameters<typeof choose>[0] = {}) {
  const res = await post(`/api/imports/batches/${batchId}/import`, choose(o));
  expect(res.statusCode, res.body).toBe(202);
  expect(await runJob()).toBe(true);
  return batchOf(batchId);
}

describe('normalisePersonName / splitName', () => {
  it('drops honorifics and accents; the last word is the last name', () => {
    expect(normalisePersonName('Dr. Priya  Shah')).toBe('priya shah');
    expect(normalisePersonName('Sra. José-María Núñez')).toBe('jose maria nunez');
    expect(normalisePersonName('Mme Hélène Dubois')).toBe('helene dubois');
    expect(splitName('Dr. Priya Shah')).toEqual({ firstName: 'Priya', lastName: 'Shah' });
    expect(splitName('Ana María García')).toEqual({ firstName: 'Ana María', lastName: 'García' });
    expect(splitName('Madonna')).toEqual({ firstName: 'Madonna', lastName: '' });
  });
});

describe('import · review and start', () => {
  it('review totals; choice_required with a no-contact row; second import → 409 and one job', async () => {
    const batch = await batchWith([
      { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es', contactName: 'Ana García' },
      { companyName: 'Silent Co', country: 'Spain', $status: 'Missing details' },
      { companyName: 'Chile Co', country: 'Chile', email: 'a@chile.test' },
      { companyName: 'Old Co', country: 'Spain', email: 'a@old.test', $status: 'Already in CRM', $include: false },
    ], { language: 'es', leadType: 'Prospect' });

    const review = await get(`/api/imports/batches/${batch.id}/review?acceptHigh=0&noContactRows=leave`);
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json()).toMatchObject({
      willImport: 1, newCompanies: 1, existingCompanies: 0,
      skipped: { total: 3, alreadyInCrm: 1, notLead: 0, unticked: 0, other: 2 },
      noContactRows: 1, researchOnlyCountry: 0, unknownCountries: [{ value: 'Chile', count: 1 }],
      leadType: 'Prospect', language: 'es', source: `Import · ${batch.number}`,
      allocation: [{ name: 'Spanish market (Español)', people: ['Carlos', 'Seba'] }],
    });
    // Without a choice the no-contact row waits for it: in no total (imports, companies, skipped), only in noContactRows.
    expect((await get(`/api/imports/batches/${batch.id}/review`)).json()).toMatchObject({
      willImport: 1, newCompanies: 1, existingCompanies: 0, skipped: { total: 2, alreadyInCrm: 1, other: 1 }, noContactRows: 1,
    });
    expect((await get(`/api/imports/batches/${batch.id}/review?noContactRows=import`)).json()).toMatchObject({
      willImport: 2, newCompanies: 2, skipped: { total: 2 }, noContactRows: 1,
    });

    const refused = await post(`/api/imports/batches/${batch.id}/import`, choose({ noContactRows: null }));
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'choice_required' });
    expect((await batchOf(batch.id)).status).toBe('Waiting for review');

    const ok = await post(`/api/imports/batches/${batch.id}/import`, choose({ noContactRows: 'leave', notify: true }));
    expect(ok.statusCode, ok.body).toBe(202);
    const b = await batchOf(batch.id);
    expect(b).toMatchObject({
      status: 'Importing', researchPaused: true, importedById: admin.id,
      options: { acceptHigh: false, noContactRows: 'leave', notify: true },
    });
    const again = await post(`/api/imports/batches/${batch.id}/import`, choose({ noContactRows: 'leave' }));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'batch_locked' });
    const jobs = await prisma.job.findMany({ where: { type: 'import_commit' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: { batchId: batch.id }, maxAttempts: 3 });
    // Staged rows can no longer change.
    const [first] = await rowsOf(batch.id);
    const edit = await app.inject({ method: 'PATCH', url: `/api/imports/rows/${first!.id}`, payload: { include: false }, headers: { cookie } });
    expect(edit.statusCode).toBe(409);
  });

  it('a re-match already running when the import starts never lands on the rows', async () => {
    const batch = await batchWith([
      { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es' },
      { companyName: 'Silent Co', country: 'Spain', $status: 'Ready', $include: true },
    ]);
    stageHooks.beforeEvaluationWrite = async () => { await startImport(authOf(admin), batch.id, choose()); };
    try {
      await rematchBatch(batch.id);
    } finally {
      delete stageHooks.beforeEvaluationWrite;
    }
    expect((await batchOf(batch.id)).status).toBe('Importing');
    // The re-evaluation would have made the second row Missing details: it was not written.
    expect((await rowsOf(batch.id)).map((r) => r.status)).toEqual(['Ready', 'Ready']);
  });

  it('nothing_to_import when every row is left out; rights: Sales Representative 403', async () => {
    const batch = await batchWith([{ companyName: 'Unticked', country: 'Spain', email: 'a@u.test', $include: false }]);
    const res = await post(`/api/imports/batches/${batch.id}/import`, choose());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'nothing_to_import' });
    const rep = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    expect((await post(`/api/imports/batches/${batch.id}/import`, choose(), rep)).statusCode).toBe(403);
    expect((await get(`/api/imports/batches/${batch.id}/review`, rep)).statusCode).toBe(403);
  });
});

describe('import · creating companies, contacts and leads', () => {
  it('new companies: company + primary contact + lead (Import source, batch, language), Spanish rule, quiet, one notification per assignee', async () => {
    const batch = await batchWith([
      {
        companyName: 'Hotel Sol', website: 'https://hotelsol.es', country: 'Spain', city: 'Madrid', contactName: 'Ana García',
        designation: 'Directora', email: 'Ana@HotelSol.es', phone: '+34 600 111 222', industry: 'Hospitality', notes: 'Met at FITUR',
      },
      { companyName: 'Café Luna', country: 'Spain', email: 'info@cafeluna.es', contactName: 'Luis Pérez', industry: 'Coffee shops' },
      { companyName: 'Bodega Norte', country: 'Spain', email: 'pedro@bodeganorte.es', contactName: 'Pedro Gil' },
      { companyName: 'Mar Azul', country: 'Spain', email: 'eva@marazul.es', contactName: 'Eva Ros' },
    ], { language: 'es', leadType: 'Prospect' });

    const b = await importNow(batch.id, { notify: true });
    expect(b).toMatchObject({ status: 'Imported', importedCount: 4, newCompanyCount: 4, existingCompanyCount: 0, skippedCount: 0, errorCount: 0 });
    expect(b.importedAt).not.toBeNull();

    const rows = await rowsOf(batch.id);
    expect(rows.map((r) => r.outcome)).toEqual(['Imported', 'Imported', 'Imported', 'Imported']);
    const sol = await prisma.company.findUniqueOrThrow({ where: { id: rows[0]!.companyId! } });
    expect(sol).toMatchObject({
      name: 'Hotel Sol', website: 'https://hotelsol.es', domain: 'hotelsol.es', country: 'Spain', city: 'Madrid', businessEmail: null,
      industry: 'Hospitality', createdById: admin.id,
    });
    const luna = await prisma.company.findUniqueOrThrow({ where: { id: rows[1]!.companyId! } });
    // A generic mailbox is the company's business email; an industry not on the list stays off the company.
    expect(luna).toMatchObject({ businessEmail: 'info@cafeluna.es', domain: 'cafeluna.es', industry: null });

    const ana = await prisma.contact.findUniqueOrThrow({ where: { id: rows[0]!.contactId! } });
    expect(ana).toMatchObject({
      companyId: sol.id, firstName: 'Ana', lastName: 'García', designation: 'Directora', businessEmail: 'ana@hotelsol.es',
      phone: '+34 600 111 222', phoneNormalised: normalisePhone('+34 600 111 222'), isPrimary: true,
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: rows[0]!.leadId! } });
    expect(lead).toMatchObject({
      leadType: 'Prospect', companyName: 'Hotel Sol', companyId: sol.id, contactId: ana.id, leadSource: 'Import', importBatch: batch.number,
      outreachLanguage: 'es', priority: 'Medium', status: 'New', nextFollowUp: null, country: 'Spain', city: 'Madrid',
      businessEmail: 'ana@hotelsol.es', phone: '+34 600 111 222', website: 'https://hotelsol.es', notes: 'Met at FITUR', createdById: admin.id,
    });
    const lunaLead = await prisma.lead.findUniqueOrThrow({ where: { id: rows[1]!.leadId! } });
    expect(lunaLead.notes).toBe('Industry: Coffee shops');

    const leads = await prisma.lead.findMany({ where: { importBatch: batch.number }, orderBy: { id: 'asc' } });
    expect(leads.map((l) => l.assignedToId)).toEqual([carlos.id, seba.id, carlos.id, seba.id]);
    expect(await prisma.task.count({ where: { origin: 'new_assignment' } })).toBe(0);
    const notes = await prisma.notification.findMany({ orderBy: { userId: 'asc' } });
    expect(notes.map((n) => [n.userId, n.text, n.link])).toEqual([
      [carlos.id, `Import ${batch.number} · 2 prospects assigned to you`, `/leads?q=${batch.number}`],
      [seba.id, `Import ${batch.number} · 2 prospects assigned to you`, `/leads?q=${batch.number}`],
    ]);

    expect(rows[0]).toMatchObject({ companyCreated: true, contactCreated: true });
    const stamps = rows[0]!.stamps as { lead: string; company: string; contact: string };
    expect(stamps).toEqual({ lead: lead.updatedAt.toISOString(), company: sol.updatedAt.toISOString(), contact: ana.updatedAt.toISOString() });
    expect(await prisma.auditLog.count({ where: { entityType: 'company', action: 'create' } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { entityType: 'contact', action: 'create' } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { entityType: 'lead', action: 'create' } })).toBe(4);
    // Rerunning a finished import does nothing.
    await commitBatch(batch.id);
    expect(await prisma.lead.count()).toBe(4);
    expect(await prisma.notification.count()).toBe(2);
  });

  it('existing company: no new company, contact matched by email or normalised name, nothing overwritten', async () => {
    const alnoor = await makeCompany({ name: 'Al Noor Logistics', website: 'https://alnoorlogistics.ae', country: 'United Arab Emirates', city: 'Dubai' });
    const made = await makeContact({ companyId: alnoor.id, firstName: 'Omar', lastName: 'Haddad', businessEmail: 'omar.h@alnoorlogistics.ae', phone: '+971 4 555 0192' });
    const omar = await prisma.contact.update({ where: { id: made.id }, data: { isPrimary: true } });
    const priya = await makeContact({ companyId: alnoor.id, firstName: 'Priya', lastName: 'Shah' });
    const before = await prisma.company.findUniqueOrThrow({ where: { id: alnoor.id } });
    const same = { companyName: 'Al Noor Logistics', country: 'United Arab Emirates', $status: 'Already in CRM', $matched: alnoor.id };
    const batch = await batchWith([
      { ...same, city: 'Abu Dhabi', contactName: 'Omer Hadad', designation: 'CEO', email: 'OMAR.H@alnoorlogistics.ae', phone: '+971 50 000 0000' },
      { ...same, contactName: 'Sara Ali', email: 'sara@alnoorlogistics.ae' },
      { ...same, contactName: 'Dr. Priya Shah', phone: '+971 4 555 0100' },
      // No person named: the lead has no contact (not the company's primary).
      { ...same, phone: '+971 4 555 0111' },
    ]);

    const b = await importNow(batch.id);
    expect(b).toMatchObject({ status: 'Imported', importedCount: 4, newCompanyCount: 0, existingCompanyCount: 4 });
    expect(await prisma.company.count()).toBe(1);
    const rows = await rowsOf(batch.id);
    expect(rows.map((r) => r.companyId)).toEqual([alnoor.id, alnoor.id, alnoor.id, alnoor.id]);
    expect(rows.map((r) => r.companyCreated)).toEqual([false, false, false, false]);
    expect(rows.map((r) => r.contactCreated)).toEqual([false, true, false, false]);
    expect(rows[0]!.contactId).toBe(omar.id);
    expect(rows[2]!.contactId).toBe(priya.id);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: omar.id } })).toEqual(omar);
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: priya.id } })).toEqual(priya);
    const sara = await prisma.contact.findUniqueOrThrow({ where: { id: rows[1]!.contactId! } });
    expect(sara).toMatchObject({ companyId: alnoor.id, firstName: 'Sara', lastName: 'Ali', businessEmail: 'sara@alnoorlogistics.ae', isPrimary: false });
    const after = await prisma.company.findUniqueOrThrow({ where: { id: alnoor.id } });
    expect(after.city).toBe('Dubai');
    expect(after).toEqual(before);
    const leads = await prisma.lead.findMany({ where: { importBatch: batch.number }, orderBy: { id: 'asc' } });
    expect(leads.map((l) => [l.companyId, l.contactId, l.assignedToId])).toEqual([
      [alnoor.id, omar.id, deepak.id], [alnoor.id, sara.id, deepak.id], [alnoor.id, priya.id, deepak.id], [alnoor.id, null, deepak.id],
    ]);
    expect(leads[0]!.city).toBe('Abu Dhabi');
    // Notify box unticked: nobody hears about it.
    expect(await prisma.notification.count()).toBe(0);
  });

  it('an inactive contact matched by email is neither linked nor duplicated', async () => {
    const co = await makeCompany({ name: 'Inact Co', country: 'India', website: 'https://inact.test' });
    const old = await makeContact({ companyId: co.id, firstName: 'Ravi', lastName: 'Old', businessEmail: 'ravi@inact.test' });
    await prisma.contact.update({ where: { id: old.id }, data: { isActive: false } });
    const batch = await batchWith([{
      companyName: 'Inact Co', country: 'India', email: 'Ravi@Inact.test', contactName: 'Ravi New', $status: 'Already in CRM', $matched: co.id,
    }]);
    await importNow(batch.id);
    const [row] = await rowsOf(batch.id);
    expect(row).toMatchObject({ outcome: 'Imported', contactId: null, contactCreated: false });
    expect(await prisma.contact.count({ where: { companyId: co.id } })).toBe(1);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: row!.leadId! } })).contactId).toBeNull();
  });

  it('the same company twice, and a row matching a company an earlier row created → one company, each row its own contact and lead', async () => {
    const batch = await batchWith([
      { companyName: 'Gulf Freight', website: 'https://gulffreight.ae', country: 'United Arab Emirates', contactName: 'Ali Khan', email: 'ali@gulffreight.ae' },
      { companyName: 'Gulf Freight', website: 'www.gulffreight.ae/contact', country: 'United Arab Emirates', contactName: 'Mina Rao', email: 'mina@gulffreight.ae' },
      { companyName: 'GF Logistics FZE', country: 'United Arab Emirates', contactName: 'Ravi Iyer', email: 'ops@gulffreight.ae' },
      // Free mail never makes a company domain.
      { companyName: 'Solo Trader', country: 'India', contactName: 'Kiran Das', email: 'kiran@gmail.com' },
    ]);
    const b = await importNow(batch.id);
    expect(b).toMatchObject({ status: 'Imported', importedCount: 4, newCompanyCount: 2, existingCompanyCount: 0, errorCount: 0 });
    const rows = await rowsOf(batch.id);
    const gulf = rows[0]!.companyId!;
    expect(rows.slice(0, 3).map((r) => r.companyId)).toEqual([gulf, gulf, gulf]);
    expect(rows.map((r) => r.companyCreated)).toEqual([true, false, false, true]);
    expect(await prisma.company.findUniqueOrThrow({ where: { id: gulf } })).toMatchObject({ domain: 'gulffreight.ae', name: 'Gulf Freight' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: rows[3]!.companyId! } })).domain).toBeNull();
    const contacts = await prisma.contact.findMany({ where: { companyId: gulf }, orderBy: { id: 'asc' } });
    expect(contacts.map((c) => [c.firstName, c.isPrimary])).toEqual([['Ali', true], ['Mina', false], ['Ravi', false]]);
    expect(await prisma.lead.count({ where: { companyId: gulf } })).toBe(3);
  });
});

describe('import · research values (release-4 golden rule)', () => {
  const site = 'https://sunrisetextiles.in/contact';
  const sunrise = (): RowSpec => ({
    companyName: 'Sunrise Textiles', country: 'India', email: 'raj@sunrisetextiles.in', contactName: 'Raj Mehta',
    $research: {
      website: found('https://sunrisetextiles.in', 90, site), city: found('Surat', 85, site), designation: found('Owner', 90, site),
      phone: found('+91 261 555 0101', 75, site), industry: found('Textiles', 85, site),
    },
  });

  it('unticked: company values become suggestions with their source, contact values only in the "Research found" entry', async () => {
    const batch = await batchWith([sunrise()]);
    await importNow(batch.id);
    const [row] = await rowsOf(batch.id);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: row!.companyId! } });
    expect(company).toMatchObject({ website: null, city: null, aiIndustry: 'Textiles', verifiedFields: {}, aiFields: {} });
    const run = await prisma.enrichmentRun.findFirstOrThrow({ where: { companyId: company.id } });
    expect(run).toMatchObject({ trigger: `Import ${batch.number}`, engine: 'Website reader', sources: ['import'], status: 'Completed', result: '2 suggestions' });
    const suggestions = await prisma.enrichmentSuggestion.findMany({ where: { companyId: company.id }, orderBy: { field: 'asc' } });
    expect(suggestions.map((s) => [s.field, s.value, s.confidence, s.sourceUrl, s.decision])).toEqual([
      ['city', 'Surat', 85, site, 'pending'], ['website', 'https://sunrisetextiles.in', 90, site, 'pending'],
    ]);
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: row!.contactId! } });
    expect(contact).toMatchObject({ designation: null, phone: null });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: row!.leadId! } });
    expect(lead).toMatchObject({ website: null, city: null, phone: null });
    const entry = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'ai' } });
    expect(entry.title).toBe('Research found (not verified)');
    expect(entry.body).toBe(`Designation: Owner · ${site} · 90%\nPhone: +91 261 555 0101 · ${site} · 75%`);
    // Imports never use up company research's daily limit (Task 1 counts runs whose sources include "import" out).
  });

  it('ticked: values ≥ 80 written into empty unverified fields as accepted; a 70 value stays a suggestion', async () => {
    const spec = sunrise();
    spec.$research = { ...spec.$research, website: found('https://sunrisetextiles.in', 70, site) };
    const batch = await batchWith([spec]);
    await importNow(batch.id, { acceptHigh: true });
    const [row] = await rowsOf(batch.id);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: row!.companyId! } });
    expect(company.city).toBe('Surat');
    expect(company.website).toBeNull();
    expect(company.verifiedFields).toEqual({ city: true });
    expect((company.aiFields as Record<string, { source: string; confidence: number }>).city).toMatchObject({ source: site, confidence: 85 });
    const suggestions = await prisma.enrichmentSuggestion.findMany({ where: { companyId: company.id }, orderBy: { field: 'asc' } });
    expect(suggestions.map((s) => [s.field, s.decision])).toEqual([['city', 'accepted'], ['website', 'pending']]);
    // Contact values at or above 80 were used (accepted); the 75 phone was not.
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: row!.contactId! } });
    expect(contact).toMatchObject({ designation: 'Owner', phone: null });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: row!.leadId! } });
    expect(lead.city).toBe('Surat');
    const entry = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'ai' } });
    expect(entry.body).toBe(`Phone: +91 261 555 0101 · ${site} · 75%`);
  });

  it('ticked: a country only from research is recorded as accepted (verified, ai_fields with source) and listed as accepted on the lead', async () => {
    const src = 'https://directorio.test/ficha';
    const batch = await batchWith([{
      companyName: 'Research Country Co', phone: '+34 600 000 001', contactName: 'Ana Ruiz', $status: 'Missing details',
      $research: { country: found('Spain', 90, src), email: found('ana.ruiz@researchcountry.es', 85, src) },
    }], { language: 'es' });
    await importNow(batch.id, { acceptHigh: true });
    const [row] = await rowsOf(batch.id);
    expect(row!.outcome).toBe('Imported');
    const company = await prisma.company.findUniqueOrThrow({ where: { id: row!.companyId! } });
    expect(company.country).toBe('Spain');
    expect((company.verifiedFields as Record<string, boolean>).country).toBe(true);
    expect((company.aiFields as Record<string, { source: string; confidence: number }>).country).toMatchObject({ source: src, confidence: 90 });
    // A person's email found by research never becomes the company domain.
    expect(company.domain).toBeNull();
    const s = await prisma.enrichmentSuggestion.findFirstOrThrow({ where: { companyId: company.id, field: 'country' } });
    expect(s).toMatchObject({ decision: 'accepted', value: 'Spain', sourceUrl: src });
    const entry = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: row!.leadId!, title: 'Accepted from research' } });
    expect(entry.body).toBe(`Country: Spain · ${src} · 90%\nEmail: ana.ruiz@researchcountry.es · ${src} · 85%`);
    // Unticked, the same row is left out (a lead needs a country).
    const again = await batchWith([{
      companyName: 'Research Country Two', phone: '+34 600 000 002', $status: 'Missing details', $research: { country: found('Spain', 90, src) },
    }]);
    const res = await post(`/api/imports/batches/${again.id}/import`, choose());
    expect(res.json()).toEqual({ error: 'nothing_to_import' });
  });

  it('existing company: a filled but unverified field is left untouched (no suggestion); a research industry → ai_industry, audited', async () => {
    const co = await makeCompany({ name: 'Filled Mills', country: 'India', website: 'https://filledmills.in', city: 'Pune' });
    const batch = await batchWith([{
      companyName: 'Filled Mills', country: 'India', email: 'a@filledmills.in', $status: 'Already in CRM', $matched: co.id,
      $research: { city: found('Nagpur', 95), industry: found('Textiles', 85) },
    }]);
    await importNow(batch.id, { acceptHigh: true });
    const after = await prisma.company.findUniqueOrThrow({ where: { id: co.id } });
    expect(after).toMatchObject({ city: 'Pune', verifiedFields: {}, aiIndustry: 'Textiles' });
    expect(await prisma.enrichmentSuggestion.count()).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'company', entityId: String(co.id), action: 'update' } });
    expect(log).toMatchObject({ userId: admin.id, before: { aiIndustry: null }, after: { aiIndustry: 'Textiles' } });
  });

  it('existing company with a verified city: no write and no suggestion', async () => {
    const co = await makeCompany({ name: 'Verified Mills', country: 'India', website: 'https://verifiedmills.in' });
    await prisma.company.update({ where: { id: co.id }, data: { verifiedFields: { city: true } } });
    const batch = await batchWith([{
      companyName: 'Verified Mills', country: 'India', email: 'a@verifiedmills.in', $status: 'Already in CRM', $matched: co.id,
      $research: { city: found('Ludhiana', 95) },
    }]);
    await importNow(batch.id, { acceptHigh: true });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: co.id } })).city).toBeNull();
    expect(await prisma.enrichmentSuggestion.count()).toBe(0);
    expect(await prisma.enrichmentRun.count()).toBe(0);
  });
});

describe('import · resumable job, stamps and errors', () => {
  const four = (): RowSpec[] => [
    { companyName: 'One Co', country: 'India', email: 'a@one.test', contactName: 'Asha One' },
    { companyName: 'Two Co', country: 'India', email: 'b@two.test', contactName: 'Bala Two' },
    { companyName: 'Two Co', country: 'India', email: 'c@two.test', contactName: 'Chitra Two' },
    { companyName: 'Four Co', country: 'India', email: 'd@four.test', contactName: 'Dev Four' },
  ];

  it('a run stopped after row 2 resumes with exactly the remaining rows, no duplicate company or contact', async () => {
    const batch = await batchWith(four());
    await startImport(authOf(admin), batch.id, choose());
    await expect(commitBatch(batch.id, { afterRow: (n) => { if (n === 2) throw new Error('stop'); } })).rejects.toThrow('stop');
    expect((await rowsOf(batch.id)).filter((r) => r.leadId !== null)).toHaveLength(2);
    expect((await batchOf(batch.id)).status).toBe('Importing');
    await commitBatch(batch.id);
    expect(await prisma.lead.count()).toBe(4);
    expect(await prisma.company.count()).toBe(3);
    expect(await prisma.contact.count()).toBe(4);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Imported', importedCount: 4, newCompanyCount: 3 });
  });

  it('two runs at the same time import each row once (6 rows → 6 leads, companies and contacts)', async () => {
    const rows: RowSpec[] = Array.from({ length: 6 }, (_, i) => (i % 2 === 0
      ? { companyName: `Name Co ${i}`, country: 'India', phone: `+91 20 555 01${i}0`, contactName: `Person ${i} Test` }
      : { companyName: `Domain Co ${i}`, website: `https://domain${i}.test`, country: 'India', email: `p${i}@domain${i}.test`, contactName: `Person ${i} Test` }));
    const batch = await batchWith(rows);
    await startImport(authOf(admin), batch.id, choose());
    const settled = await Promise.allSettled([commitBatch(batch.id), commitBatch(batch.id)]);
    expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await prisma.lead.count({ where: { importBatch: batch.number } })).toBe(6);
    expect(await prisma.company.count()).toBe(6);
    expect(await prisma.contact.count()).toBe(6);
    expect((await rowsOf(batch.id)).map((r) => r.outcome)).toEqual(Array(6).fill('Imported'));
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Imported', importedCount: 6, errorCount: 0, commitRun: null });
  });

  it('a row already imported by another run is left alone (row lock and re-check)', async () => {
    const batch = await batchWith(four().slice(0, 1));
    await startImport(authOf(admin), batch.id, choose());
    const [stale] = await rowsOf(batch.id);
    await commitBatch(batch.id);
    const ctx = { user: authOf(admin), acceptHigh: false, knownCountries: await knownCountries() };
    const b = await batchOf(batch.id);
    expect(await prisma.$transaction((tx) => importRow(tx, stale!, b, ctx))).toBeNull();
    expect(await prisma.lead.count()).toBe(1);
  });

  it('restart mid-import: the startup sweep re-queues the job, which finishes with no duplicates', async () => {
    const batch = await batchWith(four());
    await startImport(authOf(admin), batch.id, choose());
    const job = await claimNext(['import_commit']);
    expect(job).not.toBeNull();
    // The worker dies after row 2 (the job stays running, the lease is left behind).
    await expect(commitBatch(batch.id, { afterRow: (n) => { if (n === 2) throw new Error('killed'); } })).rejects.toThrow('killed');
    await prisma.importBatch.update({ where: { id: batch.id }, data: { commitRun: 'dead-run', commitHeartbeatAt: new Date() } });
    // A second run meanwhile finds the lease held and does nothing.
    await commitBatch(batch.id);
    expect(await prisma.lead.count()).toBe(2);

    expect(await sweepImportCommit({ startup: true })).toBe(1);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job!.id } })).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await runJob()).toBe(true);
    expect(await prisma.lead.count()).toBe(4);
    expect(await prisma.company.count()).toBe(3);
    expect(await prisma.contact.count()).toBe(4);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Imported', importedCount: 4 });
  });

  it('scheduled sweep: a stale job whose lease is dead is re-queued; one with a live lease is left running', async () => {
    const batch = await batchWith(four());
    await startImport(authOf(admin), batch.id, choose());
    const job = (await claimNext(['import_commit']))!;
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000);
    await prisma.job.update({ where: { id: job.id }, data: { lockedAt: old } });
    await prisma.importBatch.update({ where: { id: batch.id }, data: { commitRun: 'live', commitHeartbeatAt: new Date() } });
    expect(await sweepImportCommit()).toBe(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('running');
    await prisma.importBatch.update({ where: { id: batch.id }, data: { commitHeartbeatAt: new Date(Date.now() - COMMIT_LEASE_MS - 1000) } });
    expect(await sweepImportCommit()).toBe(1);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('queued');
    expect(await runJob()).toBe(true);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Imported', importedCount: 4 });
  });

  it('attempts exhausted → Failed job_failed; Continue imports the rest (no duplicates); only a Failed import can be continued', async () => {
    const batch = await batchWith(four());
    await startImport(authOf(admin), batch.id, choose());
    importCommitDeps.afterRow = () => { throw new Error('boom'); };
    for (let i = 0; i < 3; i += 1) {
      await prisma.job.updateMany({ where: { type: 'import_commit', status: 'queued' }, data: { runAt: new Date(Date.now() - 1000) } });
      expect(await runJob()).toBe(true);
    }
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Failed', importError: 'job_failed', commitRun: null });
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'import_commit' } })).status).toBe('failed');
    expect(await prisma.lead.count()).toBe(3);
    delete importCommitDeps.afterRow;

    const rep = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    expect((await post(`/api/imports/batches/${batch.id}/import/continue`, {}, rep)).statusCode).toBe(403);
    const res = await post(`/api/imports/batches/${batch.id}/import/continue`, {});
    expect(res.statusCode, res.body).toBe(202);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Importing', importError: null });
    expect(await runJob()).toBe(true);
    expect(await prisma.lead.count()).toBe(4);
    expect(await prisma.company.count()).toBe(3);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Imported', importedCount: 4 });
    const again = await post(`/api/imports/batches/${batch.id}/import/continue`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'cannot_continue' });
  });

  it('a run whose lease ran out cannot renew it and stops before the next row', async () => {
    const batch = await batchWith(four());
    await startImport(authOf(admin), batch.id, choose());
    const old = new Date(Date.now() - COMMIT_LEASE_MS - 1000);
    await expect(commitBatch(batch.id, {
      afterRow: async (n) => { if (n === 1) await prisma.importBatch.update({ where: { id: batch.id }, data: { commitHeartbeatAt: old } }); },
    })).rejects.toThrow('import_lease_lost');
    expect(await prisma.lead.count()).toBe(1);
    expect((await batchOf(batch.id)).status).toBe('Importing');
  });

  it('losing the lease on the last attempt leaves the batch to the run holding it; failImport skips a live lease', async () => {
    const batch = await batchWith(four());
    await startImport(authOf(admin), batch.id, choose());
    await prisma.job.updateMany({ where: { type: 'import_commit' }, data: { attempts: 2 } });
    importCommitDeps.afterRow = async () => {
      await prisma.importBatch.update({ where: { id: batch.id }, data: { commitRun: 'other-run', commitHeartbeatAt: new Date() } });
    };
    expect(await runJob()).toBe(true);
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'import_commit' } })).status).toBe('failed');
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Importing', importError: null, commitRun: 'other-run' });
    await failImport(batch.id, 'job_failed');
    expect((await batchOf(batch.id)).status).toBe('Importing');
  });

  it('Continue is refused while the batch still has an import job queued', async () => {
    const batch = await batchWith(four().slice(0, 1));
    await startImport(authOf(admin), batch.id, choose());
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Failed', importError: 'interrupted' } });
    const res = await post(`/api/imports/batches/${batch.id}/import/continue`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'import_running' });
  });

  it('scheduled sweep: an Importing batch whose job failed for good becomes Failed (and can be continued)', async () => {
    const batch = await batchWith(four().slice(0, 1));
    await startImport(authOf(admin), batch.id, choose());
    await prisma.job.updateMany({ where: { type: 'import_commit' }, data: { status: 'failed' } });
    await sweepImportCommit();
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Failed', importError: 'job_failed' });
  });

  it('a company shared by two rows: both rows carry the company\'s final stamp', async () => {
    const batch = await batchWith([
      { companyName: 'Shared Co', website: 'https://shared.test', country: 'India', email: 'a@shared.test', contactName: 'Anil Shared' },
      {
        companyName: 'Shared Co', website: 'https://shared.test', country: 'India', email: 'b@shared.test', contactName: 'Bina Shared',
        $research: { city: found('Chennai', 90) },
      },
    ]);
    await importNow(batch.id, { acceptHigh: true });
    const rows = await rowsOf(batch.id);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: rows[0]!.companyId! } });
    expect(company.city).toBe('Chennai');
    for (const r of rows) expect((r.stamps as { company: string }).company).toBe(company.updatedAt.toISOString());
  });

  it('a row failing inside lead creation is an Error with its message; the others import; skipped rows are recorded', async () => {
    const batch = await batchWith([
      ...four().slice(0, 2), four()[3]!,
      { companyName: 'Unticked', country: 'India', email: 'z@u.test', $include: false },
    ]);
    await startImport(authOf(admin), batch.id, choose());
    const setNew = (isActive: boolean) => prisma.lookupValue.updateMany({ where: { group: 'lead_status', value: 'New' }, data: { isActive } });
    await commitBatch(batch.id, {
      afterRow: async (n) => {
        if (n === 1) await setNew(false);
        if (n === 2) await setNew(true);
      },
    });
    const rows = await rowsOf(batch.id);
    expect(rows.map((r) => r.outcome)).toEqual(['Imported', 'Error', 'Imported', 'Skipped']);
    expect(rows[1]).toMatchObject({ error: 'invalid_status', leadId: null, companyId: null });
    expect(rows[3]!.outcomeCode).toBe('unticked');
    expect(await prisma.company.count()).toBe(2);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Imported', importedCount: 2, errorCount: 1, skippedCount: 1 });
  });

  it('every import row failing → Failed', async () => {
    const batch = await batchWith([four()[0]!]);
    await startImport(authOf(admin), batch.id, choose());
    await prisma.lookupValue.updateMany({ where: { group: 'lead_status', value: 'New' }, data: { isActive: false } });
    await commitBatch(batch.id);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Failed', errorCount: 1, importedCount: 0 });
  });
});
