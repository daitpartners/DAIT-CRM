import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { runResearch, type ResearchDeps } from '../src/research/service';
import { researchCompanyHandler } from '../src/jobs/handlers/researchCompany';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { RIGHTS, type Action } from '@dait-crm/shared';
import { makeCompany, makeLead, makeUser, signIn } from './factory';
import { FIXTURE_HOSTS, fixtureResolver, startFixtureServer, type FixtureServer } from './fixtureSites';

let app: FastifyInstance;
let site: FixtureServer;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
  site = await startFixtureServer();
});
afterAll(async () => {
  await app.close();
  await site.close();
});
beforeEach(async () => {
  await resetDb();
  vi.stubEnv('RESEARCH_TEST_ALLOW_HOSTS', FIXTURE_HOSTS.join(','));
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('GOOGLE_PLACES_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';
const req = (method: Method, url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

async function as(role: 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER') {
  const user = await makeUser({ role });
  return { user, cookie: await signIn(app, user) };
}

const readerDeps = (extra: Partial<ResearchDeps> = {}): ResearchDeps => ({ reader: { resolve: fixtureResolver() }, env: {}, ...extra });

/** A company on the fixture site (JSON-LD org page + About + Contact). */
const siteCompany = (over: Parameters<typeof makeCompany>[0] = {}) =>
  makeCompany({ name: 'Acme Widgets', website: site.url('site.test'), country: 'United Kingdom', ...over });

async function startAndRun(companyId: number, cookie: string, deps: ResearchDeps = readerDeps()) {
  const res = await req('POST', `/api/companies/${companyId}/research`, cookie);
  expect(res.statusCode).toBe(202);
  const { runId } = res.json() as { runId: number };
  await runResearch(runId, deps);
  return runId;
}

const pendingOf = (companyId: number) =>
  prisma.enrichmentSuggestion.findMany({ where: { companyId, decision: 'pending' }, orderBy: { id: 'asc' } });

describe('research runs · website reader', () => {
  it('suggests only empty, unverified fields; one source record per page with a snapshot', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany({ legalName: 'Acme Ltd (typed by hand)' });
    // description empty but verified: never suggested.
    await prisma.company.update({ where: { id: c.id }, data: { verifiedFields: { description: true } } });
    const runId = await startAndRun(c.id, admin.cookie);

    const run = await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: 'Completed', engine: 'Website reader', trigger: `Manual · ${admin.user.name}` });
    expect(run.sources).toEqual(['website']);
    const fields = (await pendingOf(c.id)).map((s) => s.field).sort();
    expect(fields).not.toContain('legalName');
    expect(fields).not.toContain('description');
    expect(fields).toEqual(expect.arrayContaining(['street', 'city', 'zip', 'yearEstablished', 'businessEmail', 'linkedinUrl', 'websiteTechnology']));
    expect(run.result).toBe(`${fields.length} suggestions`);
    const s = (await pendingOf(c.id)).find((x) => x.field === 'city')!;
    expect(s).toMatchObject({ value: 'Sheffield', confidence: 90, label: 'City', sourceUrl: site.url('site.test') });

    const sources = await prisma.sourceRecord.findMany({ where: { companyId: c.id }, orderBy: { id: 'asc' } });
    expect(sources.map((x) => x.url)).toEqual([site.url('site.test'), site.url('site.test', '/about-us'), site.url('site.test', '/contact')]);
    expect(sources[0]).toMatchObject({ sourceType: 'Company website', collectedBy: 'Enrichment worker' });
    expect(sources[0]!.snapshot).toContain('We build widgets & parts for packaging lines across Europe.');

    const company = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(company.aiResearchStatus).toBe('Completed');
    expect(company.aiLastResearchAt).not.toBeNull();
  });

  it('GET research shows pending suggestions with current value and lock, runs and canEdit', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const res = await req('GET', `/api/companies/${c.id}/research`, admin.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canEdit).toBe(true);
    expect(body.company).toMatchObject({ aiResearchStatus: 'Completed', verificationStatus: 'Unverified', verifiedFields: {} });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ status: 'Completed', engine: 'Website reader', appliedCount: 0 });
    const city = body.pending.find((s: { field: string }) => s.field === 'city');
    expect(city).toMatchObject({ value: 'Sheffield', currentValue: null, locked: false });
    expect(JSON.stringify(body)).not.toContain('costUsd');
  });

  it('a company without a website completes with "No website on file"', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ website: null });
    const runId = await startAndRun(c.id, admin.cookie);
    const run = await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: 'Completed', result: 'No website on file' });
    expect(await prisma.enrichmentSuggestion.count()).toBe(0);
  });

  it('a site that cannot be read fails the run with the reason', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ website: site.url('blocked.test') });
    const runId = await startAndRun(c.id, admin.cookie);
    const run = await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: 'Failed', result: 'Blocked by robots.txt' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).aiResearchStatus).toBe('Failed');
  });

  it('a failed run notifies too, with the reason', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ name: 'Blocked Co', website: site.url('blocked.test') });
    await startAndRun(c.id, admin.cookie);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: admin.user.id } });
    expect(n).toMatchObject({ text: 'AI research failed · Blocked Co', detail: 'Blocked by robots.txt', link: `/companies/${c.id}#ai` });
  });

  it('a run released while working (marked Interrupted) writes nothing when it finishes', async () => {
    const admin = await as('ADMINISTRATOR');
    await prisma.enrichmentSettings.create({ data: { id: 1, claudeEnabled: true, claudeMonthlyCapUsd: 5 } });
    const c = await siteCompany();
    const res = await req('POST', `/api/companies/${c.id}/research`, admin.cookie);
    const runId = res.json().runId as number;
    // While Claude works, the run outlives the stale limit and a new start marks it Interrupted.
    const claude = {
      create: async () => {
        await prisma.enrichmentRun.update({ where: { id: runId }, data: { status: 'Failed', result: 'Interrupted' } });
        return {
          id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', citations: null, text: JSON.stringify({
            summary: { value: 'Late summary.', sourceUrl: site.url('site.test') }, industry: null, businessCategory: null,
            opportunityScore: null, confidence: 'Low', potentialServices: null, websiteAssessment: null, specialisation: null, employeeRange: null,
          }) }],
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    };
    await runResearch(runId, readerDeps({ claude, env: { ANTHROPIC_API_KEY: 'sk-test' } }));
    expect(await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'Failed', result: 'Interrupted' });
    const company = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(company.aiSummary).toBeNull();
    expect(await prisma.enrichmentSuggestion.count()).toBe(0);
    expect(await prisma.sourceRecord.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('a released run that then fails does not overwrite the newer state either', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany(); // the injected resolver below fails the read
    const res = await req('POST', `/api/companies/${c.id}/research`, admin.cookie);
    const runId = res.json().runId as number;
    const resolve = async (host: string) => {
      await prisma.enrichmentRun.update({ where: { id: runId }, data: { status: 'Failed', result: 'Interrupted' } });
      await prisma.company.update({ where: { id: c.id }, data: { aiResearchStatus: 'Pending' } });
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    };
    await runResearch(runId, readerDeps({ reader: { resolve } }));
    expect(await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: 'Failed', result: 'Interrupted' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).aiResearchStatus).toBe('Pending');
    expect(await prisma.notification.count()).toBe(0);
  });

  it('a re-run supersedes the older pending suggestion for the same field', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const first = (await pendingOf(c.id)).find((s) => s.field === 'city')!;
    await startAndRun(c.id, admin.cookie);
    expect((await prisma.enrichmentSuggestion.findUniqueOrThrow({ where: { id: first.id } })).decision).toBe('superseded');
    expect((await pendingOf(c.id)).filter((s) => s.field === 'city')).toHaveLength(1);
  });

  it('the job handler runs the queued run', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ website: null });
    const res = await req('POST', `/api/companies/${c.id}/research`, admin.cookie);
    const job = await prisma.job.findFirstOrThrow({ where: { type: 'research_company' } });
    expect(job.payload).toEqual({ runId: res.json().runId });
    expect(job.maxAttempts).toBe(1);
    await researchCompanyHandler(job, { graph: fakeGraph() });
    expect((await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: res.json().runId } })).status).toBe('Completed');
  });

  it('the run notifies the lead owner, else the person who started it', async () => {
    const admin = await as('ADMINISTRATOR');
    const owner = await makeUser();
    const c = await siteCompany();
    await makeLead({ companyId: c.id, assignedToId: owner.id });
    await startAndRun(c.id, admin.cookie);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: owner.id } });
    expect(n.text).toBe('AI research completed · Acme Widgets');
    expect(n.detail).toMatch(/^\d+ suggestions to review$/);
    expect(n.link).toBe(`/companies/${c.id}#ai`);

    const other = await makeCompany({ website: null, name: 'Lonely Co' });
    await startAndRun(other.id, admin.cookie);
    expect(await prisma.notification.findFirst({ where: { userId: admin.user.id, text: 'AI research completed · Lonely Co' } })).not.toBeNull();
  });
});

