import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from './fixtures';

test('an administrator adds a company and sees a duplicate warning', async ({ page }) => {
  const stamp = Date.now();
  await signInAs(page, MAYA);
  await page.goto('/companies');
  await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Northwind Logistics' })).toBeVisible();

  await page.getByRole('button', { name: 'New company' }).click();
  const modal = page.getByRole('dialog', { name: 'New company' });
  await modal.getByLabel('Company name').fill('Northwind Logistics');
  const country = modal.getByRole('combobox', { name: 'Country' });
  await country.fill('India');
  await country.press('Enter');

  const review = modal.getByRole('status').filter({ hasText: 'Possible duplicates' });
  await expect(review).toBeVisible();
  await expect(review.getByRole('link', { name: /CO-0318/ })).toBeVisible();
  const save = modal.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();

  await modal.getByLabel('Website').fill('https://northwindlogistics.in');
  const block = modal.getByRole('alert').filter({ hasText: 'This looks like CO-0318 Northwind Logistics' });
  await expect(block).toBeVisible();
  await expect(save).toBeDisabled();

  await modal.getByLabel('Website').fill(`https://newco-${stamp}.example`);
  await modal.getByLabel('Company name').fill(`Newco ${stamp}`);
  await expect(block).toBeHidden();
  await expect(save).toBeEnabled();
  await save.click();

  await expect(modal).toBeHidden();
  const row = page.getByRole('row').filter({ hasText: `Newco ${stamp}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/CO-\d{4,}/);
  await expect(row).toContainText('India');
});

test('a sales representative sees only their own companies', async ({ page }) => {
  const stamp = Date.now();
  await signInAs(page, ARJUN);
  await page.goto('/companies');
  // The seed assigns Arjun a lead on Northwind Logistics: that company is visible to him, no other.
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Northwind Logistics');

  await page.getByRole('button', { name: 'New company' }).click();
  const modal = page.getByRole('dialog', { name: 'New company' });
  await modal.getByLabel('Company name').fill(`Arjun Prospect ${stamp}`);
  const country = modal.getByRole('combobox', { name: 'Country' });
  await country.fill('Germany');
  await country.press('Enter');
  await modal.getByRole('button', { name: 'Save' }).click();

  await expect(modal).toBeHidden();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('row').filter({ hasText: `Arjun Prospect ${stamp}` })).toBeVisible();
  await expect(page.getByText('Sunrise Pharma')).toHaveCount(0);
});

test('filters live in the address bar and survive a reload', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/companies');
  await page.getByLabel('Status').selectOption('Inactive');
  await expect(page).toHaveURL(/status=Inactive/);
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('Inactive');
  await page.reload();
  await expect(page.getByLabel('Status')).toHaveValue('Inactive');
  await expect(page.getByRole('row').filter({ hasText: 'Northwind Logistics' })).toHaveCount(0);
});

test('a page number past the end shows the last page', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/companies?page=99');
  await expect(page.getByRole('row').filter({ hasText: 'Northwind Logistics' })).toBeVisible();
  await expect(page.getByText(/Showing 1–\d+ of \d+/)).toBeVisible();
  await expect(page).not.toHaveURL(/page=99/);
});
