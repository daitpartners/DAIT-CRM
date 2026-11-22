import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ARJUN, signInAs } from './fixtures';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();

test('Quotations list: sidebar, tiles and tabs; New quotation from the list and from the company page; dashboard tile', async ({ page }) => {
  const company = `Quoteco ${Date.now()}`;
  await signInAs(page, ARJUN);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string; companyId: number };

  // Sidebar: Quotations right after Calendar.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const links = await nav.getByRole('link').allTextContents();
  expect(links.indexOf('Quotations')).toBe(links.indexOf('Calendar') + 1);
  await nav.getByRole('link', { name: 'Quotations' }).click();
  await expect(page).toHaveURL(/\/quotations$/);
  await expect(page.getByRole('heading', { name: 'Quotations', level: 1 })).toBeVisible();
  await expect(page.getByText('Every quotation links to a lead, company and contact. Revisions keep previous versions.')).toBeVisible();
  expect(await page.locator('.tiles .tile .l').allTextContents()).toEqual(['Open value (sent + negotiating)', 'Accepted', 'Expiring within 7 days', 'Win rate']);
  const tabs = await page.getByRole('tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s*\d+$/, '').trim()));
  expect(tabs).toEqual(['All', 'Draft', 'Sent / Negotiating', 'Accepted', 'Rejected / Expired']);

  // New quotation from the list: company, then its lead.
  await page.getByRole('button', { name: 'New quotation' }).click();
  const dialog = page.getByRole('dialog', { name: 'New quotation' });
  await dialog.getByRole('combobox', { name: /Company/ }).fill(company);
  await dialog.getByRole('option', { name: new RegExp(company) }).click();
  await expect(dialog.getByLabel('Lead').locator('option', { hasText: lead.number })).toHaveCount(1);
  await dialog.getByLabel('Lead').selectOption(String(lead.id));
  await dialog.getByRole('button', { name: 'Create quotation' }).click();
  await expect(page).toHaveURL(/\/quotations\/\d+$/);
  const first = Number(page.url().split('/').pop());
  const detail = (await (await page.request.get(`/api/quotations/${first}`)).json()) as { number: string; lead: { id: number } | null };
  expect(detail.lead?.id).toBe(lead.id);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${detail.number} · ${company}`);

  // Back on the list: the Draft row, the Draft tab and the search.
  await page.goto('/quotations');
  const row = page.getByRole('row').filter({ hasText: detail.number });
  await expect(row).toContainText(company);
  await expect(row).toContainText(lead.number);
  await expect(row).toContainText('INR 0.00');
  await expect(row).toContainText('rev 1');
  await expect(row.locator('.badge')).toHaveText('Draft');
  await expect(row.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/quotations/${first}`);
  await page.getByRole('tab', { name: /^Accepted/ }).click();
  await expect(page).toHaveURL(/tab=accepted/);
  await expect(page.getByRole('row').filter({ hasText: detail.number })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Draft/ }).click();
  await expect(page.getByRole('row').filter({ hasText: detail.number })).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search quotations' }).fill('no-such-quotation-zz');
  await expect(page.getByText('No quotations.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search quotations' }).fill(company);
  await expect(page.getByRole('row').filter({ hasText: detail.number })).toHaveCount(1);

  // The company page's New quotation: created for that company with its lead, then opened.
  await page.goto(`/companies/${lead.companyId}`);
  await page.getByRole('button', { name: 'New quotation' }).click();
  await expect(page).toHaveURL(/\/quotations\/\d+$/);
  const second = Number(page.url().split('/').pop());
  expect(second).not.toBe(first);
  const fromCompany = (await (await page.request.get(`/api/quotations/${second}`)).json()) as { company: { id: number }; lead: { id: number } | null };
  expect(fromCompany.company.id).toBe(lead.companyId);
  expect(fromCompany.lead?.id).toBe(lead.id);

  // The company's Leads tab lists both against the lead.
  await page.goto(`/companies/${lead.companyId}#leads`);
  await expect(page.getByRole('row').filter({ hasText: lead.number })).toContainText(`${detail.number} · Draft`);

  // Dashboard: one of Arjun's quotations awaiting a response (marked Sent here; sending is the editor's job).
  sql(`update quotations set status='Sent' where id=${first}`);
  try {
    await page.goto('/');
    const tile = page.locator('.tiles .tile').filter({ hasText: 'Quotes awaiting response' });
    await expect(tile).toHaveAttribute('href', '/quotations');
    await expect(tile.locator('.v')).toHaveText('1');
    await expect(tile.locator('.m')).toHaveText('INR 0.00');
  } finally {
    sql(`delete from quotations where id in (${first}, ${second})`);
  }
});
