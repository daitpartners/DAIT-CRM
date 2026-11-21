import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

test('the contacts page searches across companies', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('okafor');
  await expect(page).toHaveURL(/q=okafor/);
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Sarah Okafor');
  const company = rows.first().getByRole('link', { name: 'Meridian Textiles' });
  await expect(company).toBeVisible();

  await company.click();
  await expect(page.getByRole('heading', { name: 'Meridian Textiles', level: 1 })).toBeVisible();
});

test('a contact can be created from the contacts page', async ({ page }) => {
  const stamp = Date.now();
  await signInAs(page, MAYA);
  await page.goto('/contacts');

  await page.getByRole('button', { name: 'Add contact' }).click();
  const modal = page.getByRole('dialog', { name: 'Add contact' });
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal.getByText('Choose a company')).toBeVisible();
  // The form moves focus to the first invalid field (deferred); wait for it before typing elsewhere.
  await expect(modal.getByLabel('First name')).toBeFocused();
  const company = modal.getByRole('combobox', { name: 'Company' });
  await company.fill('Orbit');
  await modal.getByRole('option', { name: 'Orbit Fintech' }).click();
  await expect(company).toHaveValue('Orbit Fintech');
  await expect(modal.getByText('Choose a company')).toBeHidden();
  await modal.getByLabel('First name').fill('Page');
  await modal.getByLabel('Last name').fill('Test');
  await modal.getByLabel('Business email').fill(`page.test.${stamp}@orbitfintech.de`);
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();

  await page.getByRole('searchbox', { name: 'Search contacts' }).fill(`page.test.${stamp}`);
  const row = page.getByRole('row').filter({ hasText: `page.test.${stamp}` });
  await expect(row).toContainText('Page Test');
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: 'Orbit Fintech' })).toBeVisible();
});

test('the sidebar links to the contacts page', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Contacts' }).click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
});