describe('suggestion decisions', () => {
  it('accept writes the value, marks it verified, records ai_fields and counts as applied', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    const runId = await startAndRun(c.id, admin.cookie);
    const city = (await pendingOf(c.id)).find((s) => s.field === 'city')!;
    const res = await req('POST', `/api/research/suggestions/${city.id}/accept`, admin.cookie);
    expect(res.statusCode).toBe(200);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(company.city).toBe('Sheffield');
    expect(company.verifiedFields).toMatchObject({ city: true });
    expect((company.aiFields as Record<string, unknown>).city).toMatchObject({ confidence: 90, source: site.url('site.test'), runId });
    expect(company.verificationStatus).toBe('Partially Verified');
    expect((await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } })).appliedCount).toBe(1);
    expect(await prisma.enrichmentSuggestion.findUniqueOrThrow({ where: { id: city.id } })).toMatchObject({ decision: 'accepted', decidedById: admin.user.id });
    // Decided once only.
    expect((await req('POST', `/api/research/suggestions/${city.id}/accept`, admin.cookie)).statusCode).toBe(409);
  });

  it('concurrent accepts on different fields both keep their verified and ai_fields entries', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const pending = (await pendingOf(c.id)).slice(0, 4);
    const results = await Promise.all(pending.map((s) => req('POST', `/api/research/suggestions/${s.id}/accept`, admin.cookie)));
    expect(results.map((r) => r.statusCode)).toEqual(pending.map(() => 200));
    const company = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    for (const s of pending) {
      expect((company.verifiedFields as Record<string, boolean>)[s.field], s.field).toBe(true);
      expect((company.aiFields as Record<string, unknown>)[s.field], s.field).toBeDefined();
    }
  });

  it('accepting a year and coordinates stores them in their column types', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const year = (await pendingOf(c.id)).find((s) => s.field === 'yearEstablished')!;
    expect((await req('POST', `/api/research/suggestions/${year.id}/accept`, admin.cookie)).statusCode).toBe(200);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).yearEstablished).toBe(1987);
  });

  it('reject records the decision and writes nothing', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const city = (await pendingOf(c.id)).find((s) => s.field === 'city')!;
    expect((await req('POST', `/api/research/suggestions/${city.id}/reject`, admin.cookie)).statusCode).toBe(200);
    expect((await prisma.enrichmentSuggestion.findUniqueOrThrow({ where: { id: city.id } })).decision).toBe('rejected');
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).city).toBeNull();
  });

  it('accept on a field that became filled (and verified) by hand is 409 locked', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const city = (await pendingOf(c.id)).find((s) => s.field === 'city')!;
    const fresh = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    const patch = await req('PATCH', `/api/companies/${c.id}`, admin.cookie, { city: 'Leeds', updatedAt: fresh.updatedAt.toISOString() });
    expect(patch.statusCode).toBe(200);
    const research = (await req('GET', `/api/companies/${c.id}/research`, admin.cookie)).json();
    expect(research.pending.find((s: { field: string }) => s.field === 'city')).toMatchObject({ currentValue: 'Leeds', locked: true });
    const res = await req('POST', `/api/research/suggestions/${city.id}/accept`, admin.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'locked' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).city).toBe('Leeds');
  });

  it('"Accept all ≥ 80%" accepts only suggestions with confidence 80 or more', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const all = await pendingOf(c.id);
    const high = all.filter((s) => s.confidence >= 80);
    expect(all.some((s) => s.confidence < 80)).toBe(true); // website technology, 70
    const res = await req('POST', `/api/companies/${c.id}/research/accept-high`, admin.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: high.length });
    const left = await pendingOf(c.id);
    expect(left.map((s) => s.field)).toEqual(all.filter((s) => s.confidence < 80).map((s) => s.field));
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).websiteTechnology).toBeNull();
  });

  it('mark profile verified: every filled field verified, status Verified', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ legalName: 'Acme Ltd', city: 'Pune' });
    const res = await req('POST', `/api/companies/${c.id}/verify-profile`, admin.cookie);
    expect(res.statusCode).toBe(200);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(company.verificationStatus).toBe('Verified');
    expect(company.verifiedFields).toMatchObject({ name: true, legalName: true, city: true, country: true });
    expect((company.verifiedFields as Record<string, boolean>).street).toBeUndefined();
  });

  it('a hand edit removes the field from ai_fields (the value is now the user\'s)', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ city: 'Sheffield' });
    const before = await prisma.company.update({
      where: { id: c.id }, data: { aiFields: { city: { confidence: 90 }, zip: { confidence: 90 } } },
    });
    const res = await req('PATCH', `/api/companies/${c.id}`, admin.cookie, { city: 'Leeds', updatedAt: before.updatedAt.toISOString() });
    expect(res.statusCode).toBe(200);
    const after = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.aiFields).toEqual({ zip: { confidence: 90 } });
    expect(after.verifiedFields).toMatchObject({ city: true });
  });
});

