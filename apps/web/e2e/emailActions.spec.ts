import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { NEHA, signInAs } from './fixtures';

/**
 * Web-mail release 2: the Email screen's two-way actions on Neha's own (connected) mailbox. The e2e server answers
 * Outlook from a fake Graph (E2E_FAKE_GRAPH=1), so every change succeeds there and the CRM's rows show the result.
 * Specs share one seeded database in file order (F15): this spec adds its own messages (graph ids `e2e-act-*`) and
 * removes them, and what it sends, afterwards. It never changes the seeded rows other specs open.
 */
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const TAG = 'e2e-act-';
const SUBJECTS = ['Action check one', 'Action check two', 'Action check three'];

test.beforeAll(() => {
  SUBJECTS.forEach((subject, i) => {
    sql(`insert into email_messages (user_id, account_id, folder, status, from_address, from_name, to_addresses, cc_addresses, subject, body_text, is_read, occurred_at, updated_at, source, graph_id, thread_id)
         select u.id, a.id, 'inbox', 'received', 'client@act.example', 'Act Client', '["${NEHA}"]'::jsonb, '["colleague@act.example"]'::jsonb, '${subject}',
                'About item ${i + 1}', true, now() - interval '${i + 1} minutes', now(), 'sync', '${TAG}${i + 1}', '${TAG}thread-${i + 1}'
         from users u join email_accounts a on a.user_id = u.id and a.kind = 'personal' where u.email = '${NEHA}'`);
  });
});
test.afterAll(() => {
  // What Reply all sent from these messages (with its timeline lines, if any), then the messages themselves.
  sql(`delete from email_messages where reply_to_id in (select id from email_messages where graph_id like '${TAG}%')`);
  sql(`delete from email_messages where graph_id like '${TAG}%'`);
});

/** A message list row by its subject. */
const row = (page: Page, subject: string) => page.getByRole('region', { name: 'Message list' }).locator('.mrow').filter({ hasText: subject });
const folder = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Mail folders' }).getByRole('link', { name });
const commandBar = (page: Page) => page.getByRole('toolbar', { name: 'Mail commands' });

