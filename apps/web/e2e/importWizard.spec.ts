import { expect, test, type Page, type Route } from '@playwright/test';
import { ARJUN, NEHA, signInAs } from './fixtures';

/*
 * The Import leads wizard in the browser, steps 1 to 4 through to Import, against a fake import API (Playwright routes):
 * sign-in, the Leads page and the shell are real; every /api/imports/** answer is the fake's, so no worker or Claude is
 * needed. The real import, research and undo jobs run end to end in importLeads.spec.ts (Task 10).
 */

type Sent = { method: string; path: string; body: unknown; contentType: string | undefined };

/** A fake of the import API for one batch, keeping its state as the wizard moves on. */
function fakeImports(page: Page) {
  const sent: Sent[] = [];
  let status = 'Uploading';
  let questionOpen = true;
  let researched = false;
  const files: { id: number; name: string; ext: string; size: number; status: string; meta: unknown; error: null }[] = [];
  const row = (id: number, fields: Record<string, string>, rowStatus: string, extra: Record<string, unknown> = {}) => ({
    id, fields, status: rowStatus, include: rowStatus !== 'Already in CRM' && rowStatus !== 'Not a lead', problems: [], matched: null,
    from: `Expo csv · row ${id - 100}`, fileName: 'Expo.csv', origin: { word: 'Expo', ext: 'csv', kind: 'row', n: id - 100 }, ...extra,
  });
  const rows = () => [
    row(101, { companyName: 'Al Noor Logistics LLC', website: 'alnoorlogistics.ae', country: 'United Arab Emirates', city: 'Dubai', contactName: 'Omar Haddad', email: 'omar.h@alnoorlogistics.ae' }, 'Ready'),
    row(102, { companyName: 'Northgate Retail Group', website: 'northgateretail.com' }, 'Missing details'),
    row(103, { companyName: 'Meridian Textiles Ltd', country: 'United Kingdom' }, 'Already in CRM', { matched: { id: 9, number: 'CO-1042' } }),
  ];
  const json = (route: Route, data: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(data) });

  const handler = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const raw = req.postDataBuffer();
    let body: unknown = null;
    if (raw && req.headers()['content-type']?.includes('json')) body = JSON.parse(raw.toString());
    if (method !== 'GET') sent.push({ method, path, body, contentType: req.headers()['content-type'] });

    if (path === '/api/imports/options') {
      return json(route, {
        languages: [
          { value: 'en', rules: [{ name: 'English market (US and Canada)', people: ['Deepak', 'Lakshita'] }] },
          { value: 'es', rules: [{ name: 'Spanish market (Español)', people: ['Carlos', 'Sebastian'] }] },
        ],
        claude: { on: true, runsThisMonth: 146, cap: 300, webSearch: true },
        limits: { maxFiles: 10, maxBytes: 20971520, maxRows: 5000 },
      });
    }
    if (path === '/api/imports/batches' && method === 'GET') return json(route, { items: [], total: 4, count: 4, tiles: {} });
    if (path === '/api/imports/batches' && method === 'POST') return json(route, { id: 41, number: 'IMPORT-2026-11-24', status }, 201);
    if (path === '/api/imports/batches/41' && method === 'GET') {
      return json(route, { id: 41, number: 'IMPORT-2026-11-24', status, language: 'en', leadType: 'Prospect', createdAt: new Date().toISOString(), rowCount: 3 });
    }
    if (path === '/api/imports/batches/41/files' && method === 'POST') {
      const name = url.searchParams.get('name')!;
      files.push({ id: 5, name, ext: 'csv', size: raw?.length ?? 0, status: 'Read', meta: { rows: 3 }, error: null });
      return json(route, { id: 5, name, ext: 'csv', size: raw?.length ?? 0, status: 'Reading' }, 201);
    }
    if (path === '/api/imports/batches/41/files') return json(route, { items: files });
    if (path === '/api/imports/batches/41/sort') {
      status = 'Sorting';
      return json(route, { id: 41, number: 'IMPORT-2026-11-24', status, language: 'en', leadType: 'Prospect' });
    }
    if (path === '/api/imports/batches/41/rows') {
      return json(route, {
        items: rows(), total: 3, included: rows().filter((r) => r.include).length, tiles: { rows: 3, files: 1, ready: 1, missing: 1, already: 1, notLead: 0 },
        question: questionOpen
          ? { sheet: 'Expo.csv', col: 0, header: 'Firma', guess: 'companyName', samples: ['Al Noor Logistics LLC', 'Northgate Retail Group'], fileId: 5, fileName: 'Expo.csv' }
          : null,
      });
    }
    if (path === '/api/imports/files/5/columns') {
      questionOpen = false;
      return json(route, { done: 'companyName' });
    }
    if (path.startsWith('/api/imports/rows/')) return json(route, rows()[1]);
    if (path === '/api/imports/batches/41/research' && method === 'POST') {
      status = 'Researching';
      return json(route, { total: 1 });
    }
    if (path === '/api/imports/batches/41/research') {
      // The first poll shows the row being researched; the next one shows it done.
      const done = researched;
      researched = true;
      if (done) status = 'Waiting for review';
      return json(route, {
        status, paused: false, stopReason: null, total: 1, done: done ? 1 : 0, etaMinutes: done ? 0 : 1,
        tiles: { everything: done ? 1 : 0, some: 0, nothing: 0 }, claude: { on: true, runsThisMonth: 147, cap: 300 }, engine: { claude: 'sonnet' },
        items: [
          row(102, { companyName: 'Northgate Retail Group', website: 'northgateretail.com' }, 'Missing details', done
            ? { researchStatus: 'everything', research: { country: { value: 'United States', sourceUrl: 'https://northgateretail.com/about', sourceLabel: 'northgateretail.com/about', confidence: 90 } } }
            : { researchStatus: 'running' }),
        ],
        activity: [{ at: new Date().toISOString(), code: 'started', params: { n: 1, engine: { claude: 'sonnet' } } }],
      });
    }
    if (path === '/api/imports/batches/41/review') {
      // As the server: the row with no email or phone is no longer counted once it is left out.
      const leave = url.searchParams.get('noContactRows') === 'leave';
      return json(route, {
        willImport: leave ? 1 : 2, newCompanies: leave ? 1 : 2, existingCompanies: 0, skipped: { total: 1, alreadyInCrm: 1, notLead: 0, unticked: 0, other: 0 },
        noContactRows: 1, researchOnlyCountry: 0, unknownCountries: [],
        leadType: 'Prospect', language: 'en', source: 'Import · IMPORT-2026-11-24',
        allocation: [{ name: 'English market (US and Canada)', people: ['Deepak', 'Lakshita'] }],
      });
    }
    if (path === '/api/imports/batches/41/import') {
      status = 'Importing';
      return json(route, { id: 41, status: 'Importing' }, 202);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) });
  };
  return { sent, install: () => page.route('**/api/imports/**', handler) };
}

