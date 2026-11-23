import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportRow } from '@prisma/client';
import type { ResearchValue, RowFields } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { monthTotals } from '../src/research/service';
import { ClaudeRunError, type ClaudeRunRequest, type ClaudeRunner } from '../src/research/providers';
import type { ImportClaude, ImportDeps } from '../src/imports/claude';
import {
  pauseResearch, researchNextRow, researchRow, resumeResearch, startBatchResearch, sweepImportResearch,
} from '../src/imports/research';
import { importResearchDeps, importResearchHandler } from '../src/jobs/handlers/importResearch';
import { runOnce } from '../src/jobs/runner';
import { STALE_AFTER_MS } from '../src/jobs/queue';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeUser, signIn } from './factory';
import { FIXTURE_HOSTS, fixtureResolver, startFixtureServer, type FixtureServer } from './fixtureSites';

let app: FastifyInstance;
let site: FixtureServer;
beforeAll(async () => {
  app = await buildApp();
  site = await startFixtureServer();
});
afterAll(async () => {
  await app.close();
  await site.close();
});
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  vi.stubEnv('RESEARCH_TEST_ALLOW_HOSTS', FIXTURE_HOSTS.join(','));
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of Object.keys(importResearchDeps) as (keyof ImportDeps)[]) delete importResearchDeps[k];
});

/** Claude Code available: a token and an executable binary (this Node binary stands in; the runner is always faked). */
const claudeEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token', CLAUDE_BIN: process.execPath };
const reader = { resolve: fixtureResolver() };
const offDeps: ImportDeps = { reader, env: {} };
const onDeps = (claude: ClaudeRunner): ImportDeps => ({ reader, env: claudeEnv, claude });

type Answer = Record<string, { value: string; sourceUrl: string } | null>;
/** A fake runner giving each call the answer (the fields its schema asks for, null unless given); records every request. */
function fakeRunner(answer: Answer | Error, searchUrls: string[] = [], confidence = 'High', during?: () => Promise<void>) {
  const calls: ClaudeRunRequest[] = [];
  const runner: ClaudeRunner = async (req) => {
    calls.push(req);
    if (during) await during();
    if (answer instanceof Error) throw answer;
    const fields = Object.keys((req.schema as { properties: Record<string, unknown> }).properties).filter((k) => k !== 'confidence');
    return { output: { ...Object.fromEntries(fields.map((f) => [f, answer[f] ?? null])), confidence }, searchUrls };
  };
  return { runner, calls };
}

let seq = 0;
async function batchWith(rows: (RowFields & { $status?: string; $include?: boolean })[], status = 'Waiting for review') {
  seq += 1;
  const batch = await prisma.importBatch.create({
    data: { number: `IMPORT-2026-11-24-${seq + 500}`, language: 'en', leadType: 'Prospect', status },
  });
  const file = await prisma.importFile.create({
    data: { batchId: batch.id, name: 'Expo-visitors.xlsx', ext: 'xlsx', size: 1, storagePath: '', status: 'Read' },
  });
  for (const [i, { $status, $include, ...fields }] of rows.entries()) {
    await prisma.importRow.create({
      data: {
        batchId: batch.id, fileId: file.id, position: i + 1, originKind: 'row', originN: i + 2, fields,
        status: $status ?? 'Missing details', include: $include ?? true,
      },
    });
  }
  return batch;
}
const rowsOf = (batchId: number) => prisma.importRow.findMany({ where: { batchId }, orderBy: { position: 'asc' } });
const batchOf = (id: number) => prisma.importBatch.findUniqueOrThrow({ where: { id } });
const researchOf = (r: { research: unknown }) => r.research as Record<string, ResearchValue>;
const activityOf = (b: { activity: unknown }) => (b.activity as { at: string; text: string }[]).map((a) => a.text);
const queuedJobs = () => prisma.job.findMany({ where: { type: 'import_research', status: 'queued' } });
const claudeOn = (cap: number, webSearchEnabled = false) =>
  prisma.enrichmentSettings.create({ data: { id: 1, claudeEnabled: true, claudeMonthlyRunCap: cap, webSearchEnabled } });

