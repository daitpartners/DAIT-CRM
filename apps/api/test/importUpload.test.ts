import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { STALE_AFTER_MS } from '../src/jobs/queue';
import { runOnce } from '../src/jobs/runner';
import { importReadFileHandler, importReadOptions } from '../src/jobs/handlers/importReadFile';
import { sweepImportFiles } from '../src/imports/batches';
import { readImportFile, removeBatchFiles, saveImportFile, storageDir } from '../src/imports/storage';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeLead, makeUser, signIn } from './factory';
import { pdfWithText } from './importFixtures';

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
  storage = await mkdtemp(path.join(tmpdir(), 'crm-import-'));
  vi.stubEnv('STORAGE_DIR', storage);
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(storage, { recursive: true, force: true });
});

type Role = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER';
async function as(role: Role, name?: string, timezone?: string) {
  let user = await makeUser({ role, name });
  if (timezone) user = await prisma.user.update({ where: { id: user.id }, data: { timezone } });
  return { user, cookie: await signIn(app, user) };
}

const json = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie } });

const upload = (batchId: number, name: string, data: Buffer, cookie: string) =>
  app.inject({
    method: 'POST', url: `/api/imports/batches/${batchId}/files?name=${encodeURIComponent(name)}`,
    headers: { cookie, 'content-type': 'application/octet-stream' }, payload: data,
  });

async function newBatch(cookie: string, body: object = { language: 'en', leadType: 'Prospect' }) {
  const res = await json('POST', '/api/imports/batches', cookie, body);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: number; number: string; status: string };
}

const runReadJob = () => runOnce({ types: ['import_read_file'], handlers: { import_read_file: importReadFileHandler }, graph: fakeGraph() });

describe('import rights', () => {
  it('Sales Representatives and Data Research Users get 403 on every route', async () => {
    const { cookie: admin } = await as('ADMINISTRATOR');
    const batch = await newBatch(admin);
    for (const role of ['SALES_REPRESENTATIVE', 'DATA_RESEARCH_USER'] as const) {
      const { cookie } = await as(role);
      const responses = await Promise.all([
        json('GET', '/api/imports/options', cookie),
        json('POST', '/api/imports/batches', cookie, { language: 'en', leadType: 'Lead' }),
        json('PATCH', `/api/imports/batches/${batch.id}`, cookie, { language: 'es' }),
        upload(batch.id, 'a.txt', Buffer.from('Acme'), cookie),
        json('GET', `/api/imports/batches/${batch.id}/files`, cookie),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([403, 403, 403, 403, 403]);
    }
    expect(await prisma.importBatch.count()).toBe(1);
    expect(await prisma.importFile.count()).toBe(0);
  });

  it('a Manager may import', async () => {
    const { cookie } = await as('MANAGER');
    expect((await newBatch(cookie, { language: 'es', leadType: 'Lead' })).number).toMatch(/^IMPORT-\d{4}-\d{2}-\d{2}$/);
  });
});

describe('batches', () => {
  it('refuses a batch without a language and an import type (no defaults)', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const res = await json('POST', '/api/imports/batches', cookie, {});
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation');
    expect(body.issues.map((i: { path: string[] }) => i.path.join('.')).sort()).toEqual(['language', 'leadType']);
    expect(await prisma.importBatch.count()).toBe(0);
  });

  it("numbers batches by the creator's local date, -2 for the second one that day", async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-24T20:00:00Z') });
    const { user, cookie } = await as('ADMINISTRATOR', 'Maya Patel', 'Asia/Kolkata');
    const first = await newBatch(cookie);
    expect(first).toMatchObject({ number: 'IMPORT-2026-11-25', status: 'Uploading' });
    const second = await newBatch(cookie, { language: 'es', leadType: 'Lead' });
    expect(second.number).toBe('IMPORT-2026-11-25-2');
    const row = await prisma.importBatch.findUniqueOrThrow({ where: { id: second.id } });
    expect(row).toMatchObject({ language: 'es', leadType: 'Lead', status: 'Uploading', createdById: user.id });
    // A London user the same instant is still on the 24th.
    const { cookie: london } = await as('MANAGER', 'Lon Don', 'Europe/London');
    expect((await newBatch(london)).number).toBe('IMPORT-2026-11-24');
  });

  it('skips numbers already used by leads imported from the command line', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-22T12:00:00Z') });
    await makeLead({ importBatch: 'IMPORT-2026-11-22' });
    const { cookie } = await as('ADMINISTRATOR');
    expect((await newBatch(cookie)).number).toBe('IMPORT-2026-11-22-2');
    expect((await newBatch(cookie)).number).toBe('IMPORT-2026-11-22-3');
  });

  it('concurrent creates get different numbers', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const all = await Promise.all([1, 2, 3].map(() => json('POST', '/api/imports/batches', cookie, { language: 'en', leadType: 'Lead' })));
    expect(all.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(all.map((r) => r.json().number)).size).toBe(3);
  });

  it('language and type can change until Importing', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    const ok = await json('PATCH', `/api/imports/batches/${batch.id}`, cookie, { language: 'es' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: batch.id, language: 'es', leadType: 'Prospect' });
    expect((await json('PATCH', `/api/imports/batches/${batch.id}`, cookie, {})).statusCode).toBe(400);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Importing' } });
    const locked = await json('PATCH', `/api/imports/batches/${batch.id}`, cookie, { leadType: 'Lead' });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toEqual({ error: 'batch_locked' });
    expect((await json('PATCH', '/api/imports/batches/999999', cookie, { language: 'en' })).statusCode).toBe(404);
  });
});

