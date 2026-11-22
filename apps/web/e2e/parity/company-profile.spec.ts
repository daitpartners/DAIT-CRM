import { expect, test, type Page } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

/** Section headings of the active panel, in page order (a lettered section's title without its pill and Edit). */
async function headings(page: Page): Promise<string[]> {
  return page
    .getByRole('tabpanel')
    .locator('h2')
    .evaluateAll((els) => els.map((el) => (el.querySelector('span[id]') ?? el).textContent!.replace(/\s+/g, ' ').trim()));
}

/** Every `want` appears in `got`, in this order (a heading may carry a trailing count or note). */
function expectInOrder(got: string[], want: string[]) {
  let at = -1;
  for (const w of want) {
    const next = got.findIndex((x, i) => i > at && (x === w || x.startsWith(`${w} `)));
    expect(next, `"${w}" after position ${at} in ${JSON.stringify(got)}`).toBeGreaterThan(at);
    at = next;
  }
}

test('company profile: prototype header, tabs and section headings', async ({ page }) => {
  await signInAs(page, MAYA);
  const list = (await (await page.request.get('/api/companies?q=CO-0318')).json()) as { items: { id: number }[] };
  const id = list.items[0]!.id;
  await page.goto(`/companies/${id}`);

  // Header: logo initials, crumb with the number, legal name, badges, facts line, actions.
  await expect(page.locator('.topbar .logo.lg')).toHaveText('NL');
  await expect(page.locator('.topbar .crumb')).toHaveText('Companies / CO-0318');
  await expect(page.getByRole('heading', { name: 'Northwind Logistics Private Limited', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toContainText(/northwindlogistics\.in · .* · Pune, India · .*\d+ contacts · \d+ leads · \d+ locations/);
  const actions = await page.locator('.topbar .hdr-actions .btn').allTextContents();
  expect(actions).toEqual(['Run AI research', 'Add contact', 'New lead', 'New quotation', 'Edit profile']);
  await expect(page.getByRole('button', { name: 'Run AI research' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New quotation' })).toBeEnabled();

  const tabs = await page.getByRole('tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s*\d+$/, '').trim()));
  expect(tabs).toEqual(['Overview', 'Contacts', 'Locations', 'Leads & Prospects', 'Projects', 'Activities', 'AI Intelligence', 'Research Sources']);

  // Overview: legend, sections A–E, then the side column.
  await expect(page.locator('.legend')).toContainText('Legend');
  await expect(page.locator('.legend')).toContainText('Last research:');
  expectInOrder(await headings(page), [
    'Company overview', 'Company address', 'Size & financial', 'Products & services', 'Digital presence',
    'AI business intelligence', 'Projects', 'Leads & prospects', 'Contacts',
  ]);
  await expect(page.getByRole('region', { name: 'Leads & prospects' }).getByRole('link', { name: /LD-1001/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'AI business intelligence' })).toContainText('Available in release 4');
  await captureParity(page, 'company-profile');

  const panels: [string, string[]][] = [
    ['Contacts', ['Contacts at Northwind Logistics']],
    ['Locations', ['Office & branch locations']],
    ['Leads & Prospects', ['Leads & prospects linked to this company', 'Pipeline at this company', 'Rules enforced here']],
    ['Projects', ['Projects at Northwind Logistics', 'How projects work']],
    ['Activities', ['All interactions with this company', 'Activity summary', 'Where this comes from']],
    ['AI Intelligence', ['AI business intelligence', 'Suggestions awaiting review', 'Enrichment history', 'AI classification', 'Enrichment engine']],
    ['Research Sources', ['Research sources']],
  ];
  for (const [tab, want] of panels) {
    const tabEl = page.getByRole('tab', { name: new RegExp(`^${tab}`) });
    await tabEl.click();
    await expect(tabEl).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel').locator('h2', { hasText: want[0] }).first()).toBeVisible();
    expectInOrder(await headings(page), want);
  }
  // Leads tab side cards carry numbers and the rules text.
  await page.getByRole('tab', { name: /^Leads & Prospects/ }).click();
  await expect(page.getByRole('region', { name: 'Pipeline at this company' })).toContainText(/Open leads\s*\d+/);
  await expect(page.getByRole('region', { name: 'Rules enforced here' }).getByRole('link', { name: 'Duplicate review' })).toHaveAttribute(
    'href',
    '/companies?tab=dups',
  );
  await page.getByRole('tab', { name: /^Activities/ }).click();
  await expect(page.getByRole('region', { name: 'Activity summary' })).toContainText(/Calls\s*\d+/);
  // Later-release panels are inert.
  await page.getByRole('tab', { name: 'AI Intelligence' }).click();
  await expect(page.getByRole('tabpanel').getByRole('button')).toHaveCount(0);
});