describe('starting runs', () => {
  it('a second start while one is pending is 409 research_running', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    expect((await req('POST', `/api/companies/${c.id}/research`, admin.cookie)).statusCode).toBe(202);
    const again = await req('POST', `/api/companies/${c.id}/research`, admin.cookie);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'research_running' });
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).aiResearchStatus).toBe('Pending');
    expect(await prisma.enrichmentRun.count()).toBe(1);
  });

  it('a run left Processing past the stale limit no longer blocks a new one', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    const old = await prisma.enrichmentRun.create({
      data: { companyId: c.id, trigger: 'x', engine: 'Website reader', status: 'Processing', startedAt: new Date(Date.now() - 3600_000) },
    });
    expect((await req('POST', `/api/companies/${c.id}/research`, admin.cookie)).statusCode).toBe(202);
    expect(await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: 'Failed', result: 'Interrupted' });
  });

  it('the daily limit refuses manual runs (429) and skips automatic ones', async () => {
    await seedLookups();
    const admin = await as('ADMINISTRATOR');
    await prisma.enrichmentSettings.create({ data: { id: 1, dailyRunLimit: 1 } });
    const a = await makeCompany({ website: null });
    const b = await makeCompany({ website: null });
    expect((await req('POST', `/api/companies/${a.id}/research`, admin.cookie)).statusCode).toBe(202);
    const refused = await req('POST', `/api/companies/${b.id}/research`, admin.cookie);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'daily_limit' });
    const lead = await req('POST', '/api/leads', admin.cookie, {
      companyName: 'Auto Co', website: site.url('meta.test'), country: 'India', leadSource: 'Manual Entry', assignedToId: admin.user.id,
    });
    expect(lead.statusCode).toBe(201);
    expect(await prisma.enrichmentRun.count()).toBe(1);
  });

  it('users who may not edit companies cannot run; users who cannot see the company get 404', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const hidden = await makeCompany({ website: null });
    for (const [m, u] of [
      ['GET', `/api/companies/${hidden.id}/research`], ['POST', `/api/companies/${hidden.id}/research`],
      ['GET', `/api/companies/${hidden.id}/sources`], ['POST', `/api/companies/${hidden.id}/verify-profile`],
      ['POST', `/api/companies/${hidden.id}/research/accept-high`],
    ] as const) {
      expect((await req(m, u, rep.cookie)).statusCode, `${m} ${u}`).toBe(404);
    }
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    await startAndRun(c.id, admin.cookie);
    const s = (await pendingOf(c.id))[0]!;
    expect((await req('POST', `/api/research/suggestions/${s.id}/accept`, rep.cookie)).statusCode).toBe(404);
    expect((await req('GET', `/api/companies/${c.id}/research`)).statusCode).toBe(401);
  });
});

