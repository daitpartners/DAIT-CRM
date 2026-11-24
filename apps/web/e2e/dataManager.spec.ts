import { expect, test, type Page, type Route } from '@playwright/test';
import { MAYA, NEHA, signInAs } from './fixtures';

/*
 * The Data manager in the browser against a fake import API (Playwright routes): sign-in, the shell and the Leads page
 * are real; every /api/imports/** answer is the fake's. The real import and undo jobs run end to end in
 * importLeads.spec.ts (Task 10).
 */

type Sent = { method: string; path: string };

const batchRow = (over: Record<string, unknown>) => ({
  id: 8, number: 'IMPORT-2026-11-22', createdAt: '2026-11-22T11:05:00Z', by: 'Deepak Singh', language: 'en',
  files: { first: 'leads-master.csv', more: 0 }, rowCount: 488, importedCount: 231, newCompanyCount: 198, skippedCount: 257,
  research: 'done', status: 'Imported', undoneAt: null, ...over,
});

function fakeImports(page: Page) {
  const sent: Sent[] = [];
  let undone = false;
  const json = (route: Route, data: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(data) });
  const attachment = (route: Route, name: string, type: string, body: string) =>
    route.fulfill({ status: 200, headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"` }, body });
  const preview = {
    remove: { leads: [{ id: 9101, number: 'LD-9101' }], contacts: 1, companies: 1 },
    keep: [{ kind: 'lead', id: 9102, label: 'LD-9102 · Meridian Textiles Ltd', reason: 'activity' }],
  };
  const handler = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    sent.push({ method, path: `${path}${url.search}` });
    if (path === '/api/imports/batches' && method === 'GET') {
      const items = [
        batchRow({
          id: 9, number: 'IMPORT-2026-11-24', createdAt: '2026-11-24T14:20:00Z', files: { first: 'Expo-Dubai-visitors.xlsx', more: 2 }, rowCount: 468,
          importedCount: null, newCompanyCount: null, skippedCount: null, research: { done: 46, total: 121 }, status: 'Researching',
        }),
        batchRow(undone ? { status: 'Undone', undoneAt: new Date().toISOString() } : {}),
        batchRow({ id: 6, number: 'IMPORT-2026-11-18', by: 'Carlos Ruiz', language: 'es', status: 'Undone', undoneAt: '2026-11-19T10:00:00Z' }),
      ].filter((b) => !url.searchParams.get('status') || b.status === url.searchParams.get('status'));
      return json(route, {
        items, total: items.length, count: 3,
        tiles: { importedThisMonth: 643, importedBatchesThisMonth: 4, waitingForReview: 1, stillResearching: 17, duplicatesSkippedThisMonth: 52 },
      });
    }
    if (path === '/api/imports/batches/8' && method === 'GET') {
      return json(route, {
        id: 8, number: 'IMPORT-2026-11-22', status: undone ? 'Undone' : 'Imported', language: 'en', leadType: 'Prospect', createdAt: '2026-11-22T11:05:00Z',
        rowCount: 488, by: 'Deepak Singh', importedAt: '2026-11-22T11:30:00Z', importedBy: 'Deepak Singh',
        undoneAt: undone ? new Date().toISOString() : null, undoneBy: undone ? 'Maya Pillai' : null, undo: undone ? preview : null,
        importedCount: 231, newCompanyCount: 198, existingCompanyCount: 33, skippedCount: 257, errorCount: 1, importError: null,
        counts: { imported: 231, skipped: 257, errors: 1 },
        files: [{ id: 31, name: 'leads-master.csv', ext: 'csv', size: 81920, status: 'Read', error: null, createdAt: '2026-11-22T11:00:00Z', deletedAt: null, rows: 488 }],
        canUndo: !undone,
      });
    }
    if (path === '/api/imports/batches/8/rows') {
      const filter = url.searchParams.get('filter');
      const base = { include: true, problems: [], matched: null, from: 'leads csv · row 2', fileName: 'leads-master.csv', origin: { word: 'leads', ext: 'csv', kind: 'row', n: 2 } };
      const items =
        filter === 'imported'
          ? [{ ...base, id: 501, status: 'Ready', fields: { companyName: 'Al Noor Logistics LLC', website: 'alnoorlogistics.ae', country: 'United Arab Emirates' }, lead: { id: 9101, number: 'LD-9101' }, company: { id: 77, number: 'CO-2001', created: true } }]
          : filter === 'skipped'
            ? [{ ...base, id: 503, status: 'Already in CRM', fields: { companyName: 'Meridian Textiles Ltd' }, matched: { id: 12, number: 'CO-1042' }, outcomeCode: 'already_in_crm' }]
            : [{ ...base, id: 504, status: 'Ready', fields: { companyName: 'Gulf Freight' }, outcomeCode: 'import_error', error: 'invalid_status' }];
      return json(route, { items, total: items.length, included: 0, tiles: {}, question: null });
    }
    if (path === '/api/imports/batches/8/rows.csv') return attachment(route, 'IMPORT-2026-11-22-rows.csv', 'text/csv', 'Company\r\nAl Noor\r\n');
    if (path === '/api/imports/batches/8/rows-to-fix.xlsx') return attachment(route, 'IMPORT-2026-11-22-rows-to-fix.xlsx', 'application/octet-stream', 'xlsx');
    if (path === '/api/imports/files/31/original') return attachment(route, 'leads-master.csv', 'application/octet-stream', 'Company\nAl Noor\n');
    if (path === '/api/imports/batches/8/undo' && method === 'GET') return json(route, preview);
    if (path === '/api/imports/batches/8/undo' && method === 'POST') {
      undone = true;
      return json(route, preview);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) });
  };
  return { sent, install: () => page.route('**/api/imports/**', handler) };
}

