import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

/** Card titles of the prototype's "Create lead or prospect" page (views-leads.js `V.leadForm`), in page order. */
const PROTOTYPE_ORDER = ['Lead type', 'Company', 'Source', 'Assignment & follow-up', 'What happens on save', 'Linked company preview'];

test('new lead page: prototype cards in order, defaults, and a company preset from ?company=', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  await expect(page).toHaveURL(/\/leads\/new$/);
  await expect(page.getByRole('heading', { name: 'Create lead or prospect', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .crumb')).toHaveText('Leads / New');
  await expect(page.locator('.topbar')).toContainText('Lead ID will be generated on save');

  const titles = await page.locator('main h2').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()));
  let at = -1;
  for (const want of PROTOTYPE_ORDER) {
    const next = titles.findIndex((x, i) => i > at && x.startsWith(want));
    expect(next, `"${want}" after position ${at} in ${JSON.stringify(titles)}`).toBeGreaterThan(at);
    at = next;
  }

  const form = page.getByRole('form', { name: 'Create lead or prospect' });
  // Defaults: Lead, Manual Entry, the creator as owner, Medium, New (fixed), follow-up in two days.
  await expect(form.getByRole('radio', { name: /^Lead/ })).toBeChecked();
  await expect(form.getByLabel('Lead source')).toHaveValue('Manual Entry');
  await expect(form.getByLabel('Assigned to').locator('option').first()).toHaveText('Leave unassigned · allocation rules decide');
  await expect(form.getByLabel('Assigned to').locator('option:checked')).toHaveText('Maya Pillai (me)');
  await expect(form.getByLabel('Lead priority')).toHaveValue('Medium');
  // Country starts on India and the phone hint reads "+91 …", as in the prototype.
  await expect(form.getByRole('combobox', { name: 'Country' })).toHaveValue('India');
  await expect(form.getByLabel('Phone number')).toHaveAttribute('placeholder', '+91 …');
  await expect(form.getByLabel('Lead status')).toBeDisabled();
  await expect(form.getByLabel('Next follow-up date')).not.toHaveValue('');
  await expect(form.getByRole('combobox', { name: 'Company (existing record)' })).toHaveAttribute('placeholder', 'Create new company on save');
  await expect(form.getByLabel('Contact person')).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Linked company preview' })).toContainText('A new company record will be created on save');
  await expect(page.getByRole('region', { name: 'What happens on save' })).toContainText(
    'AI enrichment job is queued with status Pending. It never overwrites verified fields.',
  );

  // A new name: no duplicate, a new company on save.
  await form.getByLabel('Company name').fill(`Parity Newco ${Date.now()}`);
  await expect(form.getByText(/No duplicate found for this name, website or email domain/)).toBeVisible();
  await captureParity(page, 'new-lead');

  // From the company profile: linked to Northwind, its primary contact chosen and its details filled in.
  const companies = (await (await page.request.get('/api/companies?q=Northwind')).json()) as { items: { id: number; number: string }[] };
  const northwind = companies.items.find((c) => c.number === 'CO-0318')!;
  // Other specs may change Northwind's primary contact: expect whichever one is primary now.
  const people = (await (await page.request.get(`/api/contacts?companyId=${northwind.id}&pageSize=100`)).json()) as {
    items: { firstName: string; lastName: string; isPrimary: boolean; businessEmail: string | null }[];
  };
  const primary = people.items.find((c) => c.isPrimary) ?? people.items[0]!;
  await page.goto(`/leads/new?company=${northwind.id}`);
  await expect(form.getByLabel('Company name')).toHaveValue('Northwind Logistics');
  await expect(form.getByRole('combobox', { name: 'Company (existing record)' })).toHaveValue(/^CO-0318 · Northwind Logistics/);
  await expect(form.getByLabel('Contact person').locator('option:checked')).toHaveText(new RegExp(`^${primary.firstName} ${primary.lastName} · `));
  await expect(form.getByLabel('Business email')).toHaveValue(primary.businessEmail ?? '');
  await expect(form.getByText(/Linked to existing company CO-0318/)).toBeVisible();
  const preview = page.getByRole('region', { name: 'Linked company preview' });
  await expect(preview.getByRole('link', { name: /Northwind Logistics/ })).toBeVisible();
  await expect(preview).toContainText('Open leads');
  await expect(preview).toContainText('Verification');
  await expect(page.locator('main')).not.toContainText(/undefined|NaN/);
  await captureParity(page, 'new-lead-company');

  // A linked company outside India replaces the India default with its own country.
  const orbit = ((await (await page.request.get('/api/companies?q=Orbit')).json()) as { items: { id: number; number: string }[] }).items
    .find((c) => c.number === 'CO-0310')!;
  await page.goto(`/leads/new?company=${orbit.id}`);
  await expect(form.getByRole('combobox', { name: 'Company (existing record)' })).toHaveValue(/^CO-0310 · Orbit Fintech/);
  await expect(form.getByRole('combobox', { name: 'Country' })).toHaveValue('Germany');
});