describe('company edit rights', () => {
  it('a role without manage_companies sees research (canEdit false) but cannot run, decide, verify or add sources', async () => {
    // No current role lacks manage_companies; take it away from Sales Representatives for this test.
    const rights = RIGHTS['Sales Representative'] as Set<Action>;
    rights.delete('manage_companies');
    try {
      const admin = await as('ADMINISTRATOR');
      const rep = await as('SALES_REPRESENTATIVE');
      const c = await siteCompany({ createdById: rep.user.id });
      await startAndRun(c.id, admin.cookie);
      const s = (await pendingOf(c.id))[0]!;
      const get = await req('GET', `/api/companies/${c.id}/research`, rep.cookie);
      expect(get.statusCode).toBe(200);
      expect(get.json().canEdit).toBe(false);
      expect((await req('GET', `/api/companies/${c.id}/sources`, rep.cookie)).statusCode).toBe(200);
      for (const [u, body] of [
        [`/api/companies/${c.id}/research`, undefined], [`/api/research/suggestions/${s.id}/accept`, undefined],
        [`/api/research/suggestions/${s.id}/reject`, undefined], [`/api/companies/${c.id}/research/accept-high`, undefined],
        [`/api/companies/${c.id}/verify-profile`, undefined],
        [`/api/companies/${c.id}/sources`, { title: 'X', sourceType: 'Other' }],
      ] as const) {
        expect((await req('POST', u, rep.cookie, body)).statusCode, u).toBe(403);
      }
      expect((await prisma.enrichmentSuggestion.findUniqueOrThrow({ where: { id: s.id } })).decision).toBe('pending');
    } finally {
      rights.add('manage_companies');
    }
  });
});