test('Data manager: list, batch detail tabs, downloads and the undo preview (Administrator)', async ({ page }) => {
  const fake = fakeImports(page);
  await fake.install();
  await signInAs(page, MAYA);
  await page.goto('/leads/import/manager');
  await expect(page.getByRole('heading', { level: 1, name: 'Data manager' })).toBeVisible();
  await expect(page.locator('.tiles .tile')).toHaveCount(4);
  await expect(page.locator('.tiles .tile').first()).toContainText('643');
  await expect(page.locator('.tiles .tile').first()).toContainText('in 4 batches');
  const batches = page.getByRole('region', { name: 'Import batches' });
  await expect(batches.locator('tbody tr')).toHaveCount(3);
  await expect(batches.getByText('46 / 121')).toBeVisible();

  // The Status filter is sent to the API.
  await batches.getByLabel('Status').selectOption('Imported');
  await expect.poll(() => fake.sent.some((s) => s.path.includes('status=Imported'))).toBe(true);
  await expect(batches.locator('tbody tr')).toHaveCount(1);
  await batches.getByLabel('Status').selectOption('');

  // Open an imported batch: its detail, four tabs and rows.
  await batches.getByRole('button', { name: 'Open IMPORT-2026-11-22' }).click();
  await expect(page).toHaveURL(/\/leads\/import\/manager\?batch=8$/);
  const detail = page.getByRole('region', { name: 'Batch IMPORT-2026-11-22' });
  await expect(detail.getByRole('tab')).toHaveText(['Imported 231', 'Skipped 257', 'Errors 1', 'Original files']);
  await expect(detail.getByRole('link', { name: 'LD-9101' })).toHaveAttribute('href', '/leads/9101');
  await expect(detail.getByText('new', { exact: true })).toHaveClass(/cell-sub/);
  await detail.getByRole('tab', { name: /Skipped/ }).click();
  await expect(detail.getByText('Already in the CRM as CO-1042')).toBeVisible();
  await detail.getByRole('tab', { name: /Errors/ }).click();
  await expect(detail.getByText('The lead status is not available')).toBeVisible();

  // Downloads are attachments from the API.
  const csv = page.waitForEvent('download');
  await detail.getByRole('link', { name: 'Download rows (CSV)' }).click();
  expect((await csv).suggestedFilename()).toBe('IMPORT-2026-11-22-rows.csv');
  const fix = page.waitForEvent('download');
  await detail.getByRole('link', { name: 'Download rows to fix (Excel)' }).click();
  expect((await fix).suggestedFilename()).toBe('IMPORT-2026-11-22-rows-to-fix.xlsx');
  await detail.getByRole('tab', { name: 'Original files' }).click();
  const original = page.waitForEvent('download');
  await detail.getByRole('link', { name: 'Download leads-master.csv' }).click();
  expect((await original).suggestedFilename()).toBe('leads-master.csv');
  await expect(detail.getByRole('link', { name: 'Open leads in Leads list' })).toHaveAttribute('href', '/leads?q=IMPORT-2026-11-22');

  // Undo: the preview first; Escape closes it; then confirm.
  await detail.getByRole('button', { name: 'Undo this import…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Undo IMPORT-2026-11-22?' });
  await expect(dialog.getByText('Will be removed: 1 lead, 1 contact, 1 company.')).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveText(['LD-9102 · Meridian Textiles Ltd — Has activity']);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(fake.sent.some((s) => s.method === 'POST')).toBe(false);
  await detail.getByRole('button', { name: 'Undo this import…' }).click();
  await dialog.getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByText('Import undone')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(detail.getByText(/Undone .* by Maya Pillai\. Removed: 1 lead, 1 contact, 1 company\./)).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Undo this import…' })).toHaveCount(0);

  // Open leads in Leads list: the exact batch search.
  await detail.getByRole('link', { name: 'Open leads in Leads list' }).click();
  await expect(page).toHaveURL(/\/leads\?q=IMPORT-2026-11-22/);
});

test('Data manager: a Manager sees the batch but no Undo; Open on a batch not imported yet goes to the wizard', async ({ page }) => {
  const fake = fakeImports(page);
  await fake.install();
  await signInAs(page, NEHA);
  await page.goto('/leads/import/manager?batch=8');
  const detail = page.getByRole('region', { name: 'Batch IMPORT-2026-11-22' });
  await expect(detail.getByRole('tab', { name: /Imported/ })).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Download rows (CSV)' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Undo this import…' })).toHaveCount(0);
  await page.getByRole('region', { name: 'Import batches' }).getByRole('button', { name: 'Open IMPORT-2026-11-24' }).click();
  await expect(page).toHaveURL(/\/leads\/import\?batch=9$/);
});
