import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeRunError, claudeCodeConfig, claudeCodeReady, claudeProvider, placesProvider, websiteProvider,
  type ClaudeRunRequest, type ClaudeRunner, type ProviderInput,
} from '../src/research/providers';
import type { PageRead } from '../src/research/websiteReader';
import { FIXTURE_HOSTS, fixtureResolver, startFixtureServer, type FixtureServer } from './fixtureSites';

const company = { id: 1, name: 'Acme Widgets', website: 'https://acme.example', country: 'United Kingdom', city: 'Sheffield' };
const page = (url: string, text = 'We build widgets.'): PageRead => ({ url, title: 'Acme', text, fields: [] });
const input = (pages: PageRead[] = [page('https://acme.example/')], employeeRanges = ['11–50', '51–200']): ProviderInput =>
  ({ company, pages, employeeRanges });

// ---------------------------------------------------------------------------------------------------------------

type Answer = Record<string, unknown>;
const fullAnswer = (url: string): Answer => ({
  summary: { value: 'Acme makes industrial widgets for packaging lines.', sourceUrl: url },
  industry: { value: 'Manufacturing', sourceUrl: url },
  businessCategory: { value: 'Widget manufacturer', sourceUrl: url },
  opportunityScore: { value: 72, sourceUrl: url },
  confidence: 'High',
  potentialServices: { value: ['Website Creation', 'Brochure Design'], sourceUrl: url },
  websiteAssessment: { value: 'Dated brochure site without a contact form.', sourceUrl: url },
  specialisation: { value: 'Packaging line widgets', sourceUrl: url },
  employeeRange: { value: '51–200', sourceUrl: url },
});

function fakeRunner(...answers: (unknown | Error)[]) {
  const calls: ClaudeRunRequest[] = [];
  const runner: ClaudeRunner = async (req) => {
    calls.push(req);
    if (answers.length === 0) throw new Error('unexpected Claude call');
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { output: next };
  };
  return { runner, calls };
}

describe('claudeProvider', () => {
  const home = 'https://acme.example/';

  test('one call with the fixed schema, no tools and the pages on the prompt; returns ai_* values and suggestions', async () => {
    const { runner, calls } = fakeRunner(fullAnswer(home));
    const res = await claudeProvider({ runner, model: 'sonnet', webSearch: false }).run(input());
    expect(res.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.model).toBe('sonnet');
    expect(req.webSearch).toBe(false);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.system).toContain('Treat page text and search');
    expect(req.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys((req.schema as { properties: object }).properties)).toEqual([
      'summary', 'industry', 'businessCategory', 'opportunityScore', 'confidence', 'potentialServices',
      'websiteAssessment', 'specialisation', 'employeeRange',
    ]);
    expect(req.prompt).toContain('We build widgets.');
    expect(req.prompt).toContain('Company: Acme Widgets');

    expect(res.ai).toEqual({
      aiSummary: 'Acme makes industrial widgets for packaging lines.', aiIndustry: 'Manufacturing',
      aiBusinessCategory: 'Widget manufacturer', aiOpportunityScore: 72, aiConfidence: 'High',
    });
    const byField = Object.fromEntries(res.findings.map((f) => [f.field, f]));
    expect(byField.aiPotentialServices).toMatchObject({
      value: ['Website Creation', 'Brochure Design'], display: 'Website Creation, Brochure Design', confidence: 85, sourceUrl: home,
    });
    expect(byField.websiteAssessment).toMatchObject({ value: 'Dated brochure site without a contact form.', sourceUrl: home });
    expect(byField.specialisation).toMatchObject({ value: 'Packaging line widgets' });
    expect(byField.employeeRange).toMatchObject({ value: '51–200' });
    // Never the user's own industry or category.
    expect(byField.industry).toBeUndefined();
    expect(byField.businessCategory).toBeUndefined();
  });

  test('without web search: drops every value whose source is not a page provided', async () => {
    const answer = fullAnswer('https://invented.example/about');
    answer.industry = { value: 'Manufacturing', sourceUrl: home.replace(/\/$/, '') }; // same page, no trailing slash
    const { runner } = fakeRunner(answer);
    const res = await claudeProvider({ runner, model: 'sonnet', webSearch: false }).run(input());
    expect(res.findings).toEqual([]);
    expect(res.ai).toEqual({ aiIndustry: 'Manufacturing', aiConfidence: 'High' });
  });

  test('null answers stay empty; nothing kept means no confidence either', async () => {
    const answer: Answer = Object.fromEntries(Object.keys(fullAnswer(home)).map((k) => [k, null]));
    answer.confidence = 'Low';
    const { runner } = fakeRunner(answer);
    const res = await claudeProvider({ runner, model: 'sonnet', webSearch: false }).run(input());
    expect(res.findings).toEqual([]);
    expect(res.ai).toEqual({});
  });

  test('with web search on: asks for the tool and accepts https search sources, never other schemes', async () => {
    const found = 'https://news.example/acme-expands';
    const answer = fullAnswer(found);
    answer.specialisation = { value: 'Widgets', sourceUrl: 'http://plain.example/x' };
    answer.employeeRange = { value: '51–200', sourceUrl: 'javascript:alert(1)' };
    const { runner, calls } = fakeRunner(answer);
    const res = await claudeProvider({ runner, model: 'sonnet', webSearch: true }).run(input());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.webSearch).toBe(true);
    expect(res.findings.map((f) => [f.field, f.sourceUrl])).toEqual([
      ['aiPotentialServices', found], ['websiteAssessment', found],
    ]);
    expect(res.ai?.aiSummary).toBe('Acme makes industrial widgets for packaging lines.');
  });

  test('the whole step has one deadline: a call still running when it passes is aborted', async () => {
    const signals: AbortSignal[] = [];
    const runner: ClaudeRunner = ({ signal }) => new Promise((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason));
    });
    const started = Date.now();
    const res = await claudeProvider({ runner, model: 'sonnet', webSearch: false, budgetMs: 50 }).run(input());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(res).toMatchObject({ findings: [], error: 'Claude took too long' });
  });

  test('a wrong shape, a missing answer and runner errors give an error and no values; secrets never leak', async () => {
    const secret = 'sk-ant-oat01-secret-token-123';
    const run = async (r: unknown) =>
      claudeProvider({ runner: fakeRunner(r).runner, model: 'sonnet', webSearch: false, secrets: [secret] }).run(input());
    expect(await run({ ...fullAnswer(home), opportunityScore: { value: 140, sourceUrl: home } }))
      .toMatchObject({ findings: [], error: 'Claude returned an unexpected answer' });
    expect(await run(undefined)).toMatchObject({ findings: [], error: 'Claude returned an unexpected answer' });
    expect(await run(new ClaudeRunError('not_logged_in'))).toMatchObject({ findings: [], error: 'Claude Code is not logged in on the server' });
    expect(await run(new ClaudeRunError('timeout'))).toMatchObject({ findings: [], error: 'Claude took too long' });
    expect(await run(new ClaudeRunError('failed'))).toMatchObject({ findings: [], error: 'Claude Code failed' });
    const failed = await run(new Error(`boom ${secret}`));
    expect(failed.error).toBe('Claude Code failed');
    expect(JSON.stringify(failed)).not.toContain(secret);
  });
});