describe('automatic runs', () => {
  it('a single new lead for a never-researched company with a website queues one, with an activity; CSV import queues none', async () => {
    await seedLookups();
    const admin = await as('ADMINISTRATOR');
    const res = await req('POST', '/api/leads', admin.cookie, {
      companyName: 'Meta Only', website: site.url('meta.test'), country: 'India', leadSource: 'Manual Entry', assignedToId: admin.user.id,
    });
    expect(res.statusCode).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.json().id } });
    const run = await prisma.enrichmentRun.findFirstOrThrow();
    expect(run).toMatchObject({ companyId: lead.companyId, leadId: lead.id, trigger: `New lead ${lead.number}`, status: 'Pending' });
    expect(await prisma.job.count({ where: { type: 'research_company' } })).toBe(1);
    const activity = await prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id, activityType: 'ai' } });
    expect(activity.title).toBe('AI enrichment queued for Meta Only');
    expect(activity.byUserId).toBeNull();

    // A second lead on the same (now Pending) company queues nothing more.
    await req('POST', '/api/leads', admin.cookie, {
      companyName: 'Meta Only', website: site.url('meta.test'), country: 'India', leadSource: 'Manual Entry', linkCompanyId: lead.companyId,
    });
    expect(await prisma.enrichmentRun.count()).toBe(1);

    // No website: nothing.
    await req('POST', '/api/leads', admin.cookie, { companyName: 'No Site Co', country: 'India', leadSource: 'Manual Entry' });
    expect(await prisma.enrichmentRun.count()).toBe(1);

    // CSV import: nothing.
    const csv = `Company,Website,Country\nCsv Co,https://csv-co.example,India\n`;
    const mapping = {
      columns: {
        companyName: 'Company', website: 'Website', businessEmail: null, phone: null, country: 'Country', city: null,
        contactFirstName: null, contactLastName: null, contactEmail: null, leadSource: null, priority: null, notes: null, sourceUrl: null,
      },
    };
    const imp = await req('POST', '/api/imports/leads', admin.cookie, { csv, mapping, assignedToId: admin.user.id });
    expect(imp.statusCode).toBe(200);
    expect(imp.json().created).toBe(1);
    expect(await prisma.enrichmentRun.count()).toBe(1);
  });
});

