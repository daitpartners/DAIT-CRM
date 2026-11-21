import { expect, test, type Page } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

async function openNorthwind(page: Page) {
  await signInAs(page, MAYA);
  await page.goto('/companies');
  await page.getByRole('link', { name: 'Northwind Logistics' }).click();
  await expect(page.getByRole('heading', { name: 'Northwind Logistics', level: 1 })).toBeVisible();
  await expect(page.getByText('CO-0318 · India')).toBeVisible();
}

test('a manager adds a contact and makes them primary', async ({ page }) => {
  const stamp = Date.now();
  await openNorthwind(page);

  await page.getByRole('tab', { name: /Contacts/ }).click();
  await expect(page).toHaveURL(/#contacts$/);
  const priya = page.getByRole('row').filter({ hasText: 'Priya Raman' });
  await expect(priya).toBeVisible();
  await expect(priya.getByText('Primary', { exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Sameer Kulkarni' })).toBeVisible();

  await page.getByRole('button', { name: 'Add contact' }).click();
  const modal = page.getByRole('dialog', { name: 'Add contact' });
  await modal.getByLabel('First name').fill('Test');
  await modal.getByLabel('Last name').fill('Contact');
  await modal.getByLabel('Business email').fill(`test.${stamp}@northwindlogistics.in`);
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();

  const added = page.getByRole('row').filter({ hasText: 'Test Contact' });
  await expect(added).toBeVisible();
  await expect(added).toContainText(`test.${stamp}@northwindlogistics.in`);
  await expect(added.getByText('Primary', { exact: true })).toHaveCount(0);

  await added.getByRole('button', { name: 'Make Test Contact primary' }).click();
  const confirm = page.getByRole('dialog', { name: 'Make primary contact?' });
  await confirm.getByRole('button', { name: 'Make primary' }).click();
  await expect(confirm).toBeHidden();

  await expect(added.getByText('Primary', { exact: true })).toBeVisible();
  await expect(priya.getByText('Primary', { exact: true })).toHaveCount(0);
});

test('locations tab adds and deletes a location', async ({ page }) => {
  await openNorthwind(page);
  await page.getByRole('tab', { name: /Locations/ }).click();
  await expect(page.getByRole('tab', { name: /Locations/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('tbody tr')).toHaveCount(2);

  await page.getByRole('button', { name: 'Add location' }).click();
  const modal = page.getByRole('dialog', { name: 'Add location' });
  await modal.getByLabel('Name').fill('Test depot');
  await modal.getByLabel('Location type').selectOption('Warehouse');
  const country = modal.getByRole('combobox', { name: 'Country' });
  await country.fill('India');
  await country.press('Enter');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: 'Test depot' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Warehouse');
  await expect(row).toContainText('India');
  await expect(page.getByRole('tab', { name: /Locations/ })).toContainText('3');

  await row.getByRole('button', { name: 'Delete Test depot' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete location?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toBeHidden();
  await expect(page.locator('tbody tr')).toHaveCount(2);
});

test('later-release tabs show an empty state', async ({ page }) => {
  await openNorthwind(page);
  await page.getByRole('tab', { name: 'AI Intelligence' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Available in release 4');
  await expect(page).toHaveURL(/#ai$/);

  // The tab survives a reload through the URL hash.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'AI Intelligence' })).toHaveAttribute('aria-selected', 'true');
});

test('leads and activities tabs list the company\'s leads', async ({ page }) => {
  await openNorthwind(page);
  await page.getByRole('tab', { name: 'Leads & Prospects' }).click();
  const row = page.getByRole('tabpanel').getByRole('row').filter({ hasText: 'LD-1001' });
  await expect(row).toContainText('Arjun Mehta');
  await page.getByRole('tab', { name: 'Activities' }).click();
  await expect(page.getByRole('tabpanel').getByRole('link', { name: 'LD-1001' }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Leads & Prospects' }).click();
  await page.getByRole('tabpanel').getByRole('button', { name: 'New lead' }).click();
  const modal = page.getByRole('dialog', { name: 'New lead' });
  await expect(modal.getByRole('combobox', { name: 'Link to existing company' })).toHaveValue('Northwind Logistics');
  await expect(modal.getByLabel('Company name')).toHaveValue('Northwind Logistics');
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toBeHidden();

  await row.getByRole('link', { name: 'LD-1001' }).click();
  await expect(page).toHaveURL(/\/leads\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Northwind Logistics', level: 1 })).toBeVisible();
});

test('overview edit opens the company form at the chosen section', async ({ page }) => {
  await openNorthwind(page);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Edit Size & financial' }).click();
  const modal = page.getByRole('dialog', { name: 'Edit company' });
  await expect(modal.getByLabel('Employee count')).toBeFocused();
  await modal.getByLabel('Employee count').fill('850');
  await modal.getByLabel('Facebook').fill('facebook.com/northwind-test');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByRole('region', { name: 'Size & financial' })).toContainText('850');
  const facebook = page.getByRole('region', { name: 'Digital presence' }).getByRole('link', { name: /facebook\.com\/northwind-test/ });
  await expect(facebook).toHaveAttribute('href', 'https://facebook.com/northwind-test');
});