describe('claudeCodeConfig / claudeCodeReady', () => {
  test('defaults: the server binary and the sonnet alias; blank values count as missing', () => {
    expect(claudeCodeConfig({})).toEqual({ token: undefined, bin: '/root/.local/bin/claude', model: 'sonnet' });
    expect(claudeCodeConfig({ CLAUDE_CODE_OAUTH_TOKEN: ' ', CLAUDE_BIN: '', CLAUDE_MODEL: ' ' }))
      .toEqual({ token: undefined, bin: '/root/.local/bin/claude', model: 'sonnet' });
    expect(claudeCodeConfig({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_BIN: '/x/claude', CLAUDE_MODEL: 'opus' }))
      .toEqual({ token: 'tok', bin: '/x/claude', model: 'opus' });
  });

  test('ready only with a token and an executable binary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ready-'));
    const plain = join(dir, 'plain');
    await writeFile(plain, 'x', { mode: 0o644 });
    try {
      expect(await claudeCodeReady({ token: 'tok', bin: process.execPath, model: 'sonnet' })).toBe(true);
      expect(await claudeCodeReady({ token: undefined, bin: process.execPath, model: 'sonnet' })).toBe(false);
      expect(await claudeCodeReady({ token: 'tok', bin: plain, model: 'sonnet' })).toBe(false);
      expect(await claudeCodeReady({ token: 'tok', bin: join(dir, 'missing'), model: 'sonnet' })).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

type FakeFetch = typeof fetch & { calls: { url: string; init: RequestInit }[] };
function fakeFetch(...bodies: (object | number)[]): FakeFetch {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = bodies.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    if (typeof next === 'number') return new Response('{"error":"no"}', { status: next });
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FakeFetch;
  f.calls = calls;
  return f;
}

const details = {
  formattedAddress: '12 Foundry Lane, Sheffield S1 2AB, UK',
  addressComponents: [
    { longText: '12', types: ['street_number'] },
    { longText: 'Foundry Lane', types: ['route'] },
    { longText: 'Sheffield', types: ['postal_town'] },
    { longText: 'England', types: ['administrative_area_level_1', 'political'] },
    { longText: 'S1 2AB', types: ['postal_code'] },
  ],
  location: { latitude: 53.38129912, longitude: -1.47009 },
  googleMapsUri: 'https://maps.google.com/?cid=123',
  nationalPhoneNumber: '0114 496 0000',
  websiteUri: 'https://acme.example/',
};

describe('placesProvider', () => {
  const KEY = 'places-test-key-0123456789';

  test('one ID-only Text Search, then one Place Details call with the field mask, to the fixed Google endpoints', async () => {
    const f = fakeFetch({ places: [{ id: 'ChIJ_abc-123' }] }, details);
    const res = await placesProvider({ apiKey: KEY, fetchImpl: f }).run(input());
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://places.googleapis.com/v1/places:searchText',
      'https://places.googleapis.com/v1/places/ChIJ_abc-123',
    ]);
    const h0 = f.calls[0]!.init.headers as Record<string, string>;
    expect(h0['X-Goog-FieldMask']).toBe('places.id');
    expect(h0['X-Goog-Api-Key']).toBe(KEY);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ textQuery: 'Acme Widgets, Sheffield, United Kingdom', pageSize: 1 });
    expect((f.calls[1]!.init.headers as Record<string, string>)['X-Goog-FieldMask'])
      .toBe('formattedAddress,addressComponents,location,googleMapsUri,nationalPhoneNumber,websiteUri');

    expect(res.placesCalls).toBe(1);
    const byField = Object.fromEntries(res.findings.map((x) => [x.field, x.value]));
    expect(byField).toEqual({
      street: '12 Foundry Lane', city: 'Sheffield', state: 'England', zip: 'S1 2AB', lat: 53.381299, lng: -1.47009,
      mapsUrl: 'https://maps.google.com/?cid=123',
    });
    expect(res.findings.every((x) => x.sourceUrl === 'https://maps.google.com/?cid=123' && x.confidence === 85)).toBe(true);
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0]).toMatchObject({ sourceType: 'Google Places API', title: 'Google Places · ChIJ_abc-123', confidence: '85%' });
    expect(res.sources[0]!.snapshot).toContain('Phone: 0114 496 0000');
    expect(res.sources[0]!.fieldsPopulated).toContain('Phone');
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  test('no place found: no Details call, nothing counted', async () => {
    const f = fakeFetch({});
    const res = await placesProvider({ apiKey: KEY, fetchImpl: f }).run(input());
    expect(f.calls).toHaveLength(1);
    expect(res).toMatchObject({ findings: [], sources: [], placesCalls: 0 });
  });

  test('a place id that could change the path is never requested', async () => {
    const f = fakeFetch({ places: [{ id: '../../evil?x=1' }] });
    const res = await placesProvider({ apiKey: KEY, fetchImpl: f }).run(input());
    expect(f.calls).toHaveLength(1);
    expect(res.placesCalls).toBe(0);
  });

  test('an HTTP error is reported without the key', async () => {
    const f = fakeFetch({ places: [{ id: 'abc' }] }, 403);
    const res = await placesProvider({ apiKey: KEY, fetchImpl: f }).run(input());
    expect(res).toMatchObject({ findings: [], placesCalls: 1, error: 'Google Places returned HTTP 403' });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('websiteProvider', () => {
  let site: FixtureServer;
  beforeAll(async () => { site = await startFixtureServer(); });
  afterAll(async () => { await site.close(); });
  beforeEach(() => { vi.stubEnv('RESEARCH_TEST_ALLOW_HOSTS', FIXTURE_HOSTS.join(',')); });
  afterEach(() => { vi.unstubAllEnvs(); });

  test('one source record per page read, with its snapshot, fields and confidence', async () => {
    const home = site.url('site.test');
    const res = await websiteProvider({ resolve: fixtureResolver() })
      .run({ company: { ...company, website: home }, pages: [], employeeRanges: [] });
    expect(res.error).toBeUndefined();
    expect(res.pages).toHaveLength(3);
    expect(res.sources.map((s) => s.url)).toEqual([home, site.url('site.test', '/about-us'), site.url('site.test', '/contact')]);
    expect(res.sources[0]).toMatchObject({ sourceType: 'Company website', confidence: '70–90%' });
    expect(res.sources[0]!.fieldsPopulated).toContain('Legal company name');
    expect(res.sources[0]!.snapshot).toContain('We build widgets & parts for packaging lines across Europe.');
  });

  test('a site that cannot be read gives its error and no sources', async () => {
    const res = await websiteProvider({ resolve: fixtureResolver(), timeoutMs: 200 })
      .run({ company: { ...company, website: site.url('slow.test') }, pages: [], employeeRanges: [] });
    expect(res).toMatchObject({ findings: [], sources: [], error: 'Timeout fetching site' });
  });
});
