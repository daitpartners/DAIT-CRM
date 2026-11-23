import { expect, test } from '@playwright/test';
import { ARJUN, signInAs } from '../fixtures';
import { captureParity } from './_shared';

/** Prototype app.js reports(): two cards, Leads by source and Enquiry conversion. */
const ENQUIRY_ROWS = ['Enquiries received', 'Spam blocked', 'Leads created', 'Awaiting manual review', 'Matched existing companies'];

test('reports: prototype title, Leads by source bars and Enquiry conversion', async ({ page }) => {
  await signInAs(page, ARJUN);
  const api = (await (await page.request.get('/api/reports')).json()) as { bySource: { source: string; count: number }[] };
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toHaveText('Where leads come from and how website enquiries turn into leads');

  const heads = await page.locator('main h2').allTextContents();
  expect(heads).toEqual(['Leads by source', 'Enquiry conversion']);

  // One row per source, largest first, count on the right and a bar sized to the largest.
  const sources = page.getByRole('region', { name: 'Leads by source' }).getByRole('listitem');
  await expect(sources).toHaveCount(api.bySource.length);
  const top = api.bySource[0]!;
  await expect(sources.first()).toContainText(top.source);
  await expect(sources.first().locator('strong')).toHaveText(String(top.count));
  await expect(sources.first().locator('.bar > div')).toHaveAttribute('style', /width: 100%/);

  // Enquiry conversion: the prototype's five rows; 0 until there are enquiries.
  const kv = page.getByRole('region', { name: 'Enquiry conversion' });
  expect(await kv.locator('dt').allTextContents()).toEqual(ENQUIRY_ROWS);
  expect(await kv.locator('dd').allTextContents()).toEqual(['0', '0', '0', '0', '0']);

  await captureParity(page, 'reports');
});