describe('import research · website reader only (Claude off)', () => {
  it('a row with its own website: email and city found from the site, "some"; a row without a website: "nothing"', async () => {
    const freight = site.url('freight.test');
    const batch = await batchWith([
      { companyName: 'Fixture Freight', country: 'India', website: freight },
      { companyName: 'No Site Traders', country: 'India' },
      { companyName: 'Ready Co', country: 'India', email: 'a@ready.test', $status: 'Ready' },
      { companyName: 'Unticked Co', country: 'India', website: freight, $include: false },
      { country: 'India', phone: '+91 20 5555 0101' },
    ]);
    const { runner, calls } = fakeRunner({});
    expect(await startBatchResearch(batch.id, offDeps)).toEqual({ total: 2 });
    let b = await batchOf(batch.id);
    expect(b).toMatchObject({ status: 'Researching', researchTotal: 2, researchDone: 0, researchEngine: 'Website reader', researchPaused: false });
    expect(b.researchStartedAt).not.toBeNull();
    expect(activityOf(b)[0]).toBe('Started research for 2 rows · Website reader');
    expect((await rowsOf(batch.id)).map((r) => r.researchStatus)).toEqual(['waiting', 'waiting', null, null, null]);
    expect(await queuedJobs()).toHaveLength(1);

    expect(await researchNextRow(batch.id, { ...offDeps, claude: runner })).toBe('more');
    const [first] = await rowsOf(batch.id);
    expect(first).toMatchObject({ researchStatus: 'some', status: 'Missing details', claudeAt: null });
    expect(first!.researchedAt).not.toBeNull();
    const found = researchOf(first!);
    expect(Object.keys(found).sort()).toEqual(['city', 'email']);
    expect(found.email).toEqual({ value: 'office@freight.test', sourceUrl: freight, sourceLabel: 'freight.test', confidence: 85 });
    expect(found.city).toEqual({ value: 'Pune', sourceUrl: freight, sourceLabel: 'freight.test', confidence: 90 });
    expect(first!.researchNote).toBe('1 page read, 2 fields filled');
    expect((first!.fields as RowFields).email).toBeUndefined();

    expect(await researchNextRow(batch.id, { ...offDeps, claude: runner })).toBe('more');
    const second = (await rowsOf(batch.id))[1]!;
    expect(second).toMatchObject({ researchStatus: 'nothing', researchNote: 'No website to read', claudeAt: null, research: {} });

    expect(await researchNextRow(batch.id, { ...offDeps, claude: runner })).toBe('done');
    b = await batchOf(batch.id);
    expect(b).toMatchObject({ status: 'Waiting for review', researchDone: 2 });
    expect(activityOf(b).slice(0, 3)).toEqual([
      'Research finished', 'No Site Traders — No website to read', 'Fixture Freight — 1 page read, 2 fields filled',
    ]);
    expect(calls).toHaveLength(0);
    expect((await monthTotals(prisma)).claudeRuns).toBe(0);
  });

  it('a batch with no target rows goes straight to Waiting for review; a batch from Importing on is locked', async () => {
    const batch = await batchWith([{ companyName: 'Ready Co', country: 'India', email: 'a@ready.test', $status: 'Ready' }], 'Sorting');
    expect(await startBatchResearch(batch.id, offDeps)).toEqual({ total: 0 });
    expect((await batchOf(batch.id)).status).toBe('Waiting for review');
    expect(await queuedJobs()).toHaveLength(0);
    const locked = await batchWith([{ companyName: 'X', website: 'x.test' }], 'Importing');
    await expect(startBatchResearch(locked.id, offDeps)).rejects.toMatchObject({ code: 'batch_locked', status: 409 });
  });

  it('the daily research limit does not apply to import research', async () => {
    await prisma.enrichmentSettings.create({ data: { id: 1, dailyRunLimit: 1 } });
    const company = await makeCompany({ website: site.url('site.test') });
    await prisma.enrichmentRun.create({ data: { companyId: company.id, trigger: 'Manual', engine: 'Website reader', status: 'Completed', sources: ['website'] } });
    const batch = await batchWith([
      { companyName: 'Fixture Freight', country: 'India', website: site.url('freight.test') },
      { companyName: 'Fixture Freight Two', country: 'India', website: site.url('freight.test') },
    ]);
    await startBatchResearch(batch.id, offDeps);
    expect(await researchNextRow(batch.id, offDeps)).toBe('more');
    expect(await researchNextRow(batch.id, offDeps)).toBe('more');
    expect(await researchNextRow(batch.id, offDeps)).toBe('done');
    expect((await rowsOf(batch.id)).map((r) => r.researchStatus)).toEqual(['some', 'some']);
    expect((await batchOf(batch.id)).researchStopReason).toBeNull();
  });
});

