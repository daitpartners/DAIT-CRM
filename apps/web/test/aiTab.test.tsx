import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CompanyDetail } from '../src/api/companies';
import type { Me } from '../src/api/queries';
import type { EnrichmentView, ResearchView } from '../src/api/research';
import { AiCard, useResearchRunner } from '../src/pages/companies/AiCard';
import { AiTab } from '../src/pages/companies/tabs/AiTabs';
import { Wrap, makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const admin: Me = { ...rep, id: 1, name: 'Maya Pillai', role: 'Administrator', rights: [...rep.rights, 'view_admin_settings', 'manage_users'] };
const viewer: Me = { ...rep, rights: ['manage_leads'] };

const COMPANY = { id: 4, number: 'CO-0318', name: 'Northwind Logistics' } as unknown as CompanyDetail;

function view(o: Partial<ResearchView> = {}, company: Partial<ResearchView['company']> = {}): ResearchView {
  return {
    company: {
      aiSummary: null, aiIndustry: null, aiBusinessCategory: null, aiPotentialServices: [], aiOpportunityScore: null, aiConfidence: null,
      aiResearchStatus: 'Not started', aiLastResearchAt: null, verificationStatus: 'Unverified', verifiedFields: {}, ...company,
    },
    pending: [], runs: [], canEdit: true, ...o,
  };
}

const SUGGESTIONS: ResearchView['pending'] = [
  { id: 11, runId: 3, field: 'city', label: 'City', value: 'Pune', display: null, confidence: 90, sourceUrl: 'https://northwind.in/contact',
    sourceLabel: 'northwind.in/contact', currentValue: null, locked: false },
  { id: 12, runId: 3, field: 'yearEstablished', label: 'Year established', value: 2004, display: null, confidence: 85,
    sourceUrl: 'https://northwind.in/about', sourceLabel: null, currentValue: 2003, locked: true },
  { id: 13, runId: 3, field: 'websiteTechnology', label: 'Website technology', value: 'WordPress', display: null, confidence: 70,
    sourceUrl: 'https://northwind.in/', sourceLabel: null, currentValue: null, locked: false },
];

const RUN: ResearchView['runs'][number] = {
  id: 3, createdAt: '2026-11-23T09:00:00.000Z', trigger: 'Manual · Maya Pillai', engine: 'Website reader', sources: 'northwind.in (3 pages)',
  result: '3 suggestions', appliedCount: 1, status: 'Completed', startedAt: null, finishedAt: null,
};

const ENGINE: EnrichmentView = {
  dailyRunLimit: 50, claudeEnabled: false, claudeMonthlyCapUsd: 0, placesEnabled: false, placesMonthlyCallCap: 0, webSearchEnabled: false,
  claudeKeyPresent: false, placesKeyPresent: false, claudeSpentThisMonthUsd: 0, placesCallsThisMonth: 0,
};

type Call = { method: string; url: string; body?: unknown };

let signedIn: Me = rep;

function stub({ research = view(), engine = ENGINE, post = {} as Record<string, Response | (() => Response)> } = {}) {
  const calls: Call[] = [];
  let current = research;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/me') return Response.json(signedIn);
    const key = `${method} ${url}`;
    if (post[key]) {
      const r = post[key];
      return typeof r === 'function' ? r() : r.clone();
    }
    if (key === 'GET /api/companies/4/research') return Response.json(current);
    if (key === 'GET /api/settings/enrichment') return Response.json(engine);
    if (key === 'PUT /api/settings/enrichment') return Response.json({ ...engine, ...(JSON.parse(String(init!.body)) as object) });
    if (key === 'POST /api/companies/4/research') return Response.json({ runId: 9 }, { status: 202 });
    // As the server: a decided suggestion leaves the pending list (its row unmounts on the refetch).
    if (method === 'POST' && url.startsWith('/api/research/suggestions/')) {
      const id = Number(url.split('/')[4]);
      current = { ...current, pending: current.pending.filter((x) => x.id !== id) };
      return Response.json({ id, decision: url.endsWith('/accept') ? 'accepted' : 'rejected' });
    }
    if (key === 'POST /api/companies/4/research/accept-high') {
      current = { ...current, pending: current.pending.filter((x) => x.locked || x.confidence < 80) };
      return Response.json({ accepted: 2 });
    }
    if (key === 'POST /api/companies/4/verify-profile') return Response.json({ ok: true });
    return Response.json({});
  }));
  return { calls, set: (v: ResearchView) => { current = v; } };
}

