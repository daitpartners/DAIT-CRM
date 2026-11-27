import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from './fixtures';

test('an administrator adds a user and deactivates them', async ({ page }) => {
  const stamp = Date.now();
  const email = `test.person.${stamp}@daitpartners.com`;
  await signInAs(page, MAYA);
  await page.goto('/settings/users');
  await page.getByRole('button', { name: 'Add user' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Name').fill('Test Person');
  await modal.getByLabel('Email').fill(email);
  await modal.getByLabel('Role').selectOption({ label: 'Manager' });
  await modal.getByRole('button', { name: 'Add user' }).click();

  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Test Person');
  await expect(row).toContainText('Manager');

  await row.getByRole('button', { name: 'Deactivate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
  await expect(row).toContainText('Inactive');
});

test('a sales representative cannot open user administration', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/settings/users');
  await expect(page.getByText('You do not have access')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0);
});

test('changing the language to Spanish translates the interface', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings');
  await page.getByLabel('Language').selectOption('es');
  // The Preferences card's Save (the Email signature card has its own).
  await page.getByRole('region', { name: 'Preferences' }).getByRole('button', { name: 'Save' }).click();
  const nav = page.getByRole('navigation', { name: /navegación|Main navigation/i });
  await expect(nav.getByRole('link', { name: 'Configuración' })).toBeVisible();

  // Restore English so the preference does not leak into other specs.
  await page.getByLabel('Idioma').selectOption('en');
  await page.getByRole('region', { name: 'Preferencias' }).getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
});

/** Web-mail release 3: the Email signature card under Preferences saves, sanitised, with Add automatically. */
test('the Email signature card saves the signature and Add automatically', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Email signature' });
  await expect(card).toContainText('Added to new emails and replies you write in the CRM.');
  const body = card.frameLocator('iframe#signature-editor').locator('body');
  await body.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Arjun Mehta · DAIT Partners');
  const auto = card.getByRole('checkbox', { name: 'Add automatically' });
  await expect(auto).toBeChecked();
  await auto.uncheck();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Signature saved' })).toBeVisible();
  const saved = (await (await page.request.get('/api/me/signature')).json()) as { html: string | null; auto: boolean };
  expect(saved.html).toContain('Arjun Mehta · DAIT Partners');
  expect(saved.auto).toBe(false);
  // Read back after a reload.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Email signature' }).frameLocator('iframe#signature-editor').locator('body')).toContainText('Arjun Mehta · DAIT Partners');
  await expect(page.getByRole('region', { name: 'Email signature' }).getByRole('checkbox', { name: 'Add automatically' })).not.toBeChecked();
  // Left as it was for other specs (no signature).
  expect((await page.request.put('/api/me/signature', { data: { html: null, auto: true } })).status()).toBe(200);
});

test('an administrator adds a lookup value', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings/lookups');
  const form = page.getByRole('form', { name: 'Add value' });
  await form.getByLabel('Value', { exact: false }).first().fill('Pilot');
  await form.getByLabel('Label (English)').fill('Pilot');
  await form.getByRole('button', { name: 'Add value' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Pilot' })).toBeVisible();
});
