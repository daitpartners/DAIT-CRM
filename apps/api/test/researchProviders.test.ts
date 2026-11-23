import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  CLAUDE_PRICES_USD_PER_MTOK, claudeCostUsd, claudeProvider, placesProvider, websiteProvider, type ClaudeClient,
  type ProviderInput,
} from '../src/research/providers';
import type { PageRead } from '../src/research/websiteReader';
import { FIXTURE_HOSTS, fixtureResolver, startFixtureServer, type FixtureServer } from './fixtureSites';

const company = { id: 1, name: 'Acme Widgets', website: 'https://acme.example', country: 'United Kingdom', city: 'Sheffield' };
const page = (url: string, text = 'We build widgets.'): PageRead => ({ url, title: 'Acme', text, fields: [] });
const input = (pages: PageRead[] = [page('https://acme.example/')], employeeRanges = ['11–50', '51–200']): ProviderInput =>
  ({ company, pages, employeeRanges });

describe('claudeCostUsd', () => {
  test('prices input, output, cache and web search from the per-model table', () => {
    const p = CLAUDE_PRICES_USD_PER_MTOK['claude-opus-5-5']!;
    expect(claudeCostUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(p.input);
    expect(claudeCostUsd('claude-opus-5-5', { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(p.output);
    expect(claudeCostUsd('claude-opus-5-5', {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 2 },
    })).toBeCloseTo(p.input * 0.1 + p.input * 1.25 + 0.02);
  });

  test('an unknown model is costed at the most expensive row', () => {
    const max = Math.max(...Object.values(CLAUDE_PRICES_USD_PER_MTOK).map((r) => r.output));
    expect(claudeCostUsd('claude-unknown', { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(max);
  });
});

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

function message(answer: unknown, extra: Partial<Anthropic.Message> = {}, before: Anthropic.ContentBlock[] = []): Anthropic.Message {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
    content: [...before, { type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer), citations: null }],
    usage: { input_tokens: 10_000, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...extra,
  } as unknown as Anthropic.Message;
}

function fakeClaude(...responses: (Anthropic.Message | Error)[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ClaudeClient = {
    create: async (params) => {
      calls.push(params);
      const next = responses.shift();
      if (!next) throw new Error('unexpected Claude call');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { client, calls };
}

describe('claudeProvider', () => {
  const home = 'https://acme.example/';

  test('asks for the fixed JSON schema and returns ai_* values and suggestions sourced from the pages', async () => {
    const { client, calls } = fakeClaude(message(fullAnswer(home)));
    const res = await claudeProvider({ client, model: 'claude-opus-5-5', webSearch: false }).run(input());
    expect(res.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.model).toBe('claude-opus-5-5');
    // The fixed schema, and no other output setting (no effort parameter).
    expect(req.output_config).toEqual({ format: { type: 'json_schema', schema: expect.any(Object) } });
    expect(req.tools).toBeUndefined();
    expect(JSON.stringify(req.messages)).toContain('We build widgets.');

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
    expect(res.costUsd).toBeCloseTo(claudeCostUsd('claude-opus-5-5', { input_tokens: 10_000, output_tokens: 1_000 }));
  });

  test('drops every value whose source is not a page provided or a web search result', async () => {
    const answer = fullAnswer('https://invented.example/about');
    answer.industry = { value: 'Manufacturing', sourceUrl: home.replace(/\/$/, '') }; // same page, no trailing slash
    const { client } = fakeClaude(message(answer));
    const res = await claudeProvider({ client, model: 'claude-opus-5-5', webSearch: false }).run(input());
    expect(res.findings).toEqual([]);
    expect(res.ai).toEqual({ aiIndustry: 'Manufacturing', aiConfidence: 'High' });
  });

  test('null answers stay empty; nothing kept means no confidence either', async () => {
    const answer: Answer = Object.fromEntries(Object.keys(fullAnswer(home)).map((k) => [k, null]));
    answer.confidence = 'Low';
    const { client } = fakeClaude(message(answer));
    const res = await claudeProvider({ client, model: 'claude-opus-5-5', webSearch: false }).run(input());
    expect(res.findings).toEqual([]);
    expect(res.ai).toEqual({});
  });

  test('with web search on: sends the web search tool and accepts its result URLs as sources', async () => {
    const found = 'https://news.example/acme-expands';
    const search = {
      type: 'web_search_tool_result', tool_use_id: 'srv_1',
      content: [{ type: 'web_search_result', url: found, title: 'Acme expands', encrypted_content: 'x', page_age: null }],
    } as unknown as Anthropic.ContentBlock;
    const answer = fullAnswer(found);
    const { client, calls } = fakeClaude(message(answer, { usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 1 } } as never }, [search]));
    const res = await claudeProvider({ client, model: 'claude-opus-5-5', webSearch: true }).run(input());
    expect(calls[0]!.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    expect(res.findings.map((f) => f.sourceUrl)).toEqual([found, found, found, found]);
    expect(res.costUsd).toBeCloseTo(0.01);
  });

  test('a paused turn is resumed and both turns are costed', async () => {
    const { client, calls } = fakeClaude(
      message('', { stop_reason: 'pause_turn' }),
      message(fullAnswer(home)),
    );
    const res = await claudeProvider({ client, model: 'claude-opus-5-5', webSearch: true }).run(input());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.at(-1)!.role).toBe('assistant');
    expect(res.costUsd).toBeCloseTo(2 * claudeCostUsd('claude-opus-5-5', { input_tokens: 10_000, output_tokens: 1_000 }));
    expect(res.findings.length).toBeGreaterThan(0);
  });

  test('the whole step has one deadline: a request still running when it passes is aborted', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client: ClaudeClient = {
      create: (_params, options) => new Promise((_resolve, reject) => {
        signals.push(options?.signal);
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason));
      }),
    };
    const started = Date.now();
    const res = await claudeProvider({ client, model: 'claude-opus-5-5', webSearch: false, budgetMs: 50 }).run(input());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(res).toMatchObject({ findings: [], error: 'Claude took too long' });
  });

  test('refusal, malformed JSON, a wrong shape and an API error give an error and no values', async () => {
    const run = async (r: Anthropic.Message | Error) =>
      claudeProvider({ client: fakeClaude(r).client, model: 'claude-opus-5-5', webSearch: false, secrets: ['sk-ant-secret-key-123'] }).run(input());
    expect(await run(message('', { stop_reason: 'refusal' }))).toMatchObject({ findings: [], error: 'Claude declined the request' });
    expect(await run(message('not json'))).toMatchObject({ findings: [], error: 'Claude returned an unexpected answer' });
    expect(await run(message({ ...fullAnswer(home), opportunityScore: { value: 140, sourceUrl: home } })))
      .toMatchObject({ findings: [], error: 'Claude returned an unexpected answer' });
    const failed = await run(new Error('boom sk-ant-secret-key-123'));
    expect(failed.error).toBe('Could not reach Claude');
    expect(JSON.stringify(failed)).not.toContain('sk-ant-secret-key-123');
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
    expect(res.sources[0]).toMatchObject({ sourceType: 'Google Places API', title: 'Google Places · ChIJ_abc-123' });
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
    expect(res.sources[0]).toMatchObject({ sourceType: 'Company website', confidence: '70–90' });
    expect(res.sources[0]!.fieldsPopulated).toContain('Legal company name');
    expect(res.sources[0]!.snapshot).toContain('We build widgets & parts for packaging lines across Europe.');
  });

  test('a site that cannot be read gives its error and no sources', async () => {
    const res = await websiteProvider({ resolve: fixtureResolver(), timeoutMs: 200 })
      .run({ company: { ...company, website: site.url('slow.test') }, pages: [], employeeRanges: [] });
    expect(res).toMatchObject({ findings: [], sources: [], error: 'Timeout fetching site' });
  });
});