/** The profile owns one research runner and hands it to the tab and the Overview card. */
function Tab() {
  return <AiTab company={COMPANY} research={useResearchRunner(4)} />;
}

function Card() {
  return <AiCard companyId={4} research={useResearchRunner(4)} />;
}

function mount(me: Me = rep) {
  signedIn = me;
  render(
    <Wrap qc={makeClient(me)}>
      <Tab />
    </Wrap>,
  );
}

const suggestions = () => screen.getByRole('region', { name: /Suggestions awaiting review/ });
const posts = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);

describe('AI Intelligence tab (prototype views-companies.js tab ai)', () => {
  it('empty: no score, no summary, nothing waiting, no runs; classification dashes', async () => {
    stub();
    mount();
    const card = await screen.findByRole('region', { name: 'AI business intelligence' });
    await within(card).findByRole('button', { name: 'Re-run research' });
    expect(card).toHaveTextContent('Opportunity score not yet computed');
    expect(card).toHaveTextContent('Confidence — · Research Not started');
    expect(card).toHaveTextContent('Last research never · Unverified');
    expect(card).toHaveTextContent('No AI summary yet. Run research to generate one.');
    expect(card).toHaveTextContent('Engine: pluggable (Ollama self-hosted or Claude API). Suggestions are stored in enrichment_history and applied only to unverified fields.');
    expect(within(card).getByRole('button', { name: 'Re-run research' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Mark profile verified' })).toBeEnabled();
    expect(within(card).queryByRole('link', { name: 'Review suggestions' })).toBeNull();

    expect(suggestions()).toHaveTextContent('Nothing waiting. Run AI research to generate suggestions for unverified fields.');
    expect(suggestions()).toHaveTextContent('Accepting writes the value. Verified fields are locked and never overwritten.');
    expect(within(suggestions()).queryByRole('button', { name: 'Accept all ≥ 80%' })).toBeNull();
    expect(within(suggestions()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
      ['Field', 'Current value', 'AI suggestion', 'Confidence', 'Source', 'Decision'],
    );
    const history = screen.getByRole('region', { name: /Enrichment history/ });
    expect(history).toHaveTextContent('No research runs yet.');
    expect(within(history).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
      ['Run', 'Trigger', 'Engine', 'Sources', 'Result', 'Applied', 'Status'],
    );
    const cls = screen.getByRole('region', { name: 'AI classification' });
    expect(cls).toHaveTextContent('Industry—Business category—Opportunity score—Confidence—Potential services—');
  });

  it('suggestions: NULL for an empty current value, a locked row reads "Locked · verified" with no buttons', async () => {
    stub({ research: view({ pending: SUGGESTIONS, runs: [RUN] }, { aiResearchStatus: 'Completed', aiLastResearchAt: RUN.createdAt, verifiedFields: { yearEstablished: true } }) });
    mount();
    const city = await screen.findByRole('row', { name: /^City/ });
    expect(city).toHaveTextContent('CityNULLPuneAI · 90%northwind.in/contact');
    expect(within(city).getByRole('link', { name: 'northwind.in/contact' })).toHaveAttribute('href', 'https://northwind.in/contact');
    const year = screen.getByRole('row', { name: /^Year established/ });
    expect(year).toHaveTextContent('2003VERIFIED');
    expect(year).toHaveTextContent('Locked · verified');
    expect(within(year).queryByRole('button')).toBeNull();
    expect(within(suggestions()).getByRole('heading')).toHaveTextContent('Suggestions awaiting review 3');
    const run = screen.getByRole('row', { name: /Manual · Maya Pillai/ });
    expect(run).toHaveTextContent('Manual · Maya PillaiWebsite readernorthwind.in (3 pages)3 suggestions1Completed');
  });

  it('accept, reject and Accept all ≥ 80% call the API and toast as the prototype', async () => {
    const u = userEvent.setup();
    const { calls } = stub({ research: view({ pending: SUGGESTIONS, runs: [RUN] }) });
    mount();
    const city = await screen.findByRole('row', { name: /^City/ });
    await u.click(within(city).getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Accepted · City updated (marked AI-sourced)')).toBeInTheDocument();
    const tech = screen.getByRole('row', { name: /^Website technology/ });
    await u.click(within(tech).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    await u.click(within(suggestions()).getByRole('button', { name: 'Accept all ≥ 80%' }));
    expect(await screen.findByText('2 suggestions accepted')).toBeInTheDocument();
    expect(posts(calls)).toEqual([
      'POST /api/research/suggestions/11/accept',
      'POST /api/research/suggestions/13/reject',
      'POST /api/companies/4/research/accept-high',
    ]);
  });

  it('a locked field refused by the server warns "Field is verified · not overwritten"', async () => {
    const u = userEvent.setup();
    stub({
      research: view({ pending: SUGGESTIONS }),
      post: { 'POST /api/research/suggestions/11/accept': Response.json({ error: 'locked' }, { status: 409 }) },
    });
    mount();
    await u.click(within(await screen.findByRole('row', { name: /^City/ })).getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Field is verified · not overwritten')).toBeInTheDocument();
  });

  it('run research queues a job; the button is disabled while Pending / Processing and the query polls until done', async () => {
    const u = userEvent.setup();
    const { calls, set } = stub();
    mount();
    const card = await screen.findByRole('region', { name: 'AI business intelligence' });
    await within(card).findByRole('button', { name: 'Re-run research' });
    set(view({}, { aiResearchStatus: 'Pending' }));
    await u.click(within(card).getByRole('button', { name: 'Re-run research' }));
    expect(await screen.findByText('Enrichment job queued · running in background')).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Re-run research' })).toBeDisabled());
    expect(card).toHaveTextContent('Research Pending');
    set(view({ pending: SUGGESTIONS.slice(0, 1), runs: [RUN] }, { aiResearchStatus: 'Completed', aiLastResearchAt: RUN.createdAt }));
    expect(await screen.findByText('AI research completed · 1 suggestion to review', {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Re-run research' })).toBeEnabled());
    expect(posts(calls)).toEqual(['POST /api/companies/4/research']);
  }, 10_000);

  it('a second run while one is pending, or over the daily limit, is refused with a message', async () => {
    const u = userEvent.setup();
    stub({ post: { 'POST /api/companies/4/research': Response.json({ error: 'research_running' }, { status: 409 }) } });
    mount();
    const card = await screen.findByRole('region', { name: 'AI business intelligence' });
    await within(card).findByRole('button', { name: 'Re-run research' });
    await u.click(within(card).getByRole('button', { name: 'Re-run research' }));
    expect(await screen.findByText('Research is already running for this company.')).toBeInTheDocument();
  });

  it('mark profile verified posts and toasts', async () => {
    const u = userEvent.setup();
    const { calls } = stub();
    mount();
    await u.click(await screen.findByRole('button', { name: 'Mark profile verified' }));
    expect(await screen.findByText('All filled fields marked verified')).toBeInTheDocument();
    expect(posts(calls)).toEqual(['POST /api/companies/4/verify-profile']);
  });

  it('a user who may not edit sees the tab without action buttons and without the engine card', async () => {
    const { calls } = stub({ research: view({ pending: SUGGESTIONS, canEdit: false }) });
    mount(viewer);
    await screen.findByRole('row', { name: /^City/ });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('region', { name: /Enrichment engine/ })).toBeNull();
    expect(calls.some((c) => c.url === '/api/settings/enrichment')).toBe(false);
  });

  it('engine card (Administrators): reader always on, key-missing hints, Ollama and Apollo disabled', async () => {
    stub();
    mount(admin);
    const engine = await screen.findByRole('region', { name: /Enrichment engine/ });
    await waitFor(() => expect(engine).toHaveTextContent('Add ANTHROPIC_API_KEY on the server to enable'));
    expect(engine).toHaveTextContent('Modular providers. Switching never changes the data model.');
    expect(engine).toHaveTextContent('Add GOOGLE_PLACES_API_KEY on the server to enable');
    expect(engine).toHaveTextContent('Credentials live in server environment variables, never in the browser or public site.');
    expect(within(engine).getByRole('radio', { name: /Website reader/ })).toBeChecked();
    expect(within(engine).getByRole('radio', { name: /Claude API/ })).toBeDisabled();
    expect(within(engine).getByRole('radio', { name: /Ollama/ })).toBeDisabled();
    expect(within(engine).getByRole('checkbox', { name: 'Public company website' })).toBeChecked();
    expect(within(engine).getByRole('checkbox', { name: 'Public company website' })).toBeDisabled();
    expect(within(engine).getByRole('checkbox', { name: /Google Places API/ })).toBeDisabled();
    expect(within(engine).getByRole('checkbox', { name: /Apollo\.io/ })).toBeDisabled();
    expect(within(engine).getByRole('checkbox', { name: /Web search/ })).toBeDisabled();
    expect(within(engine).queryByLabelText('Monthly cap (USD)')).toBeNull();
    expect(within(engine).getByLabelText('Daily run limit')).toHaveValue(50);
  });

  it('engine card with keys: Claude selectable with its cap and spend, Places switch and call cap; saves', async () => {
    const u = userEvent.setup();
    const { calls } = stub({
      engine: { ...ENGINE, claudeKeyPresent: true, placesKeyPresent: true, claudeSpentThisMonthUsd: 1.25, placesCallsThisMonth: 4, claudeMonthlyCapUsd: 10 },
    });
    mount(admin);
    const engine = await screen.findByRole('region', { name: /Enrichment engine/ });
    await waitFor(() => expect(within(engine).getByRole('radio', { name: /Claude API/ })).toBeEnabled());
    expect(engine).toHaveTextContent('spent this month USD 1.25');
    expect(engine).toHaveTextContent('4 calls this month');
    await u.click(within(engine).getByRole('radio', { name: /Claude API/ }));
    expect(await screen.findByText('Engine set to Claude API')).toBeInTheDocument();
    const limit = within(engine).getByLabelText('Daily run limit');
    await u.clear(limit);
    await u.type(limit, '20');
    await u.tab();
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    expect(puts[0]).toEqual({ dailyRunLimit: 50, claudeEnabled: true, claudeMonthlyCapUsd: 10, placesEnabled: false, placesMonthlyCallCap: 0, webSearchEnabled: false });
    expect(puts[1]).toMatchObject({ dailyRunLimit: 20, claudeEnabled: true });
  });
});

describe('Overview AI card (small)', () => {
  it('shows the summary, score and the Review suggestions / Run research actions', async () => {
    stub({ research: view({}, { aiSummary: 'Freight forwarder in Pune.', aiOpportunityScore: 72, aiConfidence: 'High', aiResearchStatus: 'Completed' }) });
    render(
      <Wrap qc={makeClient()}>
        <Card />
      </Wrap>,
    );
    const card = await screen.findByRole('region', { name: 'AI business intelligence' });
    await waitFor(() => expect(card).toHaveTextContent('Opportunity score 72 / 100'));
    expect(card).toHaveTextContent('AI company summary. Freight forwarder in Pune.');
    expect(card).toHaveTextContent('Confidence High · Research Completed');
    expect(within(card).getByRole('link', { name: 'Review suggestions' })).toHaveAttribute('href', '/companies/4#ai');
    expect(within(card).getByRole('button', { name: 'Run research' })).toBeEnabled();
    expect(within(card).queryByRole('button', { name: 'Re-run research' })).toBeNull();
  });
});
