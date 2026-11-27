import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { NEHA, signInAs } from './fixtures';

/**
 * Web-mail release 3 (writing and follow-up) on Neha's own connected mailbox, against the e2e fake Graph
 * (E2E_FAKE_GRAPH=1: drafts are made, saved and discarded in memory) and apps/api/test/e2e-send-jobs.ts (the e2e server
 * runs no worker: the queued send runs when the spec says). Specs share one seeded database in file order (F15): this
 * spec makes a lead of its own and two inbox messages linked to it (graph ids `e2e-write-*`), and removes the messages,
 * its drafts and sends, and the lead's tasks afterwards. It never changes the seeded rows other specs open.
 */
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const TAG = 'e2e-write-';
const STAMP = Date.now();
const COMPANY = `Writeco ${STAMP}`;
const NEW_SUBJECT = `Write check new ${STAMP}`;
let leadId = 0;

type Sent = { kind?: string; to: string[]; cc?: string[]; bcc?: string[]; subject?: string; html: string };

/** Runs the queued sends against the fake Microsoft Graph and returns what it was given. */
function runSends(): Sent[] {
  const out = execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });
  return out.split('\n').filter((l) => l.startsWith('e2e-sent: ')).map((l) => JSON.parse(l.slice('e2e-sent: '.length)) as Sent);
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: 'http://localhost:3097' });
  try {
    expect((await api.post('/api/auth/test-login', { data: { email: NEHA } })).status()).toBe(204);
    const me = (await (await api.get('/api/me')).json()) as { id: number };
    const res = await api.post('/api/leads', { data: { companyName: COMPANY, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
    expect(res.status()).toBe(201);
    leadId = ((await res.json()) as { id: number }).id;
  } finally {
    await api.dispose();
  }
  // The two messages the fake Graph can answer (apps/api/src/graph/e2eFake.ts ORIGINALS), on the lead.
  [['1', 'Write check', 'Can we meet next week?'], ['2', 'Write keys', 'One more question.']].forEach(([n, subject, text], i) => {
    sql(`insert into email_messages (user_id, account_id, folder, status, from_address, from_name, to_addresses, subject, body_text, is_read, occurred_at, updated_at, source, graph_id, thread_id, lead_id, company_id)
         select u.id, a.id, 'inbox', 'received', 'client@write.example', 'Wren Client', '["${NEHA}"]'::jsonb, '${subject}', '${text}', true,
                now() - interval '${i + 1} seconds', now(), 'sync', '${TAG}${n}', '${TAG}thread-${n}', l.id, l.company_id
         from users u join email_accounts a on a.user_id = u.id and a.kind = 'personal' join leads l on l.id = ${leadId} where u.email = '${NEHA}'`);
  });
});

test.afterAll(() => {
  // Replies, drafts and sends made here (with the lead's tasks), then the messages themselves.
  sql(`delete from tasks where lead_id = ${leadId}`);
  sql(`delete from jobs where type = 'send_user_email' and status = 'queued' and (payload->>'emailMessageId')::int in (select id from email_messages where lead_id = ${leadId})`);
  sql(`delete from email_messages where reply_to_id in (select id from email_messages where graph_id like '${TAG}%')`);
  sql(`delete from email_messages where graph_id like '${TAG}%' or (lead_id = ${leadId}) or subject = '${NEW_SUBJECT}'`);
});

const row = (page: Page, subject: string) => page.getByRole('region', { name: 'Message list' }).locator('.mrow').filter({ hasText: subject });
const folder = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Mail folders' }).getByRole('link', { name });

test('reply inline, save draft, send with follow-up, undo, send again; the task appears after the send runs', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  const reader = page.getByRole('region', { name: 'Reading pane' });
  await row(page, 'Write check').getByRole('link').click();
  await expect(reader.getByRole('heading', { name: 'Write check', level: 2 })).toBeVisible();

  // Reply: the inline editor at the top of the conversation (no dialog), on a reply draft made in Outlook.
  await reader.locator('.msg-foot').getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = reader.getByRole('form', { name: 'Reply' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editor.getByText(/^Draft saved \d\d:\d\d$/)).toBeVisible();
  await expect(editor.locator('.rcp').filter({ hasText: 'client@write.example' })).toBeVisible();
  const original = Number(sql(`select id from email_messages where graph_id = '${TAG}1'`));
  const body = editor.frameLocator('iframe.rbody').locator('body');
  await body.click({ position: { x: 24, y: 16 } });
  await page.keyboard.type('Thursday works for us.');
  // Auto-saved to the Outlook draft (and its CRM row) without a click.
  await expect.poll(() => sql(`select count(*) from email_messages where reply_to_id = ${original} and folder = 'drafts' and body_html like '%Thursday works for us.%'`)).toBe('1');
  await expect(editor.getByText(/^Draft saved \d\d:\d\d$/)).toBeVisible();

  // Send → the follow-up box (an open lead) → Send and add follow-up → the Undo toast.
  await editor.getByRole('button', { name: 'Send', exact: true }).click();
  const box = page.getByRole('dialog', { name: 'Set the next follow-up' });
  await expect(box.getByRole('radio', { name: /In 3 working days/ })).toBeChecked();
  await expect(box.getByLabel('Task title')).toHaveValue('Follow up: Re: Write check');
  await box.getByRole('button', { name: 'Send and add follow-up' }).click();
  const toast = page.locator('.utoast');
  await expect(toast).toContainText(/Sent · follow-up added for .+\d\d:\d\d/);
  await expect(reader.locator('.sent-note')).toContainText('follow-up task added');

  // Undo within the 10 s: the editor is back with the text; nothing left, no task.
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0);
  const again = reader.getByRole('form', { name: 'Reply' });
  await expect(again.frameLocator('iframe.rbody').locator('body')).toContainText('Thursday works for us.');
  expect(sql(`select status from email_messages where reply_to_id = ${original} and folder = 'drafts'`)).toBe('draft');
  expect(sql(`select count(*) from tasks where lead_id = ${leadId} and origin = 'email_follow_up'`)).toBe('0');

  // Send again, with a High follow-up and a note: queued, no task until the mail leaves.
  await again.getByRole('button', { name: 'Send', exact: true }).click();
  await box.getByLabel('Priority').selectOption({ label: 'High' });
  await box.getByLabel(/^Note/).fill('Ask about the budget');
  await box.getByRole('button', { name: 'Send and add follow-up' }).click();
  await expect(toast).toContainText('Sent · follow-up added for');
  expect(sql(`select count(*) from tasks where lead_id = ${leadId} and origin = 'email_follow_up'`)).toBe('0');

  // The send runs (the worker's job, here by hand): one draft sent through Outlook with the text, then the task.
  const sent = runSends().filter((m) => m.kind === 'draft' && m.html.includes('Thursday works for us.'));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toEqual(['client@write.example']);
  expect(sql(`select count(*) from tasks where lead_id = ${leadId} and origin = 'email_follow_up' and priority = 'high' and note = 'Ask about the budget'`)).toBe('1');
  // The lead's next follow-up is the task's day (the time is the task's).
  expect(sql(`select (l.next_follow_up = t.due_date)::text from leads l join tasks t on t.lead_id = l.id and t.origin = 'email_follow_up' where l.id = ${leadId}`)).toBe('true');

  await page.goto('/tasks');
  const task = page.getByRole('region', { name: 'Upcoming' }).getByRole('listitem').filter({ hasText: 'Follow up: Re: Write check' });
  await expect(task.locator('.task-prio')).toHaveText('High');
  await expect(task.locator('.task-note')).toHaveText('Ask about the budget');

  // Sent items lists the reply.
  await page.goto('/email');
  await folder(page, 'Sent items').click();
  await expect(row(page, 'Re: Write check')).toBeVisible();
});