describe('paid providers', () => {
  const answer = (url: string) => JSON.stringify({
    summary: { value: 'Acme makes industrial widgets.', sourceUrl: url },
    industry: { value: 'Manufacturing', sourceUrl: url },
    businessCategory: { value: 'Widget manufacturer', sourceUrl: url },
    opportunityScore: { value: 64, sourceUrl: url },
    confidence: 'Medium',
    potentialServices: { value: ['Website Creation'], sourceUrl: url },
    websiteAssessment: { value: 'A tidy WordPress site.', sourceUrl: url },
    specialisation: null,
    employeeRange: null,
  });
  const fakeClaude = (url: string) => {
    const calls: unknown[] = [];
    return {
      calls,
      client: {
        create: async (params: unknown) => {
          calls.push(params);
          return {
            id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
            content: [{ type: 'text', text: answer(url), citations: null }],
            usage: { input_tokens: 20_000, output_tokens: 2_000 },
          } as unknown as Anthropic.Message;
        },
      },
    };
  };
  const claudeOn = async (cap: number) => prisma.enrichmentSettings.create({ data: { id: 1, claudeEnabled: true, claudeMonthlyCapUsd: cap } });

  it('no key, cap 0, or cap reached: no Claude call and engine "Website reader"', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await siteCompany();
    const fake = fakeClaude(site.url('site.test'));
    // Cap set, but no key.
    await claudeOn(5);
    let runId = await startAndRun(c.id, admin.cookie, readerDeps({ claude: fake.client }));
    expect((await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } })).engine).toBe('Website reader');
    // Key, cap 0.
    await prisma.enrichmentSettings.update({ where: { id: 1 }, data: { claudeMonthlyCapUsd: 0 } });
    runId = await startAndRun(c.id, admin.cookie, readerDeps({ claude: fake.client, env: { ANTHROPIC_API_KEY: 'sk-test' } }));
    expect((await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } })).engine).toBe('Website reader');
    // Key, cap 1, this month's spend already 1.
    await prisma.enrichmentSettings.update({ where: { id: 1 }, data: { claudeMonthlyCapUsd: 1 } });
    await prisma.enrichmentRun.update({ where: { id: runId }, data: { costUsd: 1 } });
    runId = await startAndRun(c.id, admin.cookie, readerDeps({ claude: fake.client, env: { ANTHROPIC_API_KEY: 'sk-test' } }));
    expect((await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } })).engine).toBe('Website reader');
    // Key and cap, but the Claude engine switched off.
    await prisma.enrichmentSettings.update({ where: { id: 1 }, data: { claudeMonthlyCapUsd: 50, claudeEnabled: false } });
    runId = await startAndRun(c.id, admin.cookie, readerDeps({ claude: fake.client, env: { ANTHROPIC_API_KEY: 'sk-test' } }));
    expect((await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } })).engine).toBe('Website reader');
    expect(fake.calls).toHaveLength(0);
  });

  it('with a key and a cap: Claude writes ai_* columns, proposes services, and the cost is recorded', async () => {
    const admin = await as('ADMINISTRATOR');
    await seedLookups();
    const c = await siteCompany();
    await claudeOn(5);
    const fake = fakeClaude(site.url('site.test'));
    const runId = await startAndRun(c.id, admin.cookie, readerDeps({
      claude: fake.client, env: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_MODEL: 'claude-sonnet-5-5' },
    }));
    expect(fake.calls).toHaveLength(1);
    const run = await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.engine).toBe('Website reader + Claude claude-sonnet-5-5');
    expect(run.sources).toEqual(['website', 'claude']);
    expect(run.costUsd.toNumber()).toBeCloseTo((20_000 * 2 + 2_000 * 10) / 1_000_000, 4);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: c.id } });
    expect(company).toMatchObject({
      aiSummary: 'Acme makes industrial widgets.', aiIndustry: 'Manufacturing', aiBusinessCategory: 'Widget manufacturer',
      aiOpportunityScore: 64, aiConfidence: 'Medium', industry: null, businessCategory: null,
    });
    const services = (await pendingOf(c.id)).find((s) => s.field === 'aiPotentialServices')!;
    expect(services).toMatchObject({ value: ['Website Creation'], display: 'Website Creation', confidence: 70 });
    expect((await req('POST', `/api/research/suggestions/${services.id}/accept`, admin.cookie)).statusCode).toBe(200);
    expect((await prisma.company.findUniqueOrThrow({ where: { id: c.id } })).aiPotentialServices).toEqual(['Website Creation']);
  });

  it('Google Places with a key, on and under the cap: suggestions and the call counted; refused at the cap', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany({ name: 'Meta Co', website: site.url('meta.test') });
    await prisma.enrichmentSettings.create({ data: { id: 1, placesEnabled: true, placesMonthlyCallCap: 1 } });
    const urls: string[] = [];
    const placesFetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      const body = String(url).endsWith(':searchText')
        ? { places: [{ id: 'place1' }] }
        : { addressComponents: [{ longText: 'Pune', types: ['locality'] }], location: { latitude: 18.52, longitude: 73.85 }, googleMapsUri: 'https://maps.google.com/?cid=9' };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const deps = readerDeps({ placesFetch, env: { GOOGLE_PLACES_API_KEY: 'places-key-123456' } });
    let runId = await startAndRun(c.id, admin.cookie, deps);
    let run = await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.placesCalls).toBe(1);
    expect(run.sources).toEqual(['website', 'places']);
    const fields = (await pendingOf(c.id)).map((s) => s.field);
    expect(fields).toEqual(expect.arrayContaining(['city', 'lat', 'lng', 'mapsUrl']));
    expect(await prisma.sourceRecord.count({ where: { companyId: c.id, sourceType: 'Google Places API' } })).toBe(1);

    urls.length = 0;
    runId = await startAndRun(c.id, admin.cookie, deps);
    run = await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(urls).toEqual([]);
    expect(run.placesCalls).toBe(0);
    expect(run.sources).toEqual(['website']);
  });
});

