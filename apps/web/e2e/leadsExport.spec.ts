import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { expect, test } from '@playwright/test';
import { ARJUN, NEHA, signInAs } from './fixtures';

/*
 * Download all leads → fill a blank and change a value in Excel → upload through Import leads → the blank is filled, the
 * changed value is not applied but listed in the rows to fix. Real API and real import jobs (no fake routes); the e2e
 * server runs no worker, so apps/api/test/e2e-import-jobs.ts runs the batch's queued jobs.
 */

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';

async function runImportJobs(batchId: number): Promise<string> {
  const { stdout, stderr } = await promisify(execFile)('npx', ['tsx', 'test/e2e-import-jobs.ts', String(batchId)], {
    cwd: new URL('../../api/', import.meta.url),
    env: { ...process.env, DATABASE_URL: DB },
    encoding: 'utf8',
  });
  expect(stderr).not.toContain('failed:');
  return stdout;
}

const stamp = Date.now().toString(36);
const COMPANY = `Export Roundtrip ${stamp} Ltd`;

test('Download all leads, complete the blanks in Excel, upload them again through Import leads', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, NEHA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', {
    data: { companyName: COMPANY, country: 'India', leadSource: 'Referral', phone: '+91 22 5555 0101', assignedToId: me.id },
  });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string };

  // The Leads list searched for the lead: Download all leads gives exactly it, with its ids.
  await page.goto(`/leads?q=${encodeURIComponent(COMPANY)}`);
  await expect(page.locator('tbody tr').filter({ hasText: COMPANY })).toHaveCount(1);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download all leads' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile((await download.path())!)) as unknown as ExcelJS.Buffer);
  const ws = wb.worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  expect(header.slice(0, 3)).toEqual(['Lead ID', 'Company ID', 'Company']);
  expect(ws.rowCount).toBe(2);
  const col = (name: string) => header.indexOf(name) + 1;
  const row = ws.getRow(2);
  expect(row.getCell(col('Lead ID')).value).toBe(lead.number);
  expect(row.getCell(col('Website')).value ?? '').toBe('');

  // In Excel: the blank website filled, the phone changed.
  row.getCell(col('Website')).value = `roundtrip-${stamp}.example`;
  row.getCell(col('Phone')).value = '+91 22 5555 0999';
  const edited = Buffer.from(await wb.xlsx.writeBuffer());

  // Import leads: the row is an Update.
  await page.goto('/leads/import');
  await page.getByText('English leads').click();
  await page.locator('label.radio-card').filter({ hasText: 'Already showed interest' }).click(); // Leads
  await page.setInputFiles('#imp-files', [{ name: 'leads-edited.xlsx', mimeType: 'application/octet-stream', buffer: edited }]);
  await expect(page).toHaveURL(/batch=\d+&step=1/);
  const batchId = Number(new URL(page.url()).searchParams.get('batch'));
  expect(await runImportJobs(batchId)).toMatch(/e2e: 1 import job\(s\) run/);
  await expect(page.locator('.conn-row .badge')).toHaveText(['Read'], { timeout: 15_000 });
  await page.getByRole('button', { name: 'Sort the data →' }).click();
  await expect(page.getByRole('row').filter({ hasText: COMPANY })).toContainText('Update');
  await expect(page.getByText('1 row has a Lead ID or Company ID', { exact: false })).toBeVisible();

  // Step 4 (research is skipped: nothing is Missing details): one empty field, one value that differs.
  await page.goto(`/leads/import?batch=${batchId}&step=4`);
  await expect(page.getByText('1 row will update 1 empty field; 1 value differs (not changed — see Download rows to fix).')).toBeVisible();
  const fixBefore = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download rows to fix (Excel)' }).click();
  const fixWb = new ExcelJS.Workbook();
  await fixWb.xlsx.load((await readFile((await (await fixBefore).path())!)) as unknown as ExcelJS.Buffer);
  const fixWs = fixWb.worksheets[0]!;
  const fixHeader = (fixWs.getRow(1).values as unknown[]).slice(1).map(String);
  expect(fixWs.getRow(2).getCell(fixHeader.indexOf('What to fix') + 1).value)
    .toBe('Phone: CRM has +91 22 5555 0101, file has +91 22 5555 0999 — update on the lead page if correct');
  expect(String(fixWs.getRow(2).getCell(fixHeader.indexOf('Lead page') + 1).text)).toContain(`/leads/${lead.id}`);

  await page.getByRole('button', { name: 'Update 1 existing lead' }).click();
  await expect(page).toHaveURL(new RegExp(`/leads/import/manager\\?batch=${batchId}$`));
  expect(await runImportJobs(batchId)).toMatch(/e2e: 1 import job\(s\) run/);
  const batch = (await (await page.request.get(`/api/imports/batches/${batchId}`)).json()) as { number: string };
  const detail = page.getByRole('region', { name: `Batch ${batch.number}` });
  await expect(detail.getByRole('tab', { name: /^Updated/ })).toHaveText('Updated 1', { timeout: 15_000 });
  await expect(detail.getByText('Conflicts: 1 values differ from the CRM and were not changed', { exact: false })).toBeVisible();

  // The blank is filled; the phone is NOT overwritten.
  const after = (await (await page.request.get(`/api/leads/${lead.id}`)).json()) as { website: string | null; phone: string | null };
  expect(after.website).toBe(`https://roundtrip-${stamp}.example`);
  expect(after.phone).toBe('+91 22 5555 0101');
});

test('Download all leads: not offered to a Sales Representative, refused by the API', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download all leads' })).toHaveCount(0);
  expect((await page.request.get('/api/leads/export.xlsx')).status()).toBe(403);
});
