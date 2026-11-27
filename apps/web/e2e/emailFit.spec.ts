import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { ARJUN, signInAs } from './fixtures';

/**
 * Owner requests (23 Nov 2026): on desktop the Email screen fits the window — the mail area takes the height under the
 * header and filters and the list scrolls on its own; there are no page numbers, the next 50 load when the list is
 * scrolled near its foot. 60 read messages are added to Arjun's own mail for this spec (no mailbox is connected, so
 * other specs see no change) and removed afterwards.
 */
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const TAG = 'e2e-fit-';

test.beforeAll(() => {
  sql(`insert into email_messages (user_id, folder, status, from_address, from_name, to_addresses, subject, body_text, is_read, occurred_at, updated_at, source, graph_id)
       select u.id, 'inbox', 'received', 'client' || g || '@fit.example', 'Client ' || g, '["arjun.mehta@daitpartners.com"]'::jsonb,
              'Fit check ' || g, 'A question about item ' || g, true, now() - (g || ' minutes')::interval, now(), 'sync', '${TAG}' || g
       from users u, generate_series(1, 60) g where u.email = '${ARJUN}'`);
});
test.afterAll(() => {
  sql(`delete from email_messages where graph_id like '${TAG}%'`);
});

async function fits(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/email');
  const list = page.getByRole('region', { name: 'Message list' });
  await expect(list.getByText('Fit check 1', { exact: true })).toBeVisible();
  // No page scroll: the document is the window's height.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height + 1);
  // No pager: the rows scroll on their own.
  await expect(list.getByRole('navigation', { name: 'Pagination' })).toHaveCount(0);
  await expect(list.locator('.mrow')).toHaveCount(50);
  const rows = list.locator('.msglist-rows');
  expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(list.getByText('Fit check 51', { exact: true })).toHaveCount(0);
  // Scrolled to its foot, the list loads the next batch under the first, in the same column.
  await rows.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(list.getByText('Fit check 51', { exact: true })).toBeAttached();
  await expect(list.locator('.mrow')).toHaveCount(60);
  await expect(list.getByRole('status')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height + 1);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

test('the Email screen fits the window at 1400×900 and 1280×720; the list scrolls and loads the next batch at its foot', async ({ page }) => {
  await signInAs(page, ARJUN);
  await fits(page, 1400, 900);
  await fits(page, 1280, 720);
});