describe('sources', () => {
  it('lists source records and adds a manual one', async () => {
    const admin = await as('ADMINISTRATOR');
    const c = await makeCompany();
    const add = await req('POST', `/api/companies/${c.id}/sources`, admin.cookie, {
      title: 'Companies House entry', url: 'https://find-and-update.company-information.service.gov.uk/company/1',
      sourceType: 'Public registry', fieldsPopulated: 'Legal name', notes: 'Registered 1987.',
    });
    expect(add.statusCode).toBe(201);
    const list = await req('GET', `/api/companies/${c.id}/sources`, admin.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({
      title: 'Companies House entry', sourceType: 'Public registry', collectedBy: `${admin.user.name} (manual)`,
      fieldsPopulated: 'Legal name', snapshot: 'Registered 1987.',
    });
    expect((await req('POST', `/api/companies/${c.id}/sources`, admin.cookie, { title: '' })).statusCode).toBe(400);
  });
});

describe('enrichment settings', () => {
  it('Administrators only; reports key presence and month totals, never a key', async () => {
    const rep = await as('MANAGER');
    expect((await req('GET', '/api/settings/enrichment', rep.cookie)).statusCode).toBe(403);
    const admin = await as('ADMINISTRATOR');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-very-secret-0001');
    const c = await makeCompany();
    await prisma.enrichmentRun.create({ data: { companyId: c.id, trigger: 't', engine: 'e', costUsd: 0.25, placesCalls: 3 } });
    const get = await req('GET', '/api/settings/enrichment', admin.cookie);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      dailyRunLimit: 50, claudeEnabled: false, claudeMonthlyCapUsd: 0, placesEnabled: false, placesMonthlyCallCap: 0,
      webSearchEnabled: false, claudeKeyPresent: true, placesKeyPresent: false, claudeSpentThisMonthUsd: 0.25, placesCallsThisMonth: 3,
    });
    expect(get.body).not.toContain('sk-ant-very-secret-0001');

    const put = await req('PUT', '/api/settings/enrichment', admin.cookie, {
      dailyRunLimit: 20, claudeEnabled: true, claudeMonthlyCapUsd: 12.345, placesEnabled: false, placesMonthlyCallCap: 0,
      webSearchEnabled: true, anthropicApiKey: 'nope',
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ dailyRunLimit: 20, claudeEnabled: true, claudeMonthlyCapUsd: 12.35, webSearchEnabled: true });
    expect(put.body).not.toContain('sk-ant-very-secret-0001');
    expect((await req('PUT', '/api/settings/enrichment', rep.cookie, {})).statusCode).toBe(403);
  });
});
