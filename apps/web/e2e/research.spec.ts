import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';

/**
 * Runs this company's queued research job (apps/api/test/e2e-research-jobs.ts): the e2e server has no worker, so the
 * real worker is not running; the helper calls the same job handler. The reader may reach the fixture site below only
 * because 127.0.0.1 is on RESEARCH_TEST_ALLOW_HOSTS under NODE_ENV test.
 */
async function runResearchJobs(companyId: number): Promise<string> {
  // Asynchronous: the fixture site is served from this process, so it must keep answering while the job runs.
  const { stdout } = await promisify(execFile)('npx', ['tsx', 'test/e2e-research-jobs.ts', String(companyId)], {
    cwd: new URL('../../api/', import.meta.url),
    env: { ...process.env, DATABASE_URL: DB, RESEARCH_TEST_ALLOW_HOSTS: '127.0.0.1' },
    encoding: 'utf8',
  });
  return stdout;
}

/** A small company site: JSON-LD with the address, a meta description, an About page. */
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Freight | Home</title>
<meta name="description" content="Fixture Freight moves containers between Pune and Rotterdam.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture Freight",
"description":"Fixture Freight moves containers between Pune and Rotterdam.","foundingDate":"2004",
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
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

test('run research on a company website → suggestions → accept one → verified on the Overview', async ({ page }) => {
  await signInAs(page, MAYA);
  const created = await page.request.post('/api/companies', { data: { name: `Fixture Freight ${Date.now()}`, country: 'India', website: `${origin}/` } });
  expect(created.status()).toBe(201);
  const company = (await created.json()) as { id: number };

  await page.goto(`/companies/${company.id}#ai`);
  const card = page.getByRole('region', { name: 'AI business intelligence' });
  await expect(card).toContainText('Opportunity score not yet computed');
  await expect(card).toContainText('Research Not started');
  await expect(page.getByRole('region', { name: /Suggestions awaiting review/ })).toContainText(
    'Nothing waiting. Run AI research to generate suggestions for unverified fields.',
  );
  // Administrators see the engine card: the reader is on, Claude Code waits for its token and Places for its key.
  const engine = page.getByRole('region', { name: /Enrichment engine/ });
  await expect(engine).toContainText('Add CLAUDE_CODE_OAUTH_TOKEN on the server to enable');
  await expect(engine).toContainText('Claude Code on this server · intelligence + web search');
  await expect(engine.getByRole('radio', { name: /Website reader/ })).toBeChecked();

  await card.getByRole('button', { name: 'Re-run research' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Enrichment job queued · running in background' })).toBeVisible();
  await expect(card).toContainText('Research Pending');
  await expect(card.getByRole('button', { name: 'Re-run research' })).toBeDisabled();

  expect(await runResearchJobs(company.id)).toContain('e2e: 1 research job(s) run');

  // The page polls while the run is queued and picks up the result.
  await expect(page.getByRole('status').filter({ hasText: /AI research completed · \d+ suggestions? to review/ })).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('Research Completed');
  const history = page.getByRole('region', { name: /Enrichment history/ });
  await expect(history.getByRole('row').nth(1)).toContainText('Manual · Maya Pillai');
  await expect(history.getByRole('row').nth(1)).toContainText('Website reader');
  const city = page.getByRole('row', { name: /^City/ });
  await expect(city).toContainText('NULL');
  await expect(city).toContainText('Pune');
  await expect(city).toContainText('AI · 90%');

  await city.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Accepted · City updated (marked AI-sourced)' })).toBeVisible();
  await expect(page.getByRole('row', { name: /^City/ })).toHaveCount(0);
  await expect(history.getByRole('row').nth(1)).toContainText(/suggestions\s*1\s*Completed/);

  // Research Sources: one record per page read, with the newest snapshot read only.
  await page.getByRole('tab', { name: /^Research Sources/ }).click();
  await expect(page.getByRole('region', { name: /^Research sources/ }).getByRole('link', { name: 'Fixture Freight | Home' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Snapshot/ })).toContainText('read only');

  // Overview: the accepted value, marked VERIFIED; the AI card shows the finished run.
  await page.getByRole('tab', { name: 'Overview' }).click();
  const address = page.getByRole('region', { name: 'Company address' });
  await expect(address.locator('dt', { hasText: /^City$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText(/^Pune\s*VERIFIED$/);
  await expect(page.locator('.legend')).toContainText('Completed');

  // The Companies list AI research queue tile: pending + processing + failed, split in its meta line.
  await page.goto('/companies');
  await expect(page.locator('.tiles .tile').nth(2).locator('.m')).toHaveText(/^\d+ pending · \d+ processing · \d+ failed$/);
});
