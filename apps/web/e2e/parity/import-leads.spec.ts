import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect, test, type Locator, type Page } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { PARITY_OUT } from './_shared';

/**
 * Mockup parity captures for Import leads: writes `<name>.png` (app) and `<name>-mockup.png` pairs at 1440×900 (full
 * page; the batch detail as its own card) to PARITY_DIR, or e2e/parity/out. The app side signs in as Maya
 * (Administrator: "Add these countries" and Undo show) and builds a batch close to the mockup's sample: the same
 * company names and countries in an "Expo-Dubai-visitors.xlsx" with the Firma column, a GITEX PDF, a Word file of
 * Madrid contacts and a scanned PDF (built by the API's test fixture builders through `npx tsx`), researched against
 * local fixture sites (apps/api/test/e2e-import-jobs.ts runs the jobs; Claude off), reviewed and imported. The mockup
 * side opens docs/superpowers/mockups/2026-11-24-import-leads.html from disk and clicks through the same steps.
 */
const OUT = process.env.PARITY_DIR ?? PARITY_OUT;
const VIEWPORT = { width: 1440, height: 900 };
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const API_DIR = new URL('../../../api/', import.meta.url);
const MOCKUP = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/superpowers/mockups/2026-11-24-import-leads.html')).href;
const HOSTS = ['construibericas.test', 'northgateretail.test'];

async function shot(target: Page | Locator, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const page = 'page' in target ? target.page() : target;
  await page.waitForTimeout(400);
  if ('page' in target) await target.screenshot({ path: join(OUT, `${name}.png`) });
  else await target.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

async function runImportJobs(batchId: number): Promise<string> {
  // Asynchronous: the fixture sites are served from this process.
  const { stdout } = await promisify(execFile)('npx', ['tsx', 'test/e2e-import-jobs.ts', String(batchId)], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: DB, RESEARCH_TEST_ALLOW_HOSTS: ['127.0.0.1', ...HOSTS].join(',') },
    encoding: 'utf8',
  });
  return stdout;
}

