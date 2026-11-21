import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

/** Prototype views-companies.js list, in page order. */
const TILES = ['Total companies', 'Verified profiles', 'AI research queue', 'Possible duplicates'];
const TABS = ['All companies', 'Clients', 'With open leads', 'Needs verification', 'Duplicate review'];
const COLUMNS = ['Company name', 'Website', 'Industry', 'Country', 'City', 'Company size', 'Contacts', 'Leads', 'Verification', 'Status'];

test('companies list: prototype tiles, tabs with counts and columns', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/companies');
  await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toHaveText('Master database of every organisation. A company is not a lead.');
  await expect(page.getByRole('button', { name: 'New company' })).toBeVisible();

  const tileLabels = await page.locator('.tiles .tile .l').allTextContents();
  expect(tileLabels).toEqual(TILES);
  // "Total companies" equals the All companies count and the list total.
  const total = (await page.locator('.tiles .tile').first().locator('.v').textContent())?.trim();
  await expect(page.getByRole('tab', { name: /All companies/ })).toContainText(`All companies ${total}`);
  await expect(page.locator('.tiles .tile').first().locator('.m')).toContainText(/\d+ active · \d+ inactive · \d+ closed/);
  // AI research is release 4: the queue tile shows no figure until then.
  const ai = page.locator('.tiles .tile').nth(2);
  await expect(ai.locator('.v')).toHaveText('—');
  await expect(ai.locator('.m')).toHaveText('Available in release 4');

  const tabs = await page.getByRole('tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s*\d+$/, '').trim()));
  expect(tabs).toEqual(TABS);

  const heads = await page.locator('thead th').evaluateAll((els) =>
    els.map((el) => (el.textContent ?? '').replace(/[↑↓\s]+/g, ' ').trim()).filter((x) => x !== ''),
  );
  expect(heads).toEqual(COLUMNS);
  const northwind = page.getByRole('row').filter({ hasText: 'Northwind Logistics' });
  await expect(northwind).toContainText('northwindlogistics.in');
  await expect(northwind.locator('.logo')).toHaveText('NL');

  // Tabs filter the list and live in the address bar.
  await page.getByRole('tab', { name: /Clients/ }).click();
  await expect(page).toHaveURL(/tab=clients/);
  const clients = Number((await page.getByRole('tab', { name: /Clients/ }).locator('.n').textContent())?.trim());
  await expect(page.locator('tbody tr')).toHaveCount(clients);
  await page.getByRole('tab', { name: /Duplicate review/ }).click();
  await expect(page.getByText(/not merged automatically; an administrator decides/)).toBeVisible();

  await page.goto('/companies');
  await captureParity(page, 'companies');
});
