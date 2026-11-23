import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { PARITY_OUT } from './_shared';

/**
 * Prototype parity captures for release 4 (AI research): writes `<screen>-app.png` and `<screen>-proto.png` pairs at
 * 1440×900 (full page) to PARITY_DIR, or e2e/parity/out. The app side signs in as Maya (Administrator, so the engine
 * card shows) and creates a company with a unique name whose website is a local fixture site (as research.spec.ts):
 * first never researched, then after one research run (run by apps/api/test/e2e-research-jobs.ts, the e2e server has
 * no worker) with suggestions, history, sources and a snapshot. A lead at that company carries the lead page AI line.
 * The prototype side opens prototype/index.html from disk: CO-0318 (Northwind Logistics) and its lead LD-2041; for the
 * never-researched captures CO-0322 (Kestrel Engineering, no runs) and its lead LD-2034.
 */
const OUT = process.env.PARITY_DIR ?? PARITY_OUT;
const VIEWPORT = { width: 1440, height: 900 };
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const PROTO = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../prototype/index.html')).href;

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

/** Runs this company's queued research job against the fixture site (see research.spec.ts). Asynchronous: the site is served from this process. */
async function runResearchJobs(companyId: number): Promise<string> {
  const { stdout } = await promisify(execFile)('npx', ['tsx', 'test/e2e-research-jobs.ts', String(companyId)], {
    cwd: new URL('../../../api/', import.meta.url),
    env: { ...process.env, DATABASE_URL: DB, RESEARCH_TEST_ALLOW_HOSTS: '127.0.0.1' },
    encoding: 'utf8',
  });
  return stdout;
}

/** A small company site: JSON-LD with the address and founding year, a meta description, an About page. */
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Freight | Home</title>
<meta name="description" content="Fixture Freight moves containers between Pune and Rotterdam.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture Freight",
"description":"Fixture Freight moves containers between Pune and Rotterdam.","foundingDate":"2004","telephone":"+91 20 5555 0100",
"address":{"@type":"PostalAddress","streetAddress":"7 Dock Road","addressLocality":"Pune","addressRegion":"Maharashtra","postalCode":"411001"}}</script>
</head><body><nav><a href="/about">About us</a></nav><main><h1>Fixture Freight</h1><p>Containers, on time.</p></main></body></html>`,
  '/about': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About Fixture Freight</title></head>
<body><main><h1>About us</h1><p>Founded in 2004 in Pune.</p></main></body></html>`,
  '/robots.txt': 'User-agent: *\nAllow: /\n',
};

let site: Server;
let origin = '';

test.beforeAll(async () => {
  site = createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': req.url === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => site.close(() => done()));
});

test('research parity: app side', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(VIEWPORT);
  await signInAs(page, MAYA);
  const api = page.request;
  const me = await json<{ id: number }>(await api.get('/api/me'), 200);
  const tag = Date.now().toString(36).slice(-4).toUpperCase();
  const company = await json<{ id: number }>(
    await api.post('/api/companies', { data: { name: `Fixture Freight ${tag}`, country: 'India', website: `${origin}/` } }), 201);
  try {
    const card = page.getByRole('region', { name: 'AI business intelligence' });

    // Never researched: AI tab (with the engine card) and the Overview AI card.
    await page.goto(`/companies/${company.id}#ai`);
    await expect(card).toContainText('Research Not started');
    await expect(page.getByRole('region', { name: /Enrichment engine/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Projects/ })).toHaveText('Projects 0');
    await expect(page.getByRole('tab', { name: /^Research Sources/ })).toHaveText('Research Sources 0');
    await shot(page, 'ai-empty-app');
    await page.goto(`/companies/${company.id}`);
    await expect(card).toBeVisible();
    await shot(page, 'overview-empty-app');

    // A lead at the company queues the automatic run (website, never researched): the lead page AI line while pending.
    const lead = await json<{ id: number }>(
      await api.post('/api/leads', { data: { companyId: company.id, companyName: `Fixture Freight ${tag}`, country: 'India', leadSource: 'Referral', assignedToId: me.id } }), 201);
    await page.goto(`/leads/${lead.id}`);
    await expect(page.locator('.note.ai-empty')).toContainText('AI research Pending');
    await shot(page, 'lead-pending-app');

    // One research run → suggestions + history, sources + snapshot, Overview card, lead AI line.
    await page.goto(`/companies/${company.id}#ai`);
    await expect(card).toContainText('Research Pending');
    expect(await runResearchJobs(company.id)).toContain('e2e: 1 research job(s) run');
    await expect(card).toContainText('Research Completed', { timeout: 15_000 });
    await expect(page.getByRole('row', { name: /^City/ })).toBeVisible();
    // The "AI research completed" toast would cover the engine card; captures wait for it to go.
    await expect(page.getByRole('status').filter({ hasText: 'AI research completed' })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole('tab', { name: /^Research Sources/ })).toHaveText(/^Research Sources \d+$/);
    await shot(page, 'ai-suggestions-app');

    await page.getByRole('tab', { name: /^Research Sources/ }).click();
    await expect(page.getByRole('region', { name: /^Snapshot/ })).toContainText('read only');
    await shot(page, 'sources-app');

    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.locator('.legend')).toContainText('Completed');
    await shot(page, 'overview-app');

    await page.goto(`/leads/${lead.id}`);
    await expect(page.locator('.note.ai-empty')).toContainText('AI research Completed');
    await shot(page, 'lead-app');

    await page.goto('/companies');
    await expect(page.locator('.tiles .tile').nth(2).locator('.m')).toHaveText(/^\d+ pending · \d+ processing · \d+ failed$/);
    await shot(page, 'companies-app');
  } finally {
    // The domain is unique: release 127.0.0.1 so research.spec.ts can create its own fixture company.
    sql(`update companies set website=null, domain=null where id=${company.id}`);
  }
});

test('research parity: prototype side', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  const go = async (hash: string) => {
    await page.goto(`${PROTO}${hash}`);
    await page.waitForTimeout(500);
  };
  // Never researched: CO-0322 Kestrel Engineering (no runs; Pending) and its lead LD-2034.
  await go('#/companies/CO-0322/ai');
  await shot(page, 'ai-empty-proto');
  await go('#/companies/CO-0322');
  await shot(page, 'overview-empty-proto');
  await go('#/leads/LD-2034');
  await shot(page, 'lead-pending-proto');
  await go('#/companies/CO-0318/ai');
  await shot(page, 'ai-suggestions-proto');
  await go('#/companies/CO-0318/sources');
  await shot(page, 'sources-proto');
  await go('#/companies/CO-0318');
  await shot(page, 'overview-proto');
  await go('#/leads/LD-2041');
  await shot(page, 'lead-proto');
  await go('#/companies');
  await shot(page, 'companies-proto');
  await browser.close();
});
