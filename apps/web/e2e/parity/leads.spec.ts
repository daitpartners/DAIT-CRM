import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

/** Prototype views-leads2.js list, in page order. */
const TILES = ['New this week', 'Follow-ups due today', 'Unassigned'];
const TABS = ['All leads', 'Leads', 'Prospects', 'My leads', 'Overdue follow-ups'];
/** The selects' empty options, in order (the country combobox sits between Source and Assigned). */
/** Language (outreach language, owner 22 Nov 2026) sits after the country combobox. */
const FILTERS = ['Status: Any', 'Source: Any', 'Language: Any', 'Assigned: Any', 'Lead type: Any', 'Created: Any time'];
const COLUMNS = ['Lead ID', 'Company name', 'Contact person', 'Country', 'Language', 'Type', 'Source', 'Status', 'Priority', 'Assigned to', 'Next follow-up', 'Created'];

test('leads list: prototype topbar, tiles, tabs, filters, columns and pager', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toHaveText('Inbound leads and researched prospects, one module');
  // Search, Import CSV and New lead sit in the topbar, in that order.
  const topbar = page.locator('.topbar');
  await expect(topbar.getByRole('searchbox', { name: 'Search leads' })).toHaveAttribute('placeholder', 'Search company, contact, email…');
  const actions = await topbar.locator('.search, .btn').evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
  expect(actions).toEqual(['Search leads', 'Import CSV', 'New lead']);

  expect(await page.locator('.tiles .tile .l').allTextContents()).toEqual(TILES);
  // Review #08: what is waiting (prospects / leads), not the prototype's fixed demo sentence.
  await expect(page.locator('.tiles .tile').nth(2).locator('.m')).toHaveText(/^(Prospects \d+ · Leads \d+|every lead has an owner)$/);
  // The Unassigned tile opens the list filtered to unassigned leads (the prototype has no Unassigned tab).
  await expect(page.locator('.tiles .tile').nth(2)).toHaveAttribute('href', '/leads?assignedTo=none');

  const tabs = await page.getByRole('tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s*\d+$/, '').trim()));
  expect(tabs).toEqual(TABS);
  const all = Number((await page.getByRole('tab', { name: /All leads/ }).locator('.n').textContent())?.trim());

  // Filter selects show "<Field>: Any" when empty; the country combobox reads "Country: Any".
  const blanks = await page.locator('.filters select.chip').evaluateAll((els) => els.map((el) => (el as HTMLSelectElement).options[0]?.text ?? ''));
  expect(blanks).toEqual(FILTERS);
  await expect(page.getByRole('combobox', { name: 'Country' })).toHaveValue('Country: Any');
  await expect(page.locator('.filters')).toContainText(`Showing ${all} of ${all}`);

  const heads = await page.locator('thead th').evaluateAll((els) =>
    els.map((el) => (el.textContent ?? '').replace(/[↑↓\s]+/g, ' ').trim()).filter((x) => x !== ''),
  );
  expect(heads).toEqual(COLUMNS);
  // Lead IDs are purple links in semibold, as in the prototype.
  const firstId = page.locator('tbody tr').first().getByRole('link').first();
  await expect(firstId).toHaveCSS('color', 'rgb(104, 17, 207)');
  await expect(firstId).toHaveCSS('font-weight', '600');

  // Pager: "1–n of m", Rows 25/50/100 (50 by default), First / Prev / Page input / Next / Last.
  const pager = page.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toContainText(`1–${Math.min(all, 50)} of ${all}`);
  const rows = pager.getByLabel('Rows per page');
  await expect(rows).toHaveValue('50');
  expect(await rows.locator('option').allTextContents()).toEqual(['25', '50', '100']);
  for (const name of ['« First', '‹ Prev', 'Next ›', 'Last »']) await expect(pager.getByRole('button', { name })).toBeVisible();
  await expect(pager.getByRole('spinbutton', { name: 'Go to page' })).toHaveValue('1');
  await rows.selectOption('25');
  await expect(page).toHaveURL(/size=25/);
  await expect(pager).toContainText(`1–${Math.min(all, 25)} of ${all}`);

  // A filter narrows "Showing n of m"; m stays the whole list.
  await page.getByLabel('Lead type').selectOption('Prospect');
  const prospects = Number((await page.getByRole('tab', { name: /Prospects/ }).locator('.n').textContent())?.trim());
  await expect(page.locator('.filters')).toContainText(`Showing ${prospects} of ${all}`);

  // Created presets stay relative in the URL; "Custom range…" reveals the 1C from/to date inputs.
  const created = page.getByLabel('Created', { exact: true });
  await created.selectOption({ label: 'Created: Last 7 days' });
  await expect(page).toHaveURL(/created=7/);
  await expect(page).not.toHaveURL(/from=/);
  await expect(page.getByLabel('Created from')).toHaveCount(0);
  await created.selectOption({ label: 'Custom range…' });
  await expect(page).toHaveURL(/created=custom/);
  const d = new Date();
  d.setDate(d.getDate() - 400);
  const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.getByLabel('Created from').fill(from);
  await expect(page).toHaveURL(new RegExp(`from=${from}`));
  await expect(created).toHaveValue('custom');
  await expect(page.locator('.filters')).toContainText(/Showing \d+ of \d+/);

  await page.goto('/leads');
  await captureParity(page, 'leads');
});
