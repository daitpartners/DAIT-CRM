import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roleLabel, type ImportCommit, type ResearchValue, type RowFields, type UndoPreview } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import type { AuthUser } from '../src/plugins/auth';
import { importCommitHandler } from '../src/jobs/handlers/importCommit';
import { runOnce } from '../src/jobs/runner';
import { undoBatch, undoPreview } from '../src/imports/undo';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());

let admin: User;
let cookie: string;
let manager: User;
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Admin' });
  cookie = await signIn(app, admin);
  manager = await makeUser({ role: 'MANAGER', name: 'Mona Manager' });
  const rep = await makeUser({ name: 'Ravi Rep' });
  await prisma.allocationRule.create({
    data: { name: 'All', matchCountries: ['*'], matchLanguage: 'en', assignTo: [rep.id], priority: 1 },
  });
});

const authOf = (u: User): AuthUser => ({
  id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat,
});
const found = (value: string, confidence: number): ResearchValue =>
  ({ value, confidence, sourceUrl: `https://source.test/${encodeURIComponent(value)}`, sourceLabel: 'source.test' });

type RowSpec = RowFields & { $status?: string; $research?: Record<string, ResearchValue>; $matched?: number | null };
let seq = 0;
async function batchWith(rows: RowSpec[]) {
  seq += 1;
  const batch = await prisma.importBatch.create({
    data: { number: `IMPORT-2026-11-24-${seq + 300}`, language: 'en', leadType: 'Lead', status: 'Waiting for review', createdById: admin.id },
  });
  const file = await prisma.importFile.create({
    data: { batchId: batch.id, name: 'Expo.xlsx', ext: 'xlsx', size: 1, storagePath: '', status: 'Read' },
  });
  for (const [i, { $status, $research, $matched, ...fields }] of rows.entries()) {
    await prisma.importRow.create({
      data: {
        batchId: batch.id, fileId: file.id, position: i + 1, originKind: 'row', originN: i + 2, fields,
        status: $status ?? 'Ready', include: true, research: $research ?? {}, matchedCompanyId: $matched ?? null,
      },
    });
  }
  return batch;
}
const rowsOf = (batchId: number) => prisma.importRow.findMany({ where: { batchId }, orderBy: { position: 'asc' } });
const get = (url: string, c = cookie) => app.inject({ method: 'GET', url, headers: { cookie: c } });
const post = (url: string, c = cookie) => app.inject({ method: 'POST', url, headers: { cookie: c } });
async function importNow(batchId: number, o: Partial<ImportCommit> = {}) {
  const res = await app.inject({
    method: 'POST', url: `/api/imports/batches/${batchId}/import`, headers: { cookie },
    payload: { acceptHigh: false, noContactRows: 'import', notify: false, ...o },
  });
  expect(res.statusCode, res.body).toBe(202);
  expect(await runOnce({ types: ['import_commit'], handlers: { import_commit: importCommitHandler }, graph: fakeGraph() })).toBe(true);
  const b = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  expect(['Imported', 'Failed']).toContain(b.status);
  return rowsOf(batchId);
}
const sortKeep = (p: UndoPreview) => [...p.keep].map((k) => [k.kind, k.id, k.reason]).sort((a, b) => String(a).localeCompare(String(b)));

