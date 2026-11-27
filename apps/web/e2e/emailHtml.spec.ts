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
  const reader = page.getByRole('region', { name: 'Reading pane' });
  await expect(reader.getByRole('heading', { name: 'Three ideas for your Q1 website refresh', level: 2 })).toBeVisible();
  const frame = reader.getByTitle('Message body');
  // Web-mail release 2 (ruling F34): same-origin for the auto height, popups for links, never scripts; the frame's own
  // CSP refuses scripts in so many words.
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  expect(await frame.getAttribute('sandbox')).not.toContain('allow-scripts');
  const body = page.frameLocator('iframe[title="Message body"]');
  await expect(body.getByRole('heading', { name: 'Three ideas for your Q1 website refresh' })).toBeVisible();
  const csp = await body.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'none'");
  // The newsletter's own <style> applies (the button) and its images show.
  const button = body.getByRole('link', { name: 'Read the full guide' });
  await expect(button).toHaveCSS('background-color', 'rgb(10, 102, 194)');
  await expect(button).toHaveAttribute('target', '_blank');
  await expect(button).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await body.getByRole('img', { name: 'Q1 Website Refresh' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // The 600 px newsletter narrows to the reader's column instead of running off its side.
  expect(await body.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // No markup or CSS as text anywhere in the reader.
  await expect(reader).not.toContainText('.btn{');
  // No page scroll; the frame takes its content's height (no inner scrollbar) and the conversation scrolls instead.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(901);
  await expect.poll(async () => {
    const content = await body.locator('body').evaluate((el) => el.scrollHeight);
    const box = (await frame.boundingBox())!;
    return box.height >= content;
  }).toBe(true);
  expect(await body.locator('html').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);

  await list.getByRole('link', { name: /RE: Orbit website proposal/ }).click();
  await expect(page.frameLocator('iframe[title="Message body"]').getByText('Head of Marketing · Orbit Logistics')).toBeVisible();

  await list.getByRole('link', { name: /October invoice/ }).click();
  const plain = page.getByRole('region', { name: 'Reading pane' });
  await expect(plain.getByRole('heading', { name: 'October invoice', level: 2 })).toBeVisible();
  await expect(plain.getByTitle('Message body')).toHaveCount(0);
  await expect(plain.locator('.plain')).toHaveText(PLAIN_TEXT);
});
