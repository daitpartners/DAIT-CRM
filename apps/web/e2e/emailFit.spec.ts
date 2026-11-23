import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { ARJUN, signInAs } from './fixtures';

/**
 * Owner request (23 Nov 2026): on desktop the Email screen fits the window — the mail area takes the height under the
 * header and filters, the list scrolls on its own and its pager stays in view. 60 read messages are added to Arjun's
 * own mail for this spec (no mailbox is connected, so other specs see no change) and removed afterwards.
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
  // The pager is in view without scrolling.
  const pager = list.getByRole('navigation', { name: 'Pagination' });
  await expect(pager).toBeInViewport({ ratio: 1 });
  await expect(pager.getByText('1–50 of 60')).toBeVisible();
  // The list column scrolls on its own, and Next takes it back to its top.
  const rows = list.locator('.msglist-rows');
  expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await rows.evaluate((el) => el.scrollTo(0, 800));
  await pager.getByRole('button', { name: 'Next ›' }).click();
  await expect(list.getByText('Fit check 51', { exact: true })).toBeVisible();
  expect(await rows.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

test('the Email screen fits the window at 1400×900 and 1280×720; the list scrolls and its pager stays in view', async ({ page }) => {
  await signInAs(page, ARJUN);
  await fits(page, 1400, 900);
  await fits(page, 1280, 720);
});