describe('import research · Claude', () => {
  it('a website found by web search is kept with the label "website search"; a value with an unknown source is dropped', async () => {
    await claudeOn(10, true);
    const batch = await batchWith([{ companyName: 'Brightline Dental Clinics', country: 'Canada', phone: '+1 416 555 0144' }]);
    const { runner, calls } = fakeRunner({
      website: { value: 'https://brightline.example/', sourceUrl: 'https://brightline.example/' },
      city: { value: 'Toronto', sourceUrl: 'https://www.brightline.example/contact/' },
      designation: { value: 'Clinical Director', sourceUrl: 'https://invented.example/team' },
    }, ['https://brightline.example/', 'https://brightline.example/contact']);
    expect(await startBatchResearch(batch.id, onDeps(runner))).toEqual({ total: 1 });
    expect((await batchOf(batch.id)).researchEngine).toBe('Website reader + Claude Code sonnet');
    expect(await researchNextRow(batch.id, onDeps(runner))).toBe('more');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.webSearch).toBe(true);
    expect(calls[0]!.prompt).toContain('Brightline Dental Clinics');
    const asked = Object.keys((calls[0]!.schema as { properties: object }).properties).sort();
    expect(asked).toEqual(['city', 'confidence', 'contactName', 'designation', 'email', 'industry', 'website']);
    const row = (await rowsOf(batch.id))[0]!;
    const found = researchOf(row);
    expect(found.website).toEqual({ value: 'https://brightline.example/', sourceUrl: 'https://brightline.example/', sourceLabel: 'website search', confidence: 85 });
    expect(found.city).toMatchObject({ value: 'Toronto', confidence: 85 });
    expect(found.designation).toBeUndefined();
    expect(row.claudeAt).not.toBeNull();
    expect(row).toMatchObject({ researchStatus: 'some', status: 'Missing details', researchNote: 'website found by search, 2 fields filled' });
    expect((await monthTotals(prisma)).claudeRuns).toBe(1);
  });

  it('a Claude call that fails still counts toward the monthly cap (claudeAt set)', async () => {
    await claudeOn(10, true);
    const batch = await batchWith([{ companyName: 'Kestrel Engineering', country: 'Canada' }]);
    const { runner, calls } = fakeRunner(new ClaudeRunError('failed'));
    await startBatchResearch(batch.id, onDeps(runner));
    expect(await researchNextRow(batch.id, onDeps(runner))).toBe('more');
    expect(calls).toHaveLength(1);
    const row = (await rowsOf(batch.id))[0]!;
    expect(row.claudeAt).not.toBeNull();
    expect(row).toMatchObject({ researchStatus: 'failed', researchNote: 'Claude Code failed', research: {} });
    expect((await monthTotals(prisma)).claudeRuns).toBe(1);
  });

  it('values are checked: a source must be a page read; country goes through the CRM country list', async () => {
    await claudeOn(10, false);
    const freight = site.url('freight.test');
    const batch = await batchWith([{ companyName: 'Fixture Freight', website: freight }]);
    const { runner } = fakeRunner({
      country: { value: 'IN', sourceUrl: freight },
      industry: { value: 'Freight and logistics', sourceUrl: `${freight}#about` },
      contactName: { value: 'Invented Person', sourceUrl: 'https://elsewhere.example/' },
    }, ['https://elsewhere.example/'], 'Medium');
    await startBatchResearch(batch.id, onDeps(runner));
    await researchNextRow(batch.id, onDeps(runner));
    const found = researchOf((await rowsOf(batch.id))[0]!);
    expect(found.country).toMatchObject({ value: 'India', confidence: 70 });
    expect(found.industry).toMatchObject({ value: 'Freight and logistics', confidence: 70 });
    // Web search is off: a search URL is no source.
    expect(found.contactName).toBeUndefined();
    expect(found.email).toMatchObject({ value: 'office@freight.test', confidence: 85 });
  });

  it('cap 2 with one run used: one row researched with Claude, then research stops; the rest stay waiting', async () => {
    await claudeOn(2);
    const used = await batchWith([{ companyName: 'Earlier', website: 'earlier.test' }]);
    await prisma.importRow.updateMany({ where: { batchId: used.id }, data: { claudeAt: new Date() } });
    const freight = site.url('freight.test');
    const batch = await batchWith([
      { companyName: 'Fixture Freight A', country: 'India', website: freight },
      { companyName: 'Fixture Freight B', country: 'India', website: freight },
      { companyName: 'Fixture Freight C', country: 'India', website: freight },
    ]);
    const { runner, calls } = fakeRunner({});
    await startBatchResearch(batch.id, onDeps(runner));
    expect(await researchNextRow(batch.id, onDeps(runner))).toBe('more');
    expect(await researchNextRow(batch.id, onDeps(runner))).toBe('stopped');
    expect(calls).toHaveLength(1);
    const b = await batchOf(batch.id);
    expect(b).toMatchObject({ status: 'Waiting for review', researchStopReason: 'cap', researchDone: 1 });
    expect(activityOf(b)[0]).toBe("Claude's monthly run cap is reached; research stopped");
    const rows = await rowsOf(batch.id);
    expect(rows[0]!.claudeAt).not.toBeNull();
    expect(rows.slice(1).map((r) => [r.researchStatus, r.status, r.claudeAt])).toEqual([
      ['waiting', 'Missing details', null], ['waiting', 'Missing details', null],
    ]);
    expect((await monthTotals(prisma)).claudeRuns).toBe(2);
  });

  it('researchRow: a refused reservation makes no call, keeps the website reader values and reports the cap', async () => {
    await claudeOn(1);
    const used = await batchWith([{ companyName: 'Earlier', website: 'earlier.test' }]);
    await prisma.importRow.updateMany({ where: { batchId: used.id }, data: { claudeAt: new Date() } });
    const batch = await batchWith([{ companyName: 'Fixture Freight', country: 'India', website: site.url('freight.test') }]);
    const { runner, calls } = fakeRunner({});
    const c: ImportClaude = { runner, model: 'sonnet', webSearch: false };
    const row = (await rowsOf(batch.id))[0] as ImportRow;
    const out = await researchRow(row, c, offDeps);
    expect(out).toMatchObject({ outcome: 'some', usedClaude: false, capReached: true });
    expect(Object.keys(out.values).sort()).toEqual(['city', 'email']);
    expect(calls).toHaveLength(0);
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })).claudeAt).toBeNull();
  });

  it('an Import started while a row is being researched: its values are not written', async () => {
    await claudeOn(10, true);
    const batch = await batchWith([{ companyName: 'Brightline Dental Clinics', country: 'Canada' }]);
    const { runner } = fakeRunner(
      { website: { value: 'https://brightline.example/', sourceUrl: 'https://brightline.example/' } },
      ['https://brightline.example/'], 'High',
      async () => { await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Importing' } }); },
    );
    await startBatchResearch(batch.id, onDeps(runner));
    expect(await researchNextRow(batch.id, onDeps(runner))).toBe('done');
    const row = (await rowsOf(batch.id))[0]!;
    expect(row.research).toEqual({});
    expect(row.researchedAt).toBeNull();
    expect(row.claudeAt).not.toBeNull(); // the spend still counts
    expect((await batchOf(batch.id))).toMatchObject({ status: 'Importing', researchDone: 0 });
  });
});