test('new message full page: Back works, lead picker, Bcc, schedule send lands in Scheduled; Cancel returns it to Drafts', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await expect(page).toHaveURL(/\/email\/new\?draft=\d+$/);
  const untouched = Number(new URL(page.url()).searchParams.get('draft'));

  // Back to the Inbox: the untouched draft goes (from Outlook's Drafts too).
  await page.getByRole('link', { name: '← Back to Inbox' }).click();
  await expect(page).toHaveURL(/\/email$/);
  await expect(page.getByRole('region', { name: 'Message list' })).toBeVisible();
  await expect.poll(() => sql(`select count(*) from email_messages where id = ${untouched}`)).toBe('0');

  await page.getByRole('button', { name: 'New mail', exact: true }).click();
  await expect(page).toHaveURL(/\/email\/new\?draft=\d+$/);
  const id = Number(new URL(page.url()).searchParams.get('draft'));
  const compose = page.getByRole('form', { name: 'New message' });
  await compose.getByRole('combobox', { name: 'Add recipient' }).fill('client@write.example');
  await compose.getByRole('combobox', { name: 'Add recipient' }).press('Enter');
  await expect(compose.locator('.rcp').filter({ hasText: 'client@write.example' })).toBeVisible();
  await compose.getByRole('button', { name: 'Bcc', exact: true }).click();
  await compose.getByRole('combobox', { name: 'Add Bcc' }).fill('boss@write.example');
  await compose.getByRole('combobox', { name: 'Add Bcc' }).press('Enter');
  await compose.getByLabel('Subject').fill(NEW_SUBJECT);

  // The lead picker: search the lead by its company, choose it; the lead summary shows it.
  await compose.getByRole('button', { name: 'Choose a lead' }).click();
  const picker = page.getByRole('menu', { name: 'Choose a lead' });
  await picker.getByRole('searchbox', { name: 'Search leads by LD number or company' }).fill(COMPANY);
  await picker.getByRole('menuitem', { name: new RegExp(COMPANY) }).click();
  await expect(compose.locator('.leadpick')).toContainText(COMPANY);
  const body = compose.frameLocator('iframe.rbody').locator('body');
  await body.click({ position: { x: 24, y: 16 } });
  await page.keyboard.type('See you next week.');

  // ▾ → Schedule send → Tomorrow morning (the default choice) → the follow-up box → Send without follow-up.
  await compose.getByRole('button', { name: 'Send options' }).click();
  const schedule = page.getByRole('dialog', { name: 'Schedule send' });
  await expect(schedule.getByRole('button', { name: /Tomorrow morning/ })).toHaveClass(/hl/);
  await schedule.getByRole('button', { name: 'Schedule', exact: true }).click();
  await page.getByRole('dialog', { name: 'Set the next follow-up' }).getByRole('button', { name: 'Send without follow-up' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Scheduled for / })).toBeVisible();
  await expect(page).toHaveURL(/\/email\?folder=scheduled$/);
  await expect(row(page, NEW_SUBJECT)).toContainText(/Scheduled · .*08:00/);
  expect(sql(`select status, folder, scheduled_at is not null, lead_id, bcc_addresses::text from email_messages where id = ${id}`))
    .toBe(`queued|drafts|t|${leadId}|["boss@write.example"]`);

  // Open it → Cancel: back in Drafts, nothing queued.
  await row(page, NEW_SUBJECT).getByRole('link').click();
  const bar = page.getByRole('region', { name: 'Reading pane' }).getByRole('status', { name: 'Scheduled send' });
  await expect(bar).toContainText('Scheduled for');
  await bar.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Moved to Drafts' })).toBeVisible();
  await expect(row(page, NEW_SUBJECT)).toHaveCount(0);
  await folder(page, /^Drafts/).click();
  await expect(row(page, NEW_SUBJECT)).toBeVisible();
  expect(sql(`select status, scheduled_at is null from email_messages where id = ${id}`)).toBe('draft|t');
  expect(sql(`select count(*) from jobs where type = 'send_user_email' and status = 'queued' and (payload->>'emailMessageId')::int = ${id}`)).toBe('0');
});

