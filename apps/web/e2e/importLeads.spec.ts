import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { ARJUN, MAYA, NEHA, signInAs } from './fixtures';

/*
 * Import leads end to end, with no fake routes: the real API, the real import jobs (read, research, import) and the real
 * undo. The e2e server runs no worker, so apps/api/test/e2e-import-jobs.ts runs this batch's queued jobs with the same
 * handlers (Claude off; the website reader reaches only the fixture site below, served from this process on 127.0.0.1).
 */

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const SITE_HOST = 'fixture-freight.test';

/** Runs the batch's queued import jobs until none is left. */
async function runImportJobs(batchId: number): Promise<string> {
  // Asynchronous: the fixture site is served from this process, so it must keep answering while the jobs run.
  const { stdout, stderr } = await promisify(execFile)('npx', ['tsx', 'test/e2e-import-jobs.ts', String(batchId)], {
    cwd: new URL('../../api/', import.meta.url),
    env: { ...process.env, DATABASE_URL: DB, RESEARCH_TEST_ALLOW_HOSTS: `127.0.0.1,${SITE_HOST}` },
    encoding: 'utf8',
  });
  expect(stderr).not.toContain('failed:');
  return stdout;
}

/** The fixture company's site: its contact email on the home page (a mailto link on its own domain), no phone. */
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Northgate Retail Group</title>
<meta name="description" content="Northgate Retail Group runs department stores in Ohio."></head>
<body><main><h1>Northgate Retail Group</h1><p>Department stores across Ohio.</p>
<p>Write to us: <a href="mailto:hello@${SITE_HOST}">hello@${SITE_HOST}</a></p></main></body></html>`,
  '/robots.txt': 'User-agent: *\nAllow: /\n',
};

let site: Server;
let siteUrl = '';
const stamp = Date.now().toString(36);
/** Unique names per run, so the leads search and "Already in CRM" never see an earlier run's rows. */
const NAMES = {
  alNoor: `Al Noor Logistics ${stamp} LLC`,
  northgate: `Northgate Retail ${stamp} Group`,
  kestrel: `Kestrel Engineering ${stamp}`,
  brightline: `Brightline Dental ${stamp}`,
};

test.beforeAll(async () => {
  site = createServer((req, res) => {
    const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': req.url === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://${SITE_HOST}:${(site.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => site.close(() => resolve()));
});

/** A `;`-separated exhibitor list: a Ready row, a row with only a website (no email, no phone), a total line. */
const csv = () =>
  [
    'Firma;Contact;E-mail;Country;Website',
    `${NAMES.alNoor};Omar Haddad;omar.h@alnoor-${stamp}.ae;United Arab Emirates;alnoor-${stamp}.ae`,
    `${NAMES.northgate};;;United States;${siteUrl}`,
    'Total: 2 exhibitors;;;;',
  ].join('\n');

/** Two business cards, one block each. */
const cards = () =>
  [
    NAMES.kestrel, 'Tom Baker', 'Head of Procurement', `tom.baker@kestrel-${stamp}.ca`, '+1 403 555 0101', 'Calgary, Canada',
    '',
    NAMES.brightline, 'Priya Shah', `priya@brightline-${stamp}.com`, '+1 212 555 0199', 'New York, United States',
  ].join('\n');

const batchIdOf = (page: Page) => Number(new URL(page.url()).searchParams.get('batch'));

test('import leads end to end: upload, sort, research, review, import, Leads list, Data manager, undo', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signInAs(page, NEHA);
  await page.goto('/leads');
  await page.getByRole('link', { name: 'Import leads' }).click();
  await expect(page).toHaveURL(/\/leads\/import$/);

  // Step 1: English + Prospects, then the spreadsheet and the business cards.
  await page.getByText('English leads').click();
  await page.getByText('Prospects', { exact: true }).click();
  await page.setInputFiles('#imp-files', [
    { name: 'Expo.csv', mimeType: 'text/csv', buffer: Buffer.from(csv()) },
    { name: 'Cards.txt', mimeType: 'text/plain', buffer: Buffer.from(cards()) },
  ]);
  await expect(page.locator('.conn-row')).toHaveCount(2);
  await expect(page).toHaveURL(/batch=\d+&step=1/);
  const batchId = batchIdOf(page);
  expect(await runImportJobs(batchId)).toMatch(/e2e: 2 import job\(s\) run/);
  await expect(page.locator('.conn-row .badge')).toHaveText(['Read', 'Read'], { timeout: 15_000 });
  const batch = (await (await page.request.get(`/api/imports/batches/${batchId}`)).json()) as { number: string };
  expect(batch.number).toMatch(/^IMPORT-\d{4}-\d{2}-\d{2}(-\d+)?$/);

  // Step 2: the Firma question → Company name; the tiles count what was read.
  await page.getByRole('button', { name: 'Sort the data →' }).click();
  await expect(page).toHaveURL(/step=2/);
  await expect(page.locator('.note.warn')).toContainText('"Firma"');
  await expect(page.locator('.note.warn')).toContainText('is this the Company name?');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.note.ok')).toHaveText('Column "Firma" in Expo.csv is now the Company name.');
  const tiles = page.locator('.tiles.t5 .tile');
  await expect(tiles).toHaveCount(5);
  await expect(tiles.nth(0)).toContainText('5'); // rows
  await expect(tiles.nth(0)).toContainText('2 files');
  await expect(tiles.nth(1)).toContainText('3'); // ready
  await expect(tiles.nth(2)).toContainText('1'); // missing details
  await expect(tiles.nth(4)).toContainText('1'); // not a lead (the total line)
  await expect(page.getByRole('row').filter({ hasText: NAMES.northgate })).toContainText('Missing details');
  await expect(page.getByRole('row').filter({ hasText: NAMES.kestrel })).toContainText('Ready');

  // Step 3: research the row with only a website; the fixture site gives its email (AI, with the source).
  await page.getByRole('button', { name: 'Research missing details →' }).click();
  await expect(page).toHaveURL(/step=3/);
  await expect(page.getByText('Claude Code is off: only the website reader runs.')).toBeVisible();
  // One job researches the row; the one it queues finds nothing left and finishes research.
  expect(await runImportJobs(batchId)).toMatch(/e2e: [12] import job\(s\) run/);
  await expect(page.locator('.sec-title-row .badge')).toHaveText('Done', { timeout: 15_000 });
  const researched = page.getByRole('region', { name: 'Research results' }).getByRole('row').filter({ hasText: NAMES.northgate });
  await expect(researched).toContainText(`hello@${SITE_HOST}`);
  await expect(researched.locator('.tag-ai')).toHaveText('AI');
  await expect(researched.locator('.cell-sub').first()).toContainText(SITE_HOST);

  // Step 4: nothing ticked; the row whose only email came from research needs a choice; leave it out.
  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page).toHaveURL(/step=4/);
  await expect(page.getByRole('checkbox', { name: 'Accept research values with confidence 80% or higher' })).not.toBeChecked();
  await expect(page.getByText('1 row has no email or phone after research.', { exact: false })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Import them' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Leave them out' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Import 3 prospects' })).toBeDisabled();
  await page.getByRole('radio', { name: 'Leave them out' }).check();
  await expect(page.getByText(`Source on each lead: Import · ${batch.number}`, { exact: false })).toBeVisible();
  const fix = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download rows to fix (Excel)' }).click();
  const fixFile = await fix;
  expect(fixFile.suggestedFilename()).toBe(`${batch.number}-rows-to-fix.xlsx`);
  expect((await readFile((await fixFile.path())!)).subarray(0, 2).toString()).toBe('PK'); // an xlsx (zip) workbook
  await page.getByRole('button', { name: 'Import 3 prospects' }).click();
  await expect(page).toHaveURL(new RegExp(`/leads/import/manager\\?batch=${batchId}$`));
  expect(await runImportJobs(batchId)).toMatch(/e2e: 1 import job\(s\) run/);

  // Data manager: the batch is Imported; the tabs show what each row became.
  const detail = page.getByRole('region', { name: `Batch ${batch.number}` });
  await expect(detail.getByRole('tab', { name: /^Imported/ })).toHaveText('Imported 3', { timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Import batches' }).getByRole('row').filter({ hasText: batch.number })).toContainText('Imported');
  await expect(detail.getByRole('button', { name: 'Undo this import…' })).toHaveCount(0); // a Manager has no Undo

  // The API shapes the batch detail relies on.
  const imported = (await (await page.request.get(`/api/imports/batches/${batchId}/rows?filter=imported&page=1&pageSize=100`)).json()) as {
    items: { lead: { id: number; number: string } | null; company: { created: boolean } | null; outcomeCode: string | null; error: string | null; origin: { word: string; kind: string; n: number } }[];
    included: number;
  };
  expect(imported.items).toHaveLength(3);
  for (const r of imported.items) {
    expect(r.lead?.number).toMatch(/^LD-\d+$/);
    expect(r.company?.created).toBe(true);
    expect(r.error ?? null).toBeNull();
    expect(['Expo', 'Cards']).toContain(r.origin.word);
  }
  expect(typeof imported.included).toBe('number');
  const skipped = (await (await page.request.get(`/api/imports/batches/${batchId}/rows?filter=skipped&page=1&pageSize=100`)).json()) as {
    items: { fields: { companyName?: string }; outcomeCode: string | null; lead: unknown }[];
  };
  const leftOut = skipped.items.find((r) => r.fields.companyName === NAMES.northgate);
  expect(leftOut?.outcomeCode).toBe('no_contact_left_out');
  expect(leftOut?.lead ?? null).toBeNull();

  // Open leads in Leads list: exactly the imported leads; a lead page shows its import source.
  await detail.getByRole('link', { name: 'Open leads in Leads list' }).click();
  await expect(page).toHaveURL(new RegExp(`/leads\\?q=${batch.number}`));
  const leadRows = page.locator('tbody tr');
  await expect(leadRows).toHaveCount(3);
  for (const name of [NAMES.alNoor, NAMES.kestrel, NAMES.brightline]) await expect(leadRows.filter({ hasText: name })).toHaveCount(1);
  await expect(leadRows.filter({ hasText: NAMES.northgate })).toHaveCount(0);
  const leadId = imported.items[0]!.lead!.id;
  await page.goto(`/leads/${leadId}`);
  await expect(page.getByText(`Import · ${batch.number}`)).toBeVisible();

  // An Administrator undoes the batch: the preview first, then the leads are gone and the batch is Undone.
  const admin = await (await browser.newContext()).newPage();
  await signInAs(admin, MAYA);
  await admin.goto(`/leads/import/manager?batch=${batchId}`);
  const adminDetail = admin.getByRole('region', { name: `Batch ${batch.number}` });
  await adminDetail.getByRole('button', { name: 'Undo this import…' }).click();
  const dialog = admin.getByRole('dialog', { name: `Undo ${batch.number}?` });
  await expect(dialog.getByText('Will be removed: 3 leads, 3 contacts, 3 companies.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Undo import' }).click();
  await expect(admin.getByText('Import undone')).toBeVisible();
  await expect(adminDetail.getByText(/Undone .* by Maya Pillai\./)).toBeVisible();
  await expect(admin.getByRole('region', { name: 'Import batches' }).getByRole('row').filter({ hasText: batch.number })).toContainText('Undone');
  const after = (await (await admin.request.get(`/api/leads?q=${batch.number}`)).json()) as { total: number };
  expect(after.total).toBe(0);
  await admin.goto(`/leads?q=${batch.number}`);
  for (const name of [NAMES.alNoor, NAMES.kestrel, NAMES.brightline]) await expect(admin.getByRole('row').filter({ hasText: name })).toHaveCount(0);
  await admin.context().close();
});

test('import leads end to end: a Sales Representative is refused the page', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/leads/import');
  await expect(page.getByText('You do not have access')).toBeVisible();
  expect((await page.request.get('/api/imports/batches')).status()).toBe(403);
});