describe('import research · jobs, pause / resume, restart', () => {
  const runJob = () => runOnce({ types: ['import_research'], handlers: { import_research: importResearchHandler }, graph: fakeGraph() });

  it('the job researches one row and queues the next; pause stops the chain; resume queues exactly one job', async () => {
    Object.assign(importResearchDeps, offDeps);
    const freight = site.url('freight.test');
    const batch = await batchWith([
      { companyName: 'Fixture Freight A', country: 'India', website: freight },
      { companyName: 'Fixture Freight B', country: 'India', website: freight },
      { companyName: 'Fixture Freight C', country: 'India', website: freight },
    ]);
    await startBatchResearch(batch.id, offDeps);
    expect(await runJob()).toBe(true);
    expect((await rowsOf(batch.id)).map((r) => r.researchStatus)).toEqual(['some', 'waiting', 'waiting']);
    expect(await queuedJobs()).toHaveLength(1);

    await pauseResearch(batch.id);
    expect((await batchOf(batch.id)).researchPaused).toBe(true);
    expect(await researchNextRow(batch.id, offDeps)).toBe('paused');
    expect(await runJob()).toBe(true); // the queued job finds the batch paused
    expect(await queuedJobs()).toHaveLength(0);
    expect((await rowsOf(batch.id)).map((r) => r.researchStatus)).toEqual(['some', 'waiting', 'waiting']);

    await resumeResearch(batch.id);
    expect(await queuedJobs()).toHaveLength(1);
    await resumeResearch(batch.id);
    expect(await queuedJobs()).toHaveLength(1);
    expect((await batchOf(batch.id)).researchPaused).toBe(false);

    while (await runJob()) { /* until the chain ends */ }
    expect((await rowsOf(batch.id)).map((r) => r.researchStatus)).toEqual(['some', 'some', 'some']);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Waiting for review', researchDone: 3 });
    expect(await prisma.job.count({ where: { type: 'import_research', status: 'failed' } })).toBe(0);
  });

  it('resume after the cap stop: research continues from the rows still waiting', async () => {
    await claudeOn(1);
    const batch = await batchWith([{ companyName: 'Fixture Freight', country: 'India', website: site.url('freight.test') }]);
    const used = await batchWith([{ companyName: 'Earlier', website: 'earlier.test' }]);
    await prisma.importRow.updateMany({ where: { batchId: used.id }, data: { claudeAt: new Date() } });
    const { runner } = fakeRunner({});
    await startBatchResearch(batch.id, onDeps(runner));
    expect(await researchNextRow(batch.id, onDeps(runner))).toBe('stopped');
    await prisma.enrichmentSettings.update({ where: { id: 1 }, data: { claudeMonthlyRunCap: 5 } });
    await resumeResearch(batch.id);
    expect(await batchOf(batch.id)).toMatchObject({ status: 'Researching', researchStopReason: null });
    expect(await queuedJobs()).toHaveLength(1);
  });

  it('sweep at startup: a running row is waiting again and its batch gets a job', async () => {
    const batch = await batchWith([{ companyName: 'Fixture Freight', website: site.url('freight.test') }], 'Researching');
    await prisma.importRow.updateMany({ where: { batchId: batch.id }, data: { researchStatus: 'running' } });
    // A job left running by the worker that stopped.
    await prisma.job.create({ data: { type: 'import_research', payload: { batchId: batch.id }, status: 'running', runAt: new Date(), lockedAt: new Date() } });
    expect(await sweepImportResearch({ startup: true })).toBe(1);
    expect((await rowsOf(batch.id))[0]!.researchStatus).toBe('waiting');
    const jobs = await queuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ batchId: batch.id });
  });

  it('sweep on the schedule: a row whose job is still running is left alone; a lost one is released', async () => {
    const live = await batchWith([{ companyName: 'Live', website: 'live.test' }], 'Researching');
    const lost = await batchWith([{ companyName: 'Lost', website: 'lost.test' }], 'Researching');
    const paused = await batchWith([{ companyName: 'Paused', website: 'paused.test' }], 'Researching');
    await prisma.importBatch.update({ where: { id: paused.id }, data: { researchPaused: true } });
    await prisma.importRow.updateMany({ where: { batchId: { in: [live.id, lost.id] } }, data: { researchStatus: 'running' } });
    await prisma.importRow.updateMany({ where: { batchId: paused.id }, data: { researchStatus: 'waiting' } });
    await prisma.job.create({ data: { type: 'import_research', payload: { batchId: live.id }, status: 'running', runAt: new Date(), lockedAt: new Date() } });
    await prisma.job.create({
      data: { type: 'import_research', payload: { batchId: lost.id }, status: 'running', runAt: new Date(), lockedAt: new Date(Date.now() - STALE_AFTER_MS - 60_000) },
    });
    expect(await sweepImportResearch()).toBe(1);
    expect((await rowsOf(live.id))[0]!.researchStatus).toBe('running');
    expect((await rowsOf(lost.id))[0]!.researchStatus).toBe('waiting');
    const jobs = await queuedJobs();
    expect(jobs.map((j) => j.payload)).toEqual([{ batchId: lost.id }]);
  });
});

