import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from './fixtures';

test('creates a lead linked to an existing company via duplicate hint', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Orbit Fintech' })).toBeVisible();

  await page.getByRole('button', { name: 'New lead' }).click();
  await expect(page).toHaveURL(/\/leads\/new$/);
  const form = page.getByRole('form', { name: 'Create lead or prospect' });
  await form.getByLabel('Company name').fill('Northwind Logistics');
  await form.getByLabel('Company website').fill('https://northwindlogistics.in');

  // A lead may join an existing company: the match is offered, not blocking.
  const dup = form.locator('.note.warn').filter({ hasText: 'Possible duplicate: 1 existing company matches' });
  await expect(dup).toContainText('Matched on exact website domain · confidence High.');
  const save = form.getByRole('button', { name: 'Create lead' });
  await expect(save).toBeEnabled();
  await dup.getByRole('button', { name: 'Use existing company' }).click();
  await expect(form.getByRole('combobox', { name: 'Company (existing record)' })).toHaveValue(/^CO-0318 · Northwind Logistics/);
  await expect(form.getByText(/Linked to existing company CO-0318/)).toBeVisible();

  const country = form.getByRole('combobox', { name: 'Country' });
  await country.fill('India');
  await country.press('Enter');
  await form.getByLabel('Lead source').selectOption('Referral');
  await save.click();

  const toast = page.getByRole('status').filter({ hasText: /LD-\d+ created/ });
  await expect(toast).toBeVisible();
  const number = (await toast.textContent())!.match(/LD-\d+/)![0];
  await expect(page).toHaveURL(/\/leads\/\d+$/);
  await expect(page.getByRole('heading', { name: number, level: 1 })).toBeVisible();

  await page.goto('/leads');
  await page.getByRole('searchbox', { name: 'Search leads' }).fill(number);
  const row = page.getByRole('row').filter({ hasText: number });
  await expect(row).toContainText('Northwind Logistics');
  await expect(page.locator('tbody tr')).toHaveCount(1);

  const res = await page.request.get(`/api/leads?q=${number}`);
  const body = (await res.json()) as { items: { number: string; company: { number: string } | null }[] };
  expect(body.items[0]?.company?.number).toBe('CO-0318');
});

test('sales rep sees unassigned leads and claims one from the list', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/leads');
  // Arjun sees his own lead and the unassigned pool, never Maya's.
  await expect(page.getByRole('row').filter({ hasText: 'LD-1001' })).toContainText('Northwind Logistics');
  await expect(page.getByRole('row').filter({ hasText: 'Orbit Fintech' })).toHaveCount(0);

  // The Unassigned tile opens the unassigned pool (the prototype has no Unassigned tab).
  await page.locator('.tiles .tile').filter({ hasText: 'Unassigned' }).click();
  await expect(page).toHaveURL(/assignedTo=none/);
  const row = page.getByRole('row').filter({ hasText: 'Meridian Textiles' });
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();

  await page.getByLabel('Assign to…').selectOption({ label: 'Me' });
  const dialog = page.getByRole('dialog', { name: 'Assign leads' });
  await dialog.getByRole('button', { name: 'Assign' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Leads assigned: 1' })).toBeVisible();
  await expect(row).toHaveCount(0);

  // Filters stay on across tabs (as in the prototype): clear "Assigned: Unassigned" before looking at My leads.
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('tab', { name: /My leads/ }).click();
  const mine = page.getByRole('row').filter({ hasText: 'Meridian Textiles' });
  await expect(mine).toContainText('Arjun Mehta');
});

test('select-all shows a partial selection (prototype "–") and its boxes are the prototype size', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/leads');
  const all = page.getByRole('checkbox', { name: 'Select all leads on this page' });
  await page.locator('tbody tr').first().getByRole('checkbox').check();
  await expect(all).not.toBeChecked();
  expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
  expect(await all.evaluate((el) => el.getBoundingClientRect().width)).toBe(16);
  await all.check();
  expect(await all.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(false);
});