describe('file upload', () => {
  it('stores a PDF under the storage folder, queues reading, and the job reads it', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    const data = await pdfWithText(['Acme Widgets Ltd\nsales@acme.test', 'Beta LLC\ninfo@beta.test']);
    const res = await upload(batch.id, 'Expo exhibitors.PDF', data, cookie);
    expect(res.statusCode).toBe(201);
    const file = res.json();
    expect(file).toMatchObject({ name: 'Expo exhibitors.PDF', ext: 'pdf', size: data.length, status: 'Reading' });

    const stored = path.join(storage, 'imports', String(batch.id), String(file.id));
    const st = await stat(stored);
    expect(st.mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(stored))).mode & 0o777).toBe(0o700);
    const row = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.storagePath).toBe(`imports/${batch.id}/${file.id}`);
    expect((await readImportFile(row.storagePath)).equals(data)).toBe(true);

    const jobs = await prisma.job.findMany({ where: { type: 'import_read_file' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'queued', maxAttempts: 1, payload: { fileId: file.id } });

    expect(await runReadJob()).toBe(true);
    const read = await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(read).toMatchObject({ status: 'Read', meta: { pages: 2, textFound: true }, error: null });
    expect(read.readAt).toBeInstanceOf(Date);

    const list = await json('GET', `/api/imports/batches/${batch.id}/files`, cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      items: [{ id: file.id, name: 'Expo exhibitors.PDF', ext: 'pdf', size: data.length, status: 'Read', meta: { pages: 2, textFound: true }, error: null }],
    });
  });

  it('refuses an 11th file, a type not on the list, an empty file and one over 20 MB', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    for (let i = 0; i < 10; i += 1) {
      expect((await upload(batch.id, `list ${i}.txt`, Buffer.from(`Acme ${i}`), cookie)).statusCode).toBe(201);
    }
    const eleventh = await upload(batch.id, 'list 11.txt', Buffer.from('Acme'), cookie);
    expect(eleventh.statusCode).toBe(400);
    expect(eleventh.json()).toEqual({ error: 'too_many_files' });

    const other = await newBatch(cookie);
    const exe = await upload(other.id, 'setup.exe', Buffer.from('MZ'), cookie);
    expect([exe.statusCode, exe.json()]).toEqual([400, { error: 'file_type' }]);
    const noExt = await upload(other.id, 'README', Buffer.from('x'), cookie);
    expect([noExt.statusCode, noExt.json()]).toEqual([400, { error: 'file_type' }]);
    const empty = await upload(other.id, 'empty.csv', Buffer.alloc(0), cookie);
    expect([empty.statusCode, empty.json()]).toEqual([400, { error: 'file_size' }]);
    const big = await upload(other.id, 'big.csv', Buffer.alloc(21 * 1024 * 1024, 0x41), cookie);
    expect([big.statusCode, big.json()]).toEqual([400, { error: 'file_size' }]);
    expect(await prisma.importFile.count({ where: { batchId: other.id } })).toBe(0);

    const missingName = await app.inject({
      method: 'POST', url: `/api/imports/batches/${other.id}/files`,
      headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x'),
    });
    expect(missingName.statusCode).toBe(400);
    expect((await upload(999999, 'a.csv', Buffer.from('x'), cookie)).statusCode).toBe(404);
  });

  it('refuses files once the batch has moved past sorting', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Sorting' } });
    expect((await upload(batch.id, 'a.csv', Buffer.from('Company\nAcme'), cookie)).statusCode).toBe(201);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Waiting for review' } });
    const res = await upload(batch.id, 'b.csv', Buffer.from('Company\nAcme'), cookie);
    expect([res.statusCode, res.json()]).toEqual([409, { error: 'batch_locked' }]);
  });

  it('a file that cannot be read becomes Failed unreadable', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    const file = (await upload(batch.id, 'a.csv', Buffer.from('Company\nAcme'), cookie)).json();
    await removeBatchFiles(batch.id);
    expect(await runReadJob()).toBe(true);
    expect(await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ status: 'Failed', error: 'unreadable' });
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'import_read_file' } })).status).toBe('failed');
  });

  it('a read that runs past the timeout leaves the file Failed timeout', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    const file = (await upload(batch.id, 'list.pdf', await pdfWithText(['Acme Widgets Ltd sales@acme.test']), cookie)).json();
    importReadOptions.timeoutMs = 1;
    try {
      expect(await runReadJob()).toBe(true);
    } finally {
      delete importReadOptions.timeoutMs;
    }
    expect(await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ status: 'Failed', error: 'timeout' });
  });

  it('crash output goes to the job error only, never to the file', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    const file = (await upload(batch.id, 'a.csv', Buffer.from('Company\nAcme'), cookie)).json();
    importReadOptions.failWith = 'FATAL something broke';
    try {
      expect(await runReadJob()).toBe(true);
    } finally {
      delete importReadOptions.failWith;
    }
    expect(await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ status: 'Failed', error: 'unreadable' });
    const job = await prisma.job.findFirstOrThrow({ where: { type: 'import_read_file' } });
    expect(job.status).toBe('failed');
    expect(job.lastError).toContain('FATAL something broke');
  });

  it('a file the reader refuses keeps its reason', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    const file = (await upload(batch.id, 'sheet.xlsx', Buffer.from('not a spreadsheet'), cookie)).json();
    await runReadJob();
    expect(await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } }))
      .toMatchObject({ status: 'Failed', error: 'invalid' });
  });
});