describe('import research · HTTP', () => {
  async function as(role: 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER') {
    const user = await makeUser({ role });
    return { user, cookie: await signIn(app, user) };
  }
  const call = (method: 'GET' | 'POST', url: string, cookie: string) => app.inject({ method, url, headers: { cookie } });

  it('start, progress view, pause and resume; other roles are refused', async () => {
    const manager = await as('MANAGER');
    const freight = site.url('freight.test');
    const batch = await batchWith([
      { companyName: 'Fixture Freight', country: 'India', website: freight },
      { companyName: 'No Site Traders', country: 'India' },
      { companyName: 'Ready Co', country: 'India', email: 'a@ready.test', $status: 'Ready' },
    ]);
    const started = await call('POST', `/api/imports/batches/${batch.id}/research`, manager.cookie);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ total: 2 });
    await researchNextRow(batch.id, offDeps);

    const view = await call('GET', `/api/imports/batches/${batch.id}/research?page=1`, manager.cookie);
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body).toMatchObject({
      status: 'Researching', paused: false, stopReason: null, total: 2, done: 1,
      tiles: { everything: 0, some: 1, nothing: 0 }, claude: { on: false, runsThisMonth: 0, cap: 0 }, engine: 'Website reader',
    });
    expect(typeof body.etaMinutes).toBe('number');
    expect(body.items.map((r: { fields: RowFields }) => r.fields.companyName)).toEqual(['Fixture Freight', 'No Site Traders']);
    expect(body.items[0].research.city.value).toBe('Pune');
    expect(body.activity[0].text).toBe('Fixture Freight — 1 page read, 2 fields filled');

    expect((await call('POST', `/api/imports/batches/${batch.id}/research/pause`, manager.cookie)).statusCode).toBe(200);
    expect((await batchOf(batch.id)).researchPaused).toBe(true);
    expect((await call('POST', `/api/imports/batches/${batch.id}/research/resume`, manager.cookie)).statusCode).toBe(200);
    expect((await batchOf(batch.id)).researchPaused).toBe(false);

    const rep = await as('SALES_REPRESENTATIVE');
    expect((await call('POST', `/api/imports/batches/${batch.id}/research`, rep.cookie)).statusCode).toBe(403);
    expect((await call('GET', `/api/imports/batches/${batch.id}/research`, rep.cookie)).statusCode).toBe(403);

    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: 'Importing' } });
    const locked = await call('POST', `/api/imports/batches/${batch.id}/research`, manager.cookie);
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toEqual({ error: 'batch_locked' });
    expect((await call('GET', '/api/imports/batches/999999/research', manager.cookie)).statusCode).toBe(404);
  });
});
