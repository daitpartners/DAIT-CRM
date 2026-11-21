import { expect, test, type Page } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

async function openNorthwind(page: Page) {
  await signInAs(page, MAYA);
  await page.goto('/companies');
  await page.getByRole('link', { name: 'Northwind Logistics' }).click();
  await expect(page.getByRole('heading', { name: 'Northwind Logistics', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .crumb')).toHaveText('Companies / CO-0318');
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

  await page.getByRole('tabpanel').getByRole('button', { name: 'Add contact' }).click();
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
  await expect(page.locator('.loc-card')).toHaveCount(2);

  await page.getByRole('button', { name: 'Add location' }).click();
  const modal = page.getByRole('dialog', { name: 'Add location' });
  await modal.getByLabel('Name').fill('Test depot');
  await modal.getByLabel('Location type').selectOption('Warehouse');
  const country = modal.getByRole('combobox', { name: 'Country' });
  await country.fill('India');
  await country.press('Enter');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();

  const row = page.locator('.loc-card').filter({ hasText: 'Test depot' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Warehouse');
  await expect(row).toContainText('India');
  await expect(page.getByRole('tab', { name: /Locations/ })).toContainText('3');

  await row.getByRole('button', { name: 'Delete Test depot' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete location?' });
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toBeHidden();
  await expect(page.locator('.loc-card')).toHaveCount(2);
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
  const companyUrl = page.url();
  await page.getByRole('tabpanel').getByRole('button', { name: 'New lead' }).click();
  await expect(page).toHaveURL(/\/leads\/new\?company=\d+$/);
  const form = page.getByRole('form', { name: 'Create lead or prospect' });
  await expect(form.getByRole('combobox', { name: 'Company (existing record)' })).toHaveValue(/^CO-0318 · Northwind Logistics/);
  await expect(form.getByLabel('Company name')).toHaveValue('Northwind Logistics');
  await form.getByRole('link', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/leads$/);
  await page.goto(companyUrl);
  await page.getByRole('tab', { name: 'Leads & Prospects' }).click();

  await row.getByRole('link', { name: 'LD-1001' }).click();
  await expect(page).toHaveURL(/\/leads\/\d+$/);
  await expect(page.getByRole('heading', { name: 'LD-1001', level: 1 })).toBeVisible();
});

test('overview edit opens the company form at the chosen section', async ({ page }) => {
  await openNorthwind(page);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Edit Size & financial' }).click();
  const modal = page.getByRole('dialog', { name: 'Edit company profile' });
  await expect(modal.getByLabel('Employee count')).toBeFocused();
  await modal.getByLabel('Employee count').fill('850');
  await modal.getByLabel('Facebook').fill('facebook.com/northwind-test');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByRole('region', { name: 'Size & financial' })).toContainText('850');
  const facebook = page.getByRole('region', { name: 'Digital presence' }).getByRole('link', { name: /facebook\.com\/northwind-test/ });
  await expect(facebook).toHaveAttribute('href', 'https://facebook.com/northwind-test');
});

test('deactivate a contact', async ({ page }) => {
  const stamp = Date.now();
  await openNorthwind(page);
  await page.getByRole('tab', { name: /Contacts/ }).click();

  await page.getByRole('tabpanel').getByRole('button', { name: 'Add contact' }).click();
  const modal = page.getByRole('dialog', { name: 'Add contact' });
  await modal.getByLabel('First name').fill('Gone');
  await modal.getByLabel('Last name').fill(`Away${stamp}`);
  await modal.getByLabel('Business email').fill(`gone.${stamp}@northwindlogistics.in`);
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: `Gone Away${stamp}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Deactivate Gone Away${stamp}` }).click();
  const confirm = page.getByRole('dialog', { name: 'Deactivate contact?' });
  await confirm.getByRole('button', { name: 'Deactivate' }).click();
  await expect(confirm).toBeHidden();
  await expect(row).toBeHidden();

  // Listed again, with a grey badge, under "Show inactive"; reactivating brings it back for good.
  await page.getByLabel('Show inactive').check();
  await expect(row).toBeVisible();
  await expect(row.getByText('Inactive', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: `Make Gone Away${stamp} primary` })).toHaveCount(0);
  await row.getByRole('button', { name: `Reactivate Gone Away${stamp}` }).click();
  await page.getByRole('dialog', { name: 'Reactivate contact?' }).getByRole('button', { name: 'Reactivate' }).click();
  await expect(row.getByText('Inactive', { exact: true })).toHaveCount(0);
  await page.getByLabel('Show inactive').uncheck();
  await expect(row).toBeVisible();
});