test('typing r, e, n or Delete in the editor or a recipient field triggers no shortcut', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email');
  const reader = page.getByRole('region', { name: 'Reading pane' });
  await row(page, 'Write keys').getByRole('link').click();
  await expect(reader.getByRole('heading', { name: 'Write keys', level: 2 })).toBeVisible();
  await reader.locator('.msg-foot').getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = reader.getByRole('form', { name: 'Reply' });
  await expect(editor.getByText(/^Draft saved \d\d:\d\d$/)).toBeVisible();

  // Every mailbox change is a POST / PATCH / DELETE under /api/mail: none may go out (the draft's own saves and
  // recipient lookups aside).
  const changes: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() !== 'GET' && path.startsWith('/api/mail') && !path.startsWith('/api/mail/drafts') && !path.startsWith('/api/mail/recipients')) {
      changes.push(`${r.method()} ${r.url()}`);
    }
  });
  const opened = page.url();
  // Reply (r), archive (e), new mail (n), Delete.
  const typeKeys = async () => {
    await page.keyboard.type('ren');
    await page.keyboard.press('Delete');
  };

  // 1. The message body.
  const body = editor.frameLocator('iframe.rbody').locator('body');
  await body.click({ position: { x: 24, y: 16 } });
  await typeKeys();
  await expect(body).toContainText('ren');

  // 2. A recipient field.
  const to = editor.getByRole('combobox', { name: 'Add recipient' });
  await to.click();
  await typeKeys();
  await expect(to).toHaveValue('ren');
  await to.fill('');

  // Nothing else happened: same page, no dialog, the message still open and in the Inbox, no change sent.
  await expect(page).toHaveURL(opened);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(reader.getByRole('heading', { name: 'Write keys', level: 2 })).toBeVisible();
  await expect(editor).toHaveCount(1);
  await editor.getByRole('button', { name: 'Discard' }).click();
  await expect(editor).toHaveCount(0);
  await expect(row(page, 'Write keys')).toBeVisible();
  expect(changes).toEqual([]);
});
