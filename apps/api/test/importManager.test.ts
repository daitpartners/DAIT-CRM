import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowFields } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { listBatches, pruneImports } from '../src/imports/manager';
import { saveImportFile, storageDir } from '../src/imports/storage';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeLead, makeUser, signIn } from './factory';

let app: FastifyInstance;
let storage: string;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  storage = await mkdtemp(path.join(tmpdir(), 'crm-manager-'));
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
  admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  cookie = await signIn(app, admin);
});

const get = (url: string, c = cookie) => app.inject({ method: 'GET', url, headers: { cookie: c } });
const DAY = 24 * 60 * 60_000;

let seq = 0;
async function batch(o: {
  status?: string; language?: string; files?: string[]; importedAt?: Date | null; importedCount?: number; createdAt?: Date;
  research?: { done: number; total: number };
  rows?: { fields?: RowFields; outcome?: string; outcomeCode?: string; error?: string; researchStatus?: string }[];
} = {}) {
  seq += 1;
  const b = await prisma.importBatch.create({
    data: {
      number: `IMPORT-2026-11-${String(seq).padStart(2, '0')}`, language: o.language ?? 'en', leadType: 'Lead', status: o.status ?? 'Sorting',
      createdById: admin.id, importedAt: o.importedAt ?? null, importedCount: o.importedCount ?? 0,
      rowCount: o.rows?.length ?? 0, researchDone: o.research?.done ?? 0, researchTotal: o.research?.total ?? 0,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    },
  });
  const files = [];
  for (const name of o.files ?? ['Expo-visitors.xlsx']) {
    const f = await prisma.importFile.create({
      data: { batchId: b.id, name, ext: name.split('.').pop()!, size: 5, storagePath: '', status: 'Read', ...(o.createdAt ? { createdAt: o.createdAt } : {}) },
    });
    const rel = await saveImportFile(b.id, f.id, Buffer.from(`file ${name}`));
    files.push(await prisma.importFile.update({ where: { id: f.id }, data: { storagePath: rel } }));
  }
  for (const [i, r] of (o.rows ?? []).entries()) {
    await prisma.importRow.create({
      data: {
        batchId: b.id, fileId: files[0]!.id, position: i + 1, originKind: 'row', originN: i + 2, fields: r.fields ?? { companyName: `Row ${i}` },
        status: 'Ready', include: true, outcome: r.outcome ?? null, outcomeCode: r.outcomeCode ?? null, error: r.error ?? null,
        researchStatus: r.researchStatus ?? null,
      },
    });
  }
  if (o.createdAt) await prisma.$executeRaw`UPDATE import_batches SET updated_at = ${o.createdAt} WHERE id = ${b.id}`;
  return { batch: b, files };
}