test('two-way actions: flag, archive with E, move back, multi-select delete, right-click menu, attachment download', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  const list = page.getByRole('region', { name: 'Message list' });
  const reader = page.getByRole('region', { name: 'Reading pane' });

  // Flag ▾ Tomorrow → the row shows the flag; the Flagged folder lists it.
  await row(page, SUBJECTS[0]!).getByRole('link').click();
  await expect(reader.getByRole('heading', { name: SUBJECTS[0], level: 2 })).toBeVisible();
  await commandBar(page).getByRole('button', { name: 'Flag', exact: true }).click();
  await page.getByRole('menu', { name: 'Flag' }).getByRole('menuitem', { name: /^Tomorrow/ }).click();
  await expect(row(page, SUBJECTS[0]!).getByTitle('Flagged')).toBeVisible();
  await folder(page, /^Flagged/).click();
  await expect(row(page, SUBJECTS[0]!)).toBeVisible();
  await expect(list.locator('.mrow')).toHaveCount(1);

  // E archives the open message: it leaves the Inbox and the Archive lists it; Move to ▾ Inbox brings it back.
  await folder(page, /^Inbox/).click();
  await row(page, SUBJECTS[1]!).getByRole('link').click();
  await expect(reader.getByRole('heading', { name: SUBJECTS[1], level: 2 })).toBeVisible();
  await page.keyboard.press('e');
  await expect(row(page, SUBJECTS[1]!)).toHaveCount(0);
  await folder(page, 'Archive').click();
  await expect(list.getByRole('heading', { name: 'Archive', level: 2 })).toBeVisible();
  await row(page, SUBJECTS[1]!).getByRole('link').click();
  await expect(reader.getByRole('heading', { name: SUBJECTS[1], level: 2 })).toBeVisible();
  await commandBar(page).getByRole('button', { name: 'Move to', exact: true }).click();
  await page.getByRole('menu', { name: 'Move to' }).getByRole('menuitem', { name: 'Inbox' }).click();
  await expect(row(page, SUBJECTS[1]!)).toHaveCount(0);
  await folder(page, /^Inbox/).click();
  await expect(row(page, SUBJECTS[1]!)).toBeVisible();

  // Right-click a row → its menu, with Move to ›; Escape closes it.
  await row(page, SUBJECTS[2]!).click({ button: 'right' });
  const actions = page.getByRole('menu', { name: 'Message actions' });
  await expect(actions.getByRole('menuitem', { name: /^Move to/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toHaveCount(0);

  // Check two rows → bulk Delete → both are in Deleted items.
  for (const subject of [SUBJECTS[1]!, SUBJECTS[2]!]) {
    await row(page, subject).hover();
    await row(page, subject).getByRole('checkbox', { name: 'Select message' }).check();
  }
  await expect(list).toContainText('2 selected');
  await list.locator('.ml-bulk').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, SUBJECTS[1]!)).toHaveCount(0);
  await expect(row(page, SUBJECTS[2]!)).toHaveCount(0);
  await folder(page, 'Deleted items').click();
  await expect(row(page, SUBJECTS[1]!)).toBeVisible();
  await expect(row(page, SUBJECTS[2]!)).toBeVisible();

  // Delete inside Deleted items asks before deleting permanently; Cancel keeps the message.
  await row(page, SUBJECTS[2]!).getByRole('link').click();
  await expect(reader.getByRole('heading', { name: SUBJECTS[2], level: 2 })).toBeVisible();
  await commandBar(page).getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete permanently?' });
  await expect(confirm).toContainText('It is removed from Outlook too.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(row(page, SUBJECTS[2]!)).toBeVisible();

  // Orbit's attachment (seeded message e2e-2, read only here): Download is a file, Preview opens the PDF in the browser.
  const orbit = Number(sql(`select id from email_messages where graph_id = 'e2e-2'`));
  const download = await page.request.get(`/api/mail/${orbit}/attachment?att=e2e-att-1`);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toBe('application/octet-stream');
  expect(download.headers()['content-disposition']).toMatch(/^attachment;.*orbit-notes\.pdf/);
  const preview = await page.request.get(`/api/mail/${orbit}/attachment?att=e2e-att-1&inline=1`);
  expect(preview.status()).toBe(200);
  expect(preview.headers()['content-type']).toMatch(/^application\/pdf/);
  expect(preview.headers()['content-disposition']).toMatch(/^inline/);
  expect((await preview.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('Reply all goes out through Outlook with the original recipients', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  await row(page, SUBJECTS[0]!).getByRole('link').click();
  const reader = page.getByRole('region', { name: 'Reading pane' });
  await expect(reader.getByRole('heading', { name: SUBJECTS[0], level: 2 })).toBeVisible();
  await reader.locator('.msg-foot').getByRole('button', { name: 'Reply all' }).click();
  const compose = page.getByRole('dialog', { name: 'Reply all' });
  await compose.getByLabel('Message').fill('Thanks, both of you.');
  await compose.getByRole('button', { name: 'Send' }).click();
  await expect(compose).toHaveCount(0);

  // The e2e server runs no worker: run the queued send against the fake Graph and read what it was given.
  const out = execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });
  const sent = out.split('\n').filter((l) => l.startsWith('e2e-sent: ')).map((l) => JSON.parse(l.slice('e2e-sent: '.length)) as { kind?: string; graphId?: string; to: string[]; cc?: string[]; html: string });
  const replyAll = sent.find((s) => s.kind === 'replyAll');
  expect(replyAll).toBeDefined();
  expect(replyAll!.graphId).toBe(`${TAG}1`);
  expect([...replyAll!.to, ...(replyAll!.cc ?? [])]).toEqual(expect.arrayContaining(['client@act.example', 'colleague@act.example']));
  expect(replyAll!.html).toContain('Thanks, both of you.');
});

test('typing in the search box, a filter field, the Link to lead search or the Compose body never triggers shortcuts', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  const reader = page.getByRole('region', { name: 'Reading pane' });
  await row(page, SUBJECTS[0]!).getByRole('link').click();
  await expect(reader.getByRole('heading', { name: SUBJECTS[0], level: 2 })).toBeVisible();

  // Every mailbox change is a POST / PATCH / DELETE under /api/mail: none may go out while typing.
  const changes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && new URL(r.url()).pathname.startsWith('/api/mail')) changes.push(`${r.method()} ${r.url()}`);
  });
  // Archive (e), reply (r), forward (f), new mail (n), Delete.
  const KEYS = 'refine';
  const typeKeys = async () => {
    await page.keyboard.type(KEYS);
    await page.keyboard.press('Delete');
  };
  const dialogs = page.getByRole('dialog');

  // 1. The search box.
  await page.getByRole('searchbox', { name: 'Search lead mail' }).click();
  await typeKeys();
  await expect(page.getByRole('searchbox', { name: 'Search lead mail' })).toHaveValue(KEYS);
  await expect(dialogs).toHaveCount(0);

  // 2. A Filters panel field.
  await page.getByRole('button', { name: 'Filters' }).click();
  const from = page.getByRole('group', { name: 'Search filters' }).getByLabel('From');
  await from.click();
  await typeKeys();
  await expect(from).toHaveValue(KEYS);
  await expect(dialogs).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 3. The Link to lead search.
  await commandBar(page).getByRole('button', { name: 'Link to lead' }).click();
  const leadSearch = page.getByRole('menu', { name: 'Link to lead' }).getByRole('searchbox', { name: 'Search leads by LD number or company' });
  await leadSearch.click();
  await typeKeys();
  await expect(leadSearch).toHaveValue(KEYS);
  await expect(dialogs).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 4. The Compose body: still one dialog.
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  const compose = page.getByRole('dialog', { name: 'Compose email' });
  await compose.getByLabel('Message').click();
  await typeKeys();
  await expect(compose.getByLabel('Message')).toHaveValue(new RegExp(KEYS));
  await expect(dialogs).toHaveCount(1);
  await compose.getByRole('button', { name: 'Discard' }).click();

  // Nothing moved: no change went out and the message is still in the Inbox.
  expect(changes).toEqual([]);
  await expect(row(page, SUBJECTS[0]!)).toBeVisible();
});