test('import wizard: no defaults on step 1, upload, sort, research, review and Import (fake import API)', async ({ page }) => {
  const fake = fakeImports(page);
  await fake.install();
  await signInAs(page, NEHA);
  await page.goto('/leads');
  await page.getByRole('link', { name: 'Import leads' }).click();
  await expect(page).toHaveURL(/\/leads\/import$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Import leads' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Data manager/ })).toContainText('4');

  // Step 1: nothing chosen; continuing names both choices.
  for (const r of await page.getByRole('radio').all()) await expect(r).not.toBeChecked();
  await page.getByRole('button', { name: 'Sort the data →' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Choose the outreach language (English or Spanish) and whether to import them as Prospects or Leads before continuing.',
  );
  await expect(page.locator('.err-msg')).toHaveText(['Choose English or Spanish.', 'Choose Prospects or Leads.']);
  await page.getByText('English leads').click();
  await page.getByText('Prospects', { exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.setInputFiles('#imp-files', { name: 'Expo.csv', mimeType: 'text/csv', buffer: Buffer.from('Firma;Contact\nAl Noor Logistics LLC;Omar\n') });
  await expect(page.locator('.conn-row')).toContainText('Expo.csv');
  await expect(page.locator('.conn-row .badge')).toHaveText('Read');
  await expect(page).toHaveURL(/batch=41&step=1/);
  const upload = fake.sent.find((s) => s.path === '/api/imports/batches/41/files')!;
  expect(upload.contentType).toBe('application/octet-stream');
  expect(fake.sent.find((s) => s.path === '/api/imports/batches')!.body).toEqual({ language: 'en', leadType: 'Prospect' });

  // Step 2: the Firma question, a cell edit.
  await page.getByRole('button', { name: 'Sort the data →' }).click();
  await expect(page).toHaveURL(/step=2/);
  await expect(page.locator('.tiles.t5 .tile')).toHaveCount(5);
  await expect(page.locator('.note.warn')).toContainText('is this the Company name?');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.note.ok')).toHaveText('Column "Firma" in Expo.csv is now the Company name.');
  await expect(page.getByText('Already in CRM · CO-1042')).toHaveClass(/b-info/);
  await expect(page.getByText('Expo csv · row 2')).toBeVisible();
  // Two of the three rows are ticked: the header tick is mixed.
  await expect.poll(() => page.getByRole('checkbox', { name: 'Include all 3 rows in this view' }).evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
  const city = page.locator('tbody tr').nth(1).locator('td').nth(4);
  await city.click();
  await page.keyboard.type('Columbus');
  await page.keyboard.press('Enter');
  await expect.poll(() => fake.sent.find((s) => s.path === '/api/imports/rows/102')?.body).toEqual({ field: 'city', value: 'Columbus' });

  // Step 3: research runs, then is done.
  await page.getByRole('button', { name: 'Research missing details →' }).click();
  await expect(page).toHaveURL(/step=3/);
  await expect(page.locator('.sec-title-row .badge')).toHaveText(/Running · one company at a time|Done/);
  await expect(page.locator('.sec-title-row .badge')).toHaveText('Done', { timeout: 15_000 });
  await expect(page.getByText('northgateretail.com/about · 90%')).toBeVisible();

  // Step 4: unticked boxes, no default choice, Import refused until chosen.
  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page).toHaveURL(/step=4/);
  await expect(page.getByRole('checkbox', { name: 'Accept research values with confidence 80% or higher' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Send each assignee one notification for the batch' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Import them' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Leave them out' })).not.toBeChecked();
  // Import stays off until the choice is made; the undecided row is not counted.
  await expect(page.getByRole('button', { name: 'Import 1 prospect' })).toBeDisabled();
  await expect(page.getByText('Choose Import them or Leave them out to continue.')).toBeVisible();
  await page.getByRole('radio', { name: 'Import them' }).check();
  await expect(page.getByRole('button', { name: 'Import 2 prospects' })).toBeEnabled();
  await page.getByRole('radio', { name: 'Leave them out' }).check();
  await page.getByRole('button', { name: 'Import 1 prospect' }).click();
  await expect(page).toHaveURL(/\/leads\/import\/manager\?batch=41$/);
  expect(fake.sent.find((s) => s.path === '/api/imports/batches/41/import')!.body).toEqual({ acceptHigh: false, noContactRows: 'leave', notify: false });
});

test('import leads: a Sales Representative has no button and is refused the page', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import leads' })).toHaveCount(0);
  await page.goto('/leads/import');
  await expect(page.getByText('You do not have access')).toBeVisible();
});