describe('Data manager list', () => {
  it('filters by language and status (total filtered, count all), searches file names, tiles', async () => {
    const now = new Date();
    await batch({
      status: 'Imported', language: 'es', files: ['Feria-Madrid.xlsx', 'extra.csv'], importedAt: now, importedCount: 3,
      rows: [{ outcome: 'Imported' }, { outcome: 'Skipped', outcomeCode: 'already_in_crm' }, { outcome: 'Skipped', outcomeCode: 'already_in_crm' }, { outcome: 'Skipped', outcomeCode: 'unticked' }],
    });
    await batch({ status: 'Imported', language: 'en', importedAt: new Date(now.getTime() - 70 * DAY), importedCount: 9, rows: [{ outcome: 'Skipped', outcomeCode: 'already_in_crm' }] });
    await batch({ status: 'Waiting for review', language: 'en' });
    await batch({ status: 'Researching', language: 'es', research: { done: 1, total: 3 }, rows: [{ researchStatus: 'waiting' }, { researchStatus: 'running' }, { researchStatus: 'everything' }] });

    const all = await get('/api/imports/batches');
    expect(all.statusCode, all.body).toBe(200);
    const body = all.json();
    expect(body).toMatchObject({ total: 4, count: 4 });
    expect(body.tiles).toEqual({
      importedThisMonth: 3, importedBatchesThisMonth: 1, waitingForReview: 1, stillResearching: 2, duplicatesSkippedThisMonth: 2,
    });
    const madrid = body.items.find((i: { files: { first: string } }) => i.files.first === 'Feria-Madrid.xlsx');
    expect(madrid).toMatchObject({ by: 'Deepak Singh', language: 'es', files: { first: 'Feria-Madrid.xlsx', more: 1 }, importedCount: 3, status: 'Imported', undoneAt: null });
    const sorting = body.items.find((i: { status: string }) => i.status === 'Waiting for review');
    expect(sorting).toMatchObject({ importedCount: null, newCompanyCount: null, skippedCount: null, research: null });

    const es = (await get('/api/imports/batches?language=es')).json();
    expect(es).toMatchObject({ total: 2, count: 4 });
    const imported = (await get('/api/imports/batches?status=Imported&language=en')).json();
    expect(imported).toMatchObject({ total: 1, count: 4 });
    const search = (await listBatches({ page: 1, pageSize: 25, dir: 'asc', q: 'feria' }));
    expect(search.items.map((i) => i.files.first)).toEqual(['Feria-Madrid.xlsx']);
    expect(search).toMatchObject({ total: 1, count: 4 });
    const researching = body.items.find((i: { status: string }) => i.status === 'Researching');
    expect(researching.research).toEqual({ done: 1, total: 3 });
    expect(madrid.research).toBeNull();

    const rep = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    expect((await get('/api/imports/batches', rep)).statusCode).toBe(403);
  });

  it('batch detail and the rows of the imported / skipped / errors filters', async () => {
    const company = await makeCompany({ name: 'Hotel Sol', country: 'Spain' });
    const lead = await makeLead({ companyId: company.id, companyName: 'Hotel Sol', country: 'Spain' });
    const { batch: b } = await batch({
      status: 'Imported', importedAt: new Date(), importedCount: 1,
      rows: [{ outcome: 'Imported' }, { outcome: 'Error', outcomeCode: 'import_error', error: 'invalid_status' }, { outcome: 'Skipped', outcomeCode: 'unticked' }],
    });
    const rows = await prisma.importRow.findMany({ where: { batchId: b.id }, orderBy: { position: 'asc' } });
    await prisma.importRow.update({ where: { id: rows[0]!.id }, data: { leadId: lead.id, companyId: company.id, companyCreated: true } });

    const imported = (await get(`/api/imports/batches/${b.id}/rows?filter=imported`)).json();
    expect(imported.total).toBe(1);
    expect(imported.items[0]).toMatchObject({
      lead: { id: lead.id, number: lead.number }, company: { id: company.id, number: company.number, created: true }, error: null, outcomeCode: null,
    });
    const errors = (await get(`/api/imports/batches/${b.id}/rows?filter=errors`)).json();
    expect(errors.items[0]).toMatchObject({ error: 'invalid_status', outcomeCode: 'import_error', lead: null, company: null });
    const skipped = (await get(`/api/imports/batches/${b.id}/rows?filter=skipped`)).json();
    expect(skipped.items[0]).toMatchObject({ outcomeCode: 'unticked' });
    // The step-2 filters stay as they were.
    expect((await get(`/api/imports/batches/${b.id}/rows`)).json().items[0]).not.toHaveProperty('lead');

    const detail = await get(`/api/imports/batches/${b.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      id: b.id, number: b.number, status: 'Imported', counts: { imported: 1, skipped: 1, errors: 1 }, canUndo: true,
      files: [{ name: 'Expo-visitors.xlsx', deletedAt: null }],
    });
    expect((await get('/api/imports/batches/999999')).statusCode).toBe(404);
  });
});

describe('original files and retention', () => {
  it('download for import_leads (attachment, RFC 5987 name, nosniff); 410 after 90 days; abandoned batches deleted', async () => {
    const { files: [file] } = await batch({ status: 'Imported', importedAt: new Date(), files: ['Feria ‮gpj.exe Madrid "año".xlsx'] });
    const mgr = await signIn(app, await makeUser({ role: 'MANAGER' }));
    const res = await get(`/api/imports/files/${file!.id}/original`, mgr);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toBe('file Feria ‮gpj.exe Madrid "año".xlsx');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toBe('application/octet-stream');
    const cd = String(res.headers['content-disposition']);
    expect(cd).toMatch(/^attachment; /);
    expect(cd).toContain("filename*=UTF-8''Feria%20gpj.exe%20Madrid%20%22a%C3%B1o%22.xlsx");
    expect(cd).not.toContain('‮');
    expect(cd).not.toContain('inline');
    const rep = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    expect((await get(`/api/imports/files/${file!.id}/original`, rep)).statusCode).toBe(403);

    // An abandoned Sorting batch, 91 days idle, and a recent one.
    const old = new Date(Date.now() - 91 * DAY);
    const { batch: abandoned, files: oldFiles } = await batch({ status: 'Sorting', createdAt: old });
    const { batch: recent } = await batch({ status: 'Sorting' });
    const oldPath = path.join(storageDir(), oldFiles[0]!.storagePath);
    await stat(oldPath);
    expect(await pruneImports()).toEqual({ files: 0, batches: 1 });
    expect(await prisma.importBatch.findUnique({ where: { id: abandoned.id } })).toBeNull();
    await expect(stat(oldPath)).rejects.toThrow();
    expect(await prisma.importBatch.count({ where: { id: recent.id } })).toBe(1);
    expect((await get(`/api/imports/files/${file!.id}/original`, mgr)).statusCode).toBe(200);

    // 91 days later: the imported batch's original goes (the batch and its rows stay); the then-idle Sorting batch goes.
    const later = new Date(Date.now() + 91 * DAY);
    expect(await pruneImports(later)).toEqual({ files: 1, batches: 1 });
    const gone = await get(`/api/imports/files/${file!.id}/original`, mgr);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toEqual({ error: 'file_deleted' });
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file!.id } })).deletedAt).not.toBeNull();
    expect(await prisma.importBatch.count({ where: { id: file!.batchId } })).toBe(1);
    await expect(stat(path.join(storageDir(), file!.storagePath))).rejects.toThrow();
    expect(await prisma.importBatch.findUnique({ where: { id: recent.id } })).toBeNull();
    expect(await pruneImports(later)).toEqual({ files: 0, batches: 0 });
  });

  it('a batch still in use keeps its originals, however old: Waiting for review touched recently, a 95-day-old file', async () => {
    const { batch: live, files: [file] } = await batch({ status: 'Waiting for review' });
    await prisma.importFile.update({ where: { id: file!.id }, data: { createdAt: new Date(Date.now() - 95 * DAY) } });
    // A Failed batch whose import job is still queued keeps them too.
    const { batch: failed, files: [failedFile] } = await batch({ status: 'Failed', createdAt: new Date(Date.now() - 95 * DAY) });
    await prisma.job.create({ data: { type: 'import_commit', payload: { batchId: failed.id }, status: 'queued', runAt: new Date() } });
    expect(await pruneImports()).toEqual({ files: 0, batches: 0 });
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file!.id } })).deletedAt).toBeNull();
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: failedFile!.id } })).deletedAt).toBeNull();
    expect(await prisma.importBatch.count({ where: { id: { in: [live.id, failed.id] } } })).toBe(2);
    await stat(path.join(storageDir(), file!.storagePath));
    // Once the Failed batch's job is gone, its 95-day-old original goes (it imported nothing, so the batch goes too).
    await prisma.job.deleteMany({});
    expect(await pruneImports()).toEqual({ files: 0, batches: 1 });
  });

  it('retention keeps young files and batches', async () => {
    const { batch: b, files: [file] } = await batch({ status: 'Sorting', createdAt: new Date(Date.now() - 30 * DAY) });
    expect(await pruneImports()).toEqual({ files: 0, batches: 0 });
    expect(await prisma.importBatch.count({ where: { id: b.id } })).toBe(1);
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: file!.id } })).deletedAt).toBeNull();
  });
});
