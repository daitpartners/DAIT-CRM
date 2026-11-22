import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ARJUN, signInAs } from './fixtures';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();

type Tiles = { active: number; clients: number; completedThisYear: number; onHold: number };

test('Projects: sidebar, create a project for a client from the list, edit it to On hold, tiles follow', async ({ page }) => {
  const company = `Projectco ${Date.now()}`;
  await signInAs(page, ARJUN);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string; companyId: number };
  const contact = await page.request.post('/api/contacts', {
    data: { companyId: lead.companyId, firstName: 'Ravi', lastName: 'Shah', designation: 'CFO', contactType: 'Decision Maker', businessEmail: `ravi.${Date.now()}@projectco.example` },
  });
  expect(contact.status()).toBe(201);
  // A client (a Won lead or an accepted quotation sets the flag; set directly here).
  sql(`update companies set is_client=true where id=${lead.companyId}`);
  const tilesNow = async () => ((await (await page.request.get('/api/projects')).json()) as { tiles: Tiles }).tiles;
  const before = await tilesNow();

  // Sidebar: Projects right after Quotations.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const links = await nav.getByRole('link').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\d+$/, '')));
  expect(links.indexOf('Projects')).toBe(links.indexOf('Quotations') + 1);
  await nav.getByRole('link', { name: /^Projects/ }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expect(page.getByText('Engagements won from leads. One client can have many projects, each from its own lead.')).toBeVisible();
  expect(await page.locator('.tiles .tile .l').allTextContents()).toEqual(['Active projects', 'Total value', 'Completed', 'On hold']);
  const tileValue = (label: string) => page.locator('.tiles .tile').filter({ has: page.locator('.l', { hasText: new RegExp(`^${label}$`) }) }).locator('.v');
  await expect(tileValue('Active projects')).toHaveText(String(before.active));

  // Create project: choose the client; the name, currency and the Decision Maker are filled in.
  await page.getByRole('button', { name: 'Create project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  await dialog.getByRole('combobox', { name: /Client/ }).fill(company);
  await dialog.getByRole('option', { name: `${company} · client` }).click();
  await expect(dialog.getByLabel(/Project name/)).toHaveValue(`${company} · `);
  await expect(dialog.getByLabel('Currency')).toHaveValue('INR');
  await expect(dialog.getByRole('checkbox', { name: /Ravi Shah · CFO/ })).toBeChecked();
  await dialog.getByLabel('From lead').selectOption(String(lead.id));
  await dialog.getByLabel(/Project name/).fill(`${company} · Advisory`);
  await dialog.getByLabel('Value').fill('250000');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText(/^PRJ-\d+ created · 1 stakeholders$/)).toBeVisible();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: `${company} · Advisory` });
  await expect(row).toContainText(lead.number);
  await expect(row).toContainText('INR 2,50,000');
  await expect(row).toContainText('Ravi Shah');
  await expect(row).toContainText('Arjun Mehta');
  await expect(row.locator('.badge')).toHaveText('Active');
  await expect(tileValue('Active projects')).toHaveText(String(before.active + 1));

  // Edit: the client is locked; status to On hold.
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit project' });
  await expect(edit.getByLabel(/Client/)).toBeDisabled();
  await expect(edit.getByRole('checkbox', { name: /Ravi Shah/ })).toBeChecked();
  await edit.getByLabel('Status').selectOption('On hold');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Project updated')).toBeVisible();
  await expect(row.locator('.badge')).toHaveText('On hold');
  await expect(tileValue('Active projects')).toHaveText(String(before.active));
  await expect(tileValue('On hold')).toHaveText(String(before.onHold + 1));

  // The filters live in the URL.
  await page.getByLabel('Status').selectOption('On hold');
  await expect(page).toHaveURL(/status=On\+hold/);
  await expect(row).toBeVisible();
  await page.getByRole('link', { name: '✕ Clear' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});