describe('reading sweep', () => {
  it('files left Reading with no job for them become Failed', async () => {
    const { user } = await as('ADMINISTRATOR');
    const batch = await prisma.importBatch.create({ data: { number: 'IMPORT-2026-11-24', language: 'en', leadType: 'Lead', createdById: user.id } });
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000);
    const mk = (name: string, createdAt: Date, status = 'Reading') =>
      prisma.importFile.create({ data: { batchId: batch.id, name, ext: 'csv', size: 1, storagePath: '', status, createdAt } });
    const lost = await mk('lost.csv', old);
    const queued = await mk('queued.csv', old);
    const fresh = await mk('fresh.csv', new Date());
    const done = await mk('done.csv', old, 'Read');
    await prisma.job.create({ data: { type: 'import_read_file', payload: { fileId: queued.id }, runAt: new Date(), status: 'queued', maxAttempts: 1 } });
    await prisma.job.create({ data: { type: 'import_read_file', payload: { fileId: lost.id }, runAt: old, status: 'failed', maxAttempts: 1 } });

    expect(await sweepImportFiles()).toBe(1);
    const status = async (id: number) => prisma.importFile.findUniqueOrThrow({ where: { id } });
    expect(await status(lost.id)).toMatchObject({ status: 'Failed', error: 'interrupted' });
    expect((await status(queued.id)).status).toBe('Reading');
    expect((await status(fresh.id)).status).toBe('Reading');
    expect((await status(done.id)).status).toBe('Read');
  });

  it('a running job keeps its file while its lock is fresh; a stale lock means the read was lost', async () => {
    const { user } = await as('ADMINISTRATOR');
    const batch = await prisma.importBatch.create({ data: { number: 'IMPORT-2026-11-24', language: 'en', leadType: 'Lead', createdById: user.id } });
    const old = new Date(Date.now() - STALE_AFTER_MS - 60_000);
    const mk = (name: string) =>
      prisma.importFile.create({ data: { batchId: batch.id, name, ext: 'csv', size: 1, storagePath: '', status: 'Reading', createdAt: old } });
    const live = await mk('live.csv');
    const stale = await mk('stale.csv');
    const job = (fileId: number, lockedAt: Date) => prisma.job.create({
      data: { type: 'import_read_file', payload: { fileId }, runAt: old, status: 'running', lockedAt, maxAttempts: 1 },
    });
    await job(live.id, new Date());
    await job(stale.id, old);
    expect(await sweepImportFiles()).toBe(1);
    expect((await prisma.importFile.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('Reading');
    expect(await prisma.importFile.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: 'Failed', error: 'interrupted' });
  });

  it('a file swept to Failed is not overwritten by its job afterwards', async () => {
    const { cookie } = await as('ADMINISTRATOR');
    const batch = await newBatch(cookie);
    const file = (await upload(batch.id, 'a.csv', Buffer.from('Company\nAcme'), cookie)).json();
    await prisma.importFile.update({ where: { id: file.id }, data: { status: 'Failed', error: 'interrupted' } });
    expect(await runReadJob()).toBe(true);
    expect(await prisma.importFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ status: 'Failed', error: 'interrupted' });
  });
});

