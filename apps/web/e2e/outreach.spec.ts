import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

/** Outreach language (English / Español): Leads filter + column, facts, New lead, Edit lead, Email tab, allocation rules. */
test('a Spanish lead: Language column and filter, facts grid, Spanish intro in the Email tab', async ({ page }) => {
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const company = `Hispano ${Date.now()}`;
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'Spain', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; outreachLanguage: string };
  expect(lead.outreachLanguage).toBe('es');

  await page.goto('/leads');
  const heads = await page.locator('thead th').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/[↑↓\s]+/g, ' ').trim()));
  expect(heads.indexOf('Language')).toBe(heads.indexOf('Country') + 1);
  await page.getByLabel('Language', { exact: true }).selectOption({ label: 'Language: Español' });
  await expect(page).toHaveURL(/language=es/);
  const rows = page.locator('tbody tr');
  await expect(rows.filter({ hasText: company })).toContainText('Español');
  await expect(rows.filter({ hasText: 'English' })).toHaveCount(0);

  await page.goto(`/leads/${lead.id}`);
  const profile = page.getByRole('region', { name: 'Profile' });
  await expect(profile.getByText('Outreach language', { exact: true })).toBeVisible();
  await expect(profile.locator('dd').filter({ hasText: 'Español' })).toHaveCount(1);
  const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
  await expect(email.getByLabel('Subject')).toHaveValue('¿Una llamada esta semana?');
  await expect(email.getByLabel('Message')).toHaveValue(new RegExp(`^Hola ${company}:\\n\\nGracias por ponerse en contacto con DAIT Partners\\.`));

  // Edit lead details: switch to English → facts and Email intro follow.
  await page.locator('.topbar').getByRole('button', { name: 'Edit profile' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit lead details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit lead' });
  await expect(dialog.getByLabel('Outreach language')).toHaveValue('es');
  await dialog.getByLabel('Outreach language').selectOption('en');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(profile.locator('dd').filter({ hasText: 'English' })).toHaveCount(1);
  // The Email tab follows the new language.
  await expect(email.getByLabel('Subject')).toHaveValue('Intro call this week?');
});

test('New lead: Outreach language follows the country until chosen', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/leads/new');
  const form = page.getByRole('form', { name: 'Create lead or prospect' });
  const lang = form.getByLabel('Outreach language');
  await expect(lang).toHaveValue('en');
  const country = form.getByRole('combobox', { name: 'Country' });
  await country.fill('Spain');
  await country.press('Enter');
  await expect(lang).toHaveValue('es');
  // Once the user picks a language, later country changes leave it alone (even back to a Spanish-speaking one).
  await lang.selectOption('en');
  await country.fill('Italy');
  await country.press('Enter');
  await country.fill('Spain');
  await country.press('Enter');
  await expect(lang).toHaveValue('en');
});

test('allocation rules: a rule can be limited to a language', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings/allocation');
  await page.getByRole('button', { name: /New rule|Add rule/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Language')).toHaveValue('');
  expect(await dialog.getByLabel('Language').locator('option').allTextContents()).toEqual(['Any language', 'English', 'Español']);
  const heads = await page.locator('main thead th').allTextContents();
  expect(heads.map((h) => h.trim())).toContain('Language');
});
