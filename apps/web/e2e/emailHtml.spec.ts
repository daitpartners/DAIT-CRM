import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ARJUN, signInAs } from './fixtures';
import { NEWSLETTER_HTML, NEWSLETTER_TEXT, PLAIN_TEXT, SIGNATURE_HTML, SIGNATURE_TEXT } from './mailBodies';

/**
 * Owner request (23 Nov 2026): emails read as they do in Outlook. A newsletter, a reply with a signature table and a
 * plain-text message are added to Arjun's own mail (no mailbox is connected, so other specs see no change) and removed
 * afterwards.
 */
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const TAG = 'e2e-html-';
const quote = (s: string | null) => (s === null ? 'null' : `$body$${s}$body$`);

function add(n: number, from: string, subject: string, text: string, html: string | null, minutesAgo: number) {
  sql(`insert into email_messages (user_id, folder, status, from_address, from_name, to_addresses, subject, body_text, body_html, is_read, occurred_at, updated_at, source, graph_id)
       select u.id, 'inbox', 'received', '${from.toLowerCase().replace(/\s+/g, '.')}@example.com', '${from}', '["${ARJUN}"]'::jsonb, '${subject}',
              ${quote(text)}, ${quote(html)}, true, now() - interval '${minutesAgo} minutes', now(), 'sync', '${TAG}${n}'
       from users u where u.email = '${ARJUN}'`);
}

test.beforeAll(() => {
  add(1, 'Northwind Digital', 'Three ideas for your Q1 website refresh', NEWSLETTER_TEXT, NEWSLETTER_HTML, 3);
  add(2, 'Neha Rao', 'RE: Orbit website proposal', SIGNATURE_TEXT, SIGNATURE_HTML, 2);
  add(3, 'Luis Vega', 'October invoice', PLAIN_TEXT, null, 1);
});
test.afterAll(() => {
  sql(`delete from email_messages where graph_id like '${TAG}%'`);
});

test('HTML emails show formatted in a sandboxed frame; plain text shows as text', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signInAs(page, ARJUN);
  await page.goto('/email');
  const list = page.getByRole('region', { name: 'Message list' });

  await list.getByRole('link', { name: /Three ideas for your Q1 website refresh/ }).click();
  const reader = page.getByRole('article', { name: 'Three ideas for your Q1 website refresh' });
  const frame = reader.getByTitle('Message body');
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  const body = page.frameLocator('iframe[title="Message body"]');
  await expect(body.getByRole('heading', { name: 'Three ideas for your Q1 website refresh' })).toBeVisible();
  // The newsletter's own <style> applies (the button) and its images show.
  const button = body.getByRole('link', { name: 'Read the full guide' });
  await expect(button).toHaveCSS('background-color', 'rgb(10, 102, 194)');
  await expect(button).toHaveAttribute('target', '_blank');
  expect(await body.getByRole('img', { name: 'Q1 Website Refresh' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // The 600 px newsletter narrows to the reader's column instead of running off its side.
  expect(await body.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // No markup or CSS as text anywhere in the reader.
  await expect(reader).not.toContainText('.btn{');
  // The fluid layout stays: no page scroll, the frame fills the reader's column.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(901);
  const box = (await frame.boundingBox())!;
  const foot = (await reader.locator('.reader-foot').boundingBox())!;
  expect(box.height).toBeGreaterThan(300);
  expect(Math.abs(box.y + box.height - foot.y)).toBeLessThanOrEqual(2);

  await list.getByRole('link', { name: /RE: Orbit website proposal/ }).click();
  await expect(page.frameLocator('iframe[title="Message body"]').getByText('Head of Marketing · Orbit Logistics')).toBeVisible();

  await list.getByRole('link', { name: /October invoice/ }).click();
  const plain = page.getByRole('article', { name: 'October invoice' });
  await expect(plain.getByTitle('Message body')).toHaveCount(0);
  await expect(plain.locator('.body')).toHaveText(PLAIN_TEXT);
});