describe('storage', () => {
  it('keeps every path inside the imports folder', async () => {
    await expect(readImportFile('../secret')).rejects.toThrow();
    await expect(readImportFile('imports/../../etc/passwd')).rejects.toThrow();
    await writeFile(path.join(storage, 'outside'), 'x');
    await expect(readImportFile('outside')).rejects.toThrow();
    expect(await saveImportFile(7, 9, Buffer.from('hi'))).toBe('imports/7/9');
    expect((await readImportFile('imports/7/9')).toString()).toBe('hi');
  });

  it('needs STORAGE_DIR in production', () => {
    expect(storageDir({ STORAGE_DIR: '/srv/x' })).toBe('/srv/x');
    expect(() => storageDir({ NODE_ENV: 'production' })).toThrow('STORAGE_DIR is required in production');
    expect(storageDir({ NODE_ENV: 'development' })).toMatch(/[/\\]\.storage$/);
  });
});

describe('options', () => {
  it('lists the language allocation rules with first names, Claude state and the limits', async () => {
    const { cookie } = await as('ADMINISTRATOR', 'Maya Patel');
    const [carlos, seba, deepak, lakshita] = await Promise.all(
      ['Carlos Ruiz', 'Seba Díaz', 'Deepak Singh', 'Lakshita Rao'].map((name) => makeUser({ name, role: 'SALES_REPRESENTATIVE' })),
    );
    await prisma.allocationRule.createMany({
      data: [
        { name: 'English market (US and Canada)', matchCountries: ['United States', 'Canada'], matchLanguage: 'en', assignTo: [deepak.id, lakshita.id], priority: 2 },
        { name: 'Spanish market (Español)', matchCountries: ['*'], matchLanguage: 'es', assignTo: [carlos.id, seba.id], priority: 1 },
        { name: 'Old Spanish rule', matchCountries: ['*'], matchLanguage: 'es', assignTo: [carlos.id], priority: 3, isActive: false },
        { name: 'India', matchCountries: ['India'], matchLanguage: null, assignTo: deepak.id, priority: 4 },
      ],
    });
    // Claude switched on with a cap, but no token on this server: not on.
    await prisma.enrichmentSettings.create({ data: { id: 1, claudeEnabled: true, claudeMonthlyRunCap: 100, webSearchEnabled: true } });
    const res = await json('GET', '/api/imports/options', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      languages: [
        { value: 'en', rules: [{ name: 'English market (US and Canada)', people: ['Deepak', 'Lakshita'] }] },
        { value: 'es', rules: [{ name: 'Spanish market (Español)', people: ['Carlos', 'Seba'] }] },
      ],
      claude: { on: false, runsThisMonth: 0, cap: 100, webSearch: true },
      limits: { maxFiles: 10, maxBytes: 20 * 1024 * 1024, maxRows: 5000 },
    });
  });
});