/** The PDF, Word and scanned files, from the API's import fixture builders (apps/api/test/importFixtures.ts). */
async function documents(): Promise<{ gitex: Buffer; madrid: Buffer; scanned: Buffer }> {
  const code = `import('./test/importFixtures.ts').then(async (f) => {
    const gitex = await f.pdfWithText(['GITEX Global 2026 · Exhibitor list\\n\\nGulf Freight Partners LLC · gulffreight.ae · sales@gulffreight.ae · United Arab Emirates\\nHarbourview Hotels · harbourviewhotels.com.au · events@harbourviewhotels.com.au · Australia']);
    const madrid = await f.docx(['Contacts from the Madrid trip', '', 'Quantum Pharma Pvt Ltd', 'Rahul Verma', 'rahul.verma@quantumpharma.in', '+91 22 5555 0187', 'Mumbai, India']);
    const scanned = await f.pdfImageOnly(6);
    process.stdout.write(JSON.stringify({ gitex: gitex.toString('base64'), madrid: madrid.toString('base64'), scanned: scanned.toString('base64') }));
  })`;
  const { stdout } = await promisify(execFile)('npx', ['tsx', '--eval', code], { cwd: API_DIR, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const b = JSON.parse(stdout) as Record<'gitex' | 'madrid' | 'scanned', string>;
  return { gitex: Buffer.from(b.gitex, 'base64'), madrid: Buffer.from(b.madrid, 'base64'), scanned: Buffer.from(b.scanned, 'base64') };
}

/** The visitors workbook (as the mockup's step 2): Ready, Missing details, Already in CRM, Not a lead, unknown countries. */
async function visitorsWorkbook(port: number): Promise<Buffer> {
  const rows = [
    ['Firma', 'Contact', 'Designation', 'City', 'Country', 'Website', 'E-mail', 'Phone'],
    ['Al Noor Logistics LLC', 'Omar Haddad', 'Operations Director', 'Dubai', 'United Arab Emirates', 'alnoorlogistics.ae', 'omar.h@alnoorlogistics.ae', '+971 4 555 0134'],
    ['Brightline Dental Clinics', 'Dr. Priya Shah', '', 'Toronto', 'Canada', '', '', '+1 416 555 0142'],
    ['Construcciones Ibéricas SL', 'Lucía Romero', 'Gerente', 'Madrid', 'Spain', `http://construibericas.test:${port}/`, '', ''],
    ['Meridian Textiles Ltd', 'James Booth', 'CEO', 'Manchester', 'United Kingdom', 'meridiantextiles.co.uk', 'j.booth@meridiantextiles.co.uk', ''],
    ['Northgate Retail Group', '', '', '', '', `http://northgateretail.test:${port}/`, '', ''],
    ['TOTAL VISITORS DAY 2', '', '', '', '', '', '', ''],
    ['Mercado Andino SpA', 'Valentina Rojas', 'Gerente Comercial', 'Santiago', 'Chile', 'mercadoandino.cl', 'v.rojas@mercadoandino.cl', ''],
    ['Andes Logística Ltda', 'Diego Soto', '', 'Valparaíso', 'Chile', 'andeslogistica.cl', 'dsoto@andeslogistica.cl', ''],
    ['Grupo Azteca Distribución', 'Mariana López', '', 'Monterrey', 'Mexico', 'grupoazteca.mx', 'mlopez@grupoazteca.mx', ''],
  ];
  const code = `import('./test/importFixtures.ts').then((f) => process.stdout.write(f.xlsxBook({ Visitors: ${JSON.stringify(rows)} }).toString('base64')))`;
  const { stdout } = await promisify(execFile)('npx', ['tsx', '--eval', code], { cwd: API_DIR, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return Buffer.from(stdout, 'base64');
}

/** Fixture sites: Construcciones' contact email; Northgate's city (JSON-LD) and email. */
const SITES: Record<string, Record<string, string>> = {
  'construibericas.test': {
    '/': `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Construcciones Ibéricas</title></head>
<body><main><h1>Construcciones Ibéricas SL</h1><p>Escríbenos: <a href="mailto:contacto@construibericas.test">contacto@construibericas.test</a></p></main></body></html>`,
  },
  'northgateretail.test': {
    '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northgate Retail Group</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Northgate Retail Group",
"address":{"@type":"PostalAddress","streetAddress":"100 High Street","addressLocality":"Columbus","addressRegion":"Ohio"}}</script></head>
<body><main><h1>Northgate Retail Group</h1><p><a href="mailto:hello@northgateretail.test">hello@northgateretail.test</a></p></main></body></html>`,
  },
};

let site: Server;
let port = 0;

test.beforeAll(async () => {
  site = createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/robots.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    const body = SITES[host]?.[path];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
  port = (site.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((done) => site.close(() => done()));
});

test('import leads parity: app side', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(VIEWPORT);
  const [workbook, docs] = await Promise.all([visitorsWorkbook(port), documents()]);
  await signInAs(page, MAYA);

  // Step 1 alert: continuing with nothing chosen.
  await page.goto('/leads/import');
  await page.getByRole('button', { name: 'Sort the data →' }).click();
  await expect(page.getByRole('alert')).toContainText('Choose the outreach language');
  await shot(page, 'import-step1-alert');

  // Step 1: English + Prospects, the four files read.
  await page.getByText('English leads').click();
  await page.getByText('Prospects', { exact: true }).click();
  await page.setInputFiles('#imp-files', [
    { name: 'Expo-Dubai-visitors.xlsx', mimeType: 'application/octet-stream', buffer: workbook },
    { name: 'GITEX exhibitor list 2026.pdf', mimeType: 'application/pdf', buffer: docs.gitex },
    { name: 'Carlos – contacts from Madrid trip.docx', mimeType: 'application/octet-stream', buffer: docs.madrid },
    { name: 'Scanned cards.pdf', mimeType: 'application/pdf', buffer: docs.scanned },
  ]);
  await expect(page.locator('.conn-row')).toHaveCount(4);
  await expect(page).toHaveURL(/batch=\d+&step=1/);
  const batchId = Number(new URL(page.url()).searchParams.get('batch'));
  expect(await runImportJobs(batchId)).toMatch(/e2e: 4 import job\(s\) run/);
  await expect(page.locator('.conn-row .badge')).toHaveText(['Read', 'Read', 'Read', "Can't read scans yet"], { timeout: 15_000 });
  await shot(page, 'import-step1');

  // Step 2: the Firma question, tiles and the sorted rows.
  await page.getByRole('button', { name: 'Sort the data →' }).click();
  await expect(page).toHaveURL(/step=2/);
  await expect(page.locator('.note.warn').first()).toContainText('"Firma"');
  await shot(page, 'import-step2');
  await page.locator('.note.warn').filter({ hasText: '"Firma"' }).getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.note.ok')).toContainText('is now the Company name.');

  // Step 3: research (website reader only) → Done.
  await page.getByRole('button', { name: 'Research missing details →' }).click();
  await expect(page).toHaveURL(/step=3/);
  expect(await runImportJobs(batchId)).toMatch(/e2e: \d+ import job\(s\) run/);
  await expect(page.locator('.sec-title-row .badge')).toHaveText('Done', { timeout: 15_000 });
  await expect(page.getByText('contacto@construibericas.test')).toBeVisible();
  await shot(page, 'import-step3');

  // Step 4: before any choice (the owner's rule: nothing ticked).
  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page).toHaveURL(/step=4/);
  await expect(page.getByText('Chile', { exact: false }).first()).toBeVisible();
  await shot(page, 'import-step4');

  // Import, then the Data manager list and the batch detail.
  await page.getByRole('radio', { name: 'Import them' }).check();
  await page.getByRole('button', { name: /^Import \d+ prospects?$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/leads/import/manager\\?batch=${batchId}$`));
  expect(await runImportJobs(batchId)).toMatch(/e2e: 1 import job\(s\) run/);
  const number = ((await (await page.request.get(`/api/imports/batches/${batchId}`)).json()) as { number: string }).number;
  const detail = page.getByRole('region', { name: `Batch ${number}` });
  await expect(detail.getByRole('button', { name: 'Undo this import…' })).toBeVisible({ timeout: 15_000 });
  await shot(detail, 'batch-detail');
  await page.goto('/leads/import/manager');
  await expect(page.getByRole('region', { name: 'Import batches' }).getByRole('row').filter({ hasText: number })).toContainText('Imported');
  await shot(page, 'data-manager');
});

test('import leads parity: mockup side', async () => {
  test.setTimeout(60_000);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  await page.goto(MOCKUP);
  await shot(page, 'import-step1-mockup');
  await page.locator('#s1 [data-go="2"]').click();
  await page.waitForTimeout(1000); // the alert's flash animation
  await shot(page, 'import-step1-alert-mockup');
  await page.locator('input[name="lang"][value="en"]').check();
  await page.locator('input[name="type"][value="Prospect"]').check();
  await page.locator('#s1 [data-go="2"]').click();
  await shot(page, 'import-step2-mockup');
  await page.locator('#s2 [data-go="3"]').click();
  await shot(page, 'import-step3-mockup');
  await page.locator('#s3 [data-go="4"]').click();
  await shot(page, 'import-step4-mockup');
  await page.locator('#vManager').click();
  await shot(page, 'data-manager-mockup');
  await shot(page.locator('section[aria-label="Batch IMPORT-2026-11-22"]'), 'batch-detail-mockup');
  await browser.close();
});