describe('undo', () => {
  it('keeps what people worked on (and what hangs on it), removes the rest; Administrators only; twice → 409', async () => {
    const alnoor = await makeCompany({ name: 'Al Noor Logistics', website: 'https://alnoor.ae', country: 'United Arab Emirates' });
    const omar = await makeContact({ companyId: alnoor.id, firstName: 'Omar', lastName: 'Haddad', businessEmail: 'omar@alnoor.ae' });
    const alnoorBefore = await prisma.company.findUniqueOrThrow({ where: { id: alnoor.id } });
    const batch = await batchWith([
      { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es', contactName: 'Ana García' },
      { companyName: 'Café Luna', country: 'Spain', email: 'luis@cafeluna.es', contactName: 'Luis Pérez' },
      { companyName: 'Mar Azul', country: 'Spain', email: 'eva@marazul.es', contactName: 'Eva Ros' },
      { companyName: 'Al Noor Logistics', country: 'United Arab Emirates', email: 'sara@alnoor.ae', contactName: 'Sara Ali', $status: 'Already in CRM', $matched: alnoor.id },
    ]);
    const rows = await importNow(batch.id);
    const [sol, luna, mar, noor] = rows as [typeof rows[0], typeof rows[0], typeof rows[0], typeof rows[0]];
    expect(noor.contactCreated).toBe(true);

    // Lead 1 gets an email; company 2 gets a quotation.
    await prisma.emailMessage.create({
      data: {
        userId: admin.id, leadId: sol.leadId, folder: 'sent', status: 'sent', fromAddress: 'me@dait.test', subject: 'Hello',
      },
    });
    await prisma.quotation.create({
      data: {
        number: 'QT-0001', companyId: luna.companyId!, ownerId: admin.id, quotationDate: new Date('2026-11-24'), currency: 'EUR', subject: 'Web',
      },
    });

    const preview = await get(`/api/imports/batches/${batch.id}/undo`);
    expect(preview.statusCode, preview.body).toBe(200);
    const p = preview.json() as UndoPreview;
    expect(sortKeep(p)).toEqual([
      ['company', sol.companyId, 'other_leads'],
      ['company', luna.companyId, 'quotations'],
      ['contact', sol.contactId, 'other_leads'],
      ['contact', luna.contactId, 'other_leads'],
      ['lead', sol.leadId, 'emails'],
      ['lead', luna.leadId, 'other_leads'],
    ].sort((a, b) => String(a).localeCompare(String(b))));
    const leadNumbers = await prisma.lead.findMany({ where: { id: { in: [mar.leadId!, noor.leadId!] } }, orderBy: { id: 'asc' } });
    expect(p.remove).toEqual({ leads: leadNumbers.map((l) => ({ id: l.id, number: l.number })), contacts: 2, companies: 1 });
    const solLead = await prisma.lead.findUniqueOrThrow({ where: { id: sol.leadId! } });
    expect(p.keep.find((k) => k.kind === 'lead' && k.id === sol.leadId)!.label).toBe(`${solLead.number} · Hotel Sol`);

    // Managers import but cannot undo.
    const mgr = await signIn(app, manager);
    expect((await post(`/api/imports/batches/${batch.id}/undo`, mgr)).statusCode).toBe(403);
    expect((await get(`/api/imports/batches/${batch.id}/undo`, mgr)).statusCode).toBe(403);

    const res = await post(`/api/imports/batches/${batch.id}/undo`);
    expect(res.statusCode, res.body).toBe(200);
    expect(sortKeep(res.json() as UndoPreview)).toEqual(sortKeep(p));
    expect(await prisma.lead.count({ where: { id: { in: [mar.leadId!, noor.leadId!] } } })).toBe(0);
    expect(await prisma.contact.count({ where: { id: { in: [mar.contactId!, noor.contactId!] } } })).toBe(0);
    expect(await prisma.company.count({ where: { id: mar.companyId! } })).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: mar.leadId! } })).toBe(0);
    // Kept records are all still there.
    expect(await prisma.lead.count({ where: { id: { in: [sol.leadId!, luna.leadId!] } } })).toBe(2);
    expect(await prisma.company.count({ where: { id: { in: [sol.companyId!, luna.companyId!] } } })).toBe(2);
    // The existing company and its own contact are untouched.
    expect(await prisma.company.findUniqueOrThrow({ where: { id: alnoor.id } })).toEqual(alnoorBefore);
    expect(await prisma.contact.findUnique({ where: { id: omar.id } })).not.toBeNull();
    const b = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(b).toMatchObject({ status: 'Undone', undoneById: admin.id });
    expect(b.undoneAt).not.toBeNull();
    expect(sortKeep(b.undo as UndoPreview)).toEqual(sortKeep(p));
    expect(await prisma.auditLog.count({ where: { action: 'delete', entityType: 'lead' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'delete', entityType: 'contact' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'delete', entityType: 'company' } })).toBe(1);

    const again = await post(`/api/imports/batches/${batch.id}/undo`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'batch_locked' });
  });

  it('an edited lead is kept "edited", a status change "status"; a contact added to an existing company stays when edited', async () => {
    const alnoor = await makeCompany({ name: 'Al Noor Logistics', website: 'https://alnoor.ae', country: 'United Arab Emirates' });
    const batch = await batchWith([
      { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es', contactName: 'Ana García' },
      { companyName: 'Café Luna', country: 'Spain', email: 'luis@cafeluna.es' },
      { companyName: 'Al Noor Logistics', country: 'United Arab Emirates', email: 'sara@alnoor.ae', contactName: 'Sara Ali', $status: 'Already in CRM', $matched: alnoor.id },
    ]);
    const [sol, luna, noor] = await importNow(batch.id);
    await prisma.lead.update({ where: { id: sol!.leadId! }, data: { notes: 'Called, interested' } });
    await prisma.lead.update({ where: { id: luna!.leadId! }, data: { status: 'Contacted' } });
    await prisma.leadActivity.create({ data: { leadId: luna!.leadId!, activityType: 'status', title: 'Status changed to Contacted', statusFrom: 'New', statusTo: 'Contacted' } });
    await prisma.contact.update({ where: { id: noor!.contactId! }, data: { designation: 'Head of Ops' } });

    const p = await undoPreview(batch.id);
    expect(p.keep.filter((k) => k.kind === 'lead').map((k) => [k.id, k.reason])).toEqual([[sol!.leadId, 'edited'], [luna!.leadId, 'status']]);
    expect(p.keep.find((k) => k.kind === 'contact' && k.id === noor!.contactId)).toMatchObject({ reason: 'edited', label: 'Sara Ali' });
    const r = await undoBatch(authOf(admin), batch.id);
    expect(r.remove.leads.map((l) => l.id)).toEqual([noor!.leadId]);
    expect(await prisma.contact.count({ where: { id: noor!.contactId! } })).toBe(1);
    expect(await prisma.company.count({ where: { id: alnoor.id } })).toBe(1);
  });

  it('two rows on one new company (the second wrote a ticked research city) → everything removed, nothing "edited"', async () => {
    const batch = await batchWith([
      { companyName: 'Gulf Freight', website: 'https://gulffreight.ae', country: 'United Arab Emirates', contactName: 'Ali Khan', email: 'ali@gulffreight.ae' },
      {
        companyName: 'Gulf Freight', website: 'https://gulffreight.ae', country: 'United Arab Emirates', contactName: 'Mina Rao', email: 'mina@gulffreight.ae',
        $research: { city: found('Dubai', 90) },
      },
    ]);
    const rows = await importNow(batch.id, { acceptHigh: true });
    const company = await prisma.company.findUniqueOrThrow({ where: { id: rows[0]!.companyId! } });
    expect(company.city).toBe('Dubai');
    const p = await undoPreview(batch.id);
    expect(p.keep).toEqual([]);
    expect(p.remove).toMatchObject({ contacts: 2, companies: 1 });
    expect(p.remove.leads).toHaveLength(2);
    await undoBatch(authOf(admin), batch.id);
    expect(await prisma.company.count()).toBe(0);
    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.enrichmentRun.count()).toBe(0);
  });

  it('existing company: accepted research values and the AI industry go back when untouched; kept when edited', async () => {
    const make = (name: string, domain: string) => makeCompany({ name, website: `https://${domain}`, country: 'India' });
    const a = await make('Alpha Mills', 'alpha.in');
    const bco = await make('Beta Mills', 'beta.in');
    const pending = await prisma.enrichmentRun.create({ data: { companyId: a.id, trigger: 'Manual · X', engine: 'Website reader', status: 'Completed' } });
    const older = await prisma.enrichmentSuggestion.create({
      data: { runId: pending.id, companyId: a.id, field: 'city', label: 'City', value: 'Pune', confidence: 60, sourceUrl: 'https://alpha.in', sourceLabel: 'alpha.in' },
    });
    const research = { city: found('Surat', 90), industry: found('Textiles', 85) };
    const batch = await batchWith([
      { companyName: 'Alpha Mills', country: 'India', email: 'raj@alpha.in', $status: 'Already in CRM', $matched: a.id, $research: research },
      { companyName: 'Beta Mills', country: 'India', email: 'raj@beta.in', $status: 'Already in CRM', $matched: bco.id, $research: research },
    ]);
    await importNow(batch.id, { acceptHigh: true });
    const aAfter = await prisma.company.findUniqueOrThrow({ where: { id: a.id } });
    expect(aAfter).toMatchObject({ city: 'Surat', aiIndustry: 'Textiles', verifiedFields: { city: true } });
    expect((await prisma.enrichmentSuggestion.findUniqueOrThrow({ where: { id: older.id } })).decision).toBe('superseded');
    // Beta is edited by a person after the import.
    await prisma.company.update({ where: { id: bco.id }, data: { description: 'Edited by hand' } });

    const p = await undoPreview(batch.id);
    expect(p.reverted).toEqual([{ id: a.id, label: `${a.number} · Alpha Mills` }]);
    expect(p.keep).toEqual([{ kind: 'company', id: bco.id, label: `${bco.number} · Beta Mills`, reason: 'edited' }]);
    await undoBatch(authOf(admin), batch.id);
    const aBack = await prisma.company.findUniqueOrThrow({ where: { id: a.id } });
    expect(aBack).toMatchObject({ city: null, aiIndustry: null, verifiedFields: {}, aiFields: {}, verificationStatus: a.verificationStatus });
    expect(await prisma.enrichmentRun.count({ where: { companyId: a.id, trigger: `Import ${batch.number}` } })).toBe(0);
    // The suggestion the import superseded is pending again.
    expect((await prisma.enrichmentSuggestion.findUniqueOrThrow({ where: { id: older.id } })).decision).toBe('pending');
    const bAfter = await prisma.company.findUniqueOrThrow({ where: { id: bco.id } });
    expect(bAfter).toMatchObject({ city: 'Surat', aiIndustry: 'Textiles', description: 'Edited by hand' });
    expect(await prisma.auditLog.count({ where: { entityType: 'company', entityId: String(a.id), action: 'update', userId: admin.id, after: { path: ['undoneImport'], equals: batch.number } } })).toBe(1);
  });

  it('a Failed batch that imported part of its rows can be undone; a batch not imported cannot', async () => {
    const batch = await batchWith([
      { companyName: 'Hotel Sol', country: 'Spain', email: 'ana@hotelsol.es' },
      { companyName: 'Café Luna', country: 'Spain', email: 'luis@cafeluna.es' },
    ]);
    const rows = await importNow(batch.id);
    // As if the job gave up after the first row.
    await prisma.importRow.update({ where: { id: rows[1]!.id }, data: { outcome: null } });
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Failed', importError: 'job_failed' } });
    const detail = await get(`/api/imports/batches/${batch.id}`);
    expect(detail.json()).toMatchObject({ canUndo: true });
    const r = await undoBatch(authOf(admin), batch.id);
    expect(r.remove.leads).toHaveLength(2);
    expect(await prisma.lead.count()).toBe(0);

    const fresh = await batchWith([{ companyName: 'X', country: 'Spain', email: 'x@x.test' }]);
    const res = await post(`/api/imports/batches/${fresh.id}/undo`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'batch_locked' });
  });
});
