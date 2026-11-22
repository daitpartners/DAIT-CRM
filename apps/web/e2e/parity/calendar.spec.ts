import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test, type Page } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from '../fixtures';
import { PARITY_OUT } from './_shared';

/**
 * Prototype parity captures for release 3C (Calendar): writes `<screen>-app.png` and `<screen>-proto.png` pairs at
 * 1440×900 (full page) to PARITY_DIR, or e2e/parity/out. The app side seeds Arjun (Sales Representative) with
 * follow-ups (timed, untimed, done, overdue), a call, a meeting and Outlook events (with and without a lead, all-day),
 * then removes the tasks and the mailbox again so later specs see the seeded data unchanged. The prototype side opens
 * prototype/index.html from disk in a fresh context.
 */
const OUT = process.env.PARITY_DIR ?? PARITY_OUT;
const VIEWPORT = { width: 1440, height: 900 };
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const PROTO = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../prototype/index.html')).href;
const TAG = 'Parity cal';

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();

/** YYYY-MM-DD `days` from today (the e2e users are on Europe/London, as the test runner). */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('calendar parity: app side', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signInAs(page, ARJUN);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const mayaId = Number(sql(`select id from users where email='${MAYA}'`));
  const cleanup = () => {
    sql(`delete from tasks where title like '${TAG}%' or title in ('Chase proposal','Call back about the proposal','Discovery meeting','Send capability deck','Intro call','Revise quotation','Follow up after the demo','Pipeline check-in')`);
    sql(`delete from email_accounts where address='arjun.mehta@daitpartners.com' and kind='personal'`);
  };
  cleanup();

  // Three open leads of Arjun's.
  const leads: { id: number; number: string; companyName: string }[] = [];
  for (const [companyName, country] of [['Bluefin Marine Supplies', 'United Kingdom'], ['Sunrise Pharma', 'India'], ['Meyer Bauhaus', 'Germany']] as const) {
    const res = await page.request.post('/api/leads', { data: { companyName: `${companyName}`, country, leadSource: 'Referral', assignedToId: me.id } });
    expect(res.status()).toBe(201);
    leads.push({ ...((await res.json()) as { id: number; number: string }), companyName });
  }
  const [bluefin, sunrise, meyer] = leads as [typeof leads[0], typeof leads[0], typeof leads[0]];
  const task = async (data: Record<string, unknown>) => {
    const res = await page.request.post('/api/tasks', { data: { assignedToId: me.id, ...data } });
    expect(res.status(), JSON.stringify(data)).toBe(201);
    return (await res.json()) as { id: number; updatedAt: string };
  };
  await task({ leadId: bluefin.id, title: 'Chase proposal', dueDate: inDays(-3) });
  await task({ leadId: sunrise.id, title: 'Revise quotation', dueDate: inDays(-1), dueTime: '16:00' });
  await task({ leadId: bluefin.id, title: 'Call back about the proposal', dueDate: inDays(0), kind: 'call', dueTime: '10:30', timeline: true });
  await task({ leadId: meyer.id, title: 'Send capability deck', dueDate: inDays(0) });
  const done = await task({ leadId: sunrise.id, title: 'Discovery meeting', dueDate: inDays(-2), kind: 'meeting', dueTime: '10:00' });
  expect((await page.request.patch(`/api/tasks/${done.id}`, { data: { isDone: true, updatedAt: done.updatedAt } })).status()).toBe(200);
  await task({ leadId: meyer.id, title: 'Intro call', dueDate: inDays(2), kind: 'call', dueTime: '11:30' });
  await task({ leadId: sunrise.id, title: 'Follow up after the demo', dueDate: inDays(3), dueTime: '09:00', timeline: true });
  // A team member's task, for Everyone.
  await task({ title: 'Pipeline check-in', dueDate: inDays(1), assignedToId: me.id });
  const res = await page.request.post('/api/auth/test-login', { data: { email: MAYA } });
  expect(res.status()).toBe(204);
  expect((await page.request.post('/api/tasks', { data: { title: `${TAG} Maya review`, dueDate: inDays(1), assignedToId: mayaId, kind: 'meeting', dueTime: '14:00' } })).status()).toBe(201);
  await signInAs(page, ARJUN);

  // Arjun's mailbox with calendar sync on, and three Outlook events: with a lead, without one, and all-day.
  const acct = sql(
    `insert into email_accounts (user_id,address,provider,kind,refresh_token_enc,status,sync_calendar,updated_at) values (${me.id},'arjun.mehta@daitpartners.com','microsoft','personal','x','connected',true,now()) returning id`,
  ).split('\n')[0];
  const at = (days: number, hm: string) => `'${inDays(days)} ${hm}:00'`;
  sql(`insert into calendar_events (user_id,account_id,graph_id,subject,starts_at,ends_at,location,organizer_name,organizer_address,attendee_addresses,is_online,lead_id,updated_at) values
    (${me.id},${acct},'pc-1','Negotiation · Sunrise Pharma',${at(1, '15:30')},${at(1, '17:00')},'Hyderabad office','Arjun Mehta','arjun.mehta@daitpartners.com','["anil.verma@sunrise.example","neha.kapoor@daitpartners.com"]',false,${sunrise.id},now()),
    (${me.id},${acct},'pc-2','Pipeline review',${at(0, '17:00')},${at(0, '18:00')},'Office','Neha Kapoor','neha.kapoor@daitpartners.com','["arjun.mehta@daitpartners.com","maya.pillai@daitpartners.com"]',false,null,now())`);
  sql(`insert into calendar_events (user_id,account_id,graph_id,subject,starts_at,ends_at,is_all_day,organizer_name,organizer_address,updated_at) values
    (${me.id},${acct},'pc-3','Team offsite','${inDays(4)} 00:00:00','${inDays(5)} 00:00:00',true,'Maya Pillai','maya.pillai@daitpartners.com',now())`);

  try {
    const today = inDays(0);
    await page.goto(`/calendar`);
    await expect(page.locator('.csum')).toContainText('open item');
    await shot(page, 'month-app');
    await page.goto(`/calendar?view=week&d=${today}`);
    await expect(page.locator('.csum')).toContainText('open item');
    await shot(page, 'week-app');
    await page.goto(`/calendar?view=day&d=${today}`);
    await expect(page.locator('.csum')).toContainText('open item');
    await shot(page, 'day-app');

    // Dashboard: Meetings today and Today's agenda from Arjun's own timed tasks; the Outlook event never shows.
    await page.goto('/');
    const agenda = page.getByRole('region', { name: "Today's agenda" });
    await expect(agenda.getByRole('listitem')).toHaveCount(1);
    await expect(agenda).toContainText('Call back about the proposal');
    await expect(agenda).not.toContainText('Pipeline review');
    await expect(page.locator('.tiles .tile').nth(2)).toContainText('Meetings today');
    await shot(page, 'dashboard-app');
    await page.goto(`/calendar?view=day&d=${today}`);
    await expect(page.locator('.csum')).toContainText('open item');

    // New follow-up, each type.
    await page.getByRole('button', { name: 'New follow-up' }).click();
    const dialog = page.getByRole('dialog', { name: 'New follow-up' });
    await expect(dialog).toBeVisible();
    await shot(page, 'new-followup-app');
    await dialog.getByRole('combobox', { name: /Lead/ }).click();
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await shot(page, 'new-followup-leads-app');
    await page.keyboard.press('Escape');
    await dialog.getByLabel('Type').selectOption('call');
    await shot(page, 'new-call-app');
    await dialog.getByLabel('Type').selectOption('meeting');
    await shot(page, 'new-meeting-app');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Info dialog: the Outlook event without a lead.
    await page.getByRole('button', { name: /Pipeline review/ }).click();
    await expect(page.getByRole('dialog', { name: 'Pipeline review' })).toBeVisible();
    await shot(page, 'info-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

    // Edit task with Type / Time on the Tasks page.
    await page.goto('/tasks');
    await page.getByRole('listitem').filter({ hasText: 'Call back about the proposal' }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible();
    await shot(page, 'edit-task-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await shot(page, 'tasks-app');

    // The lead timeline entry for the planned call.
    await page.goto(`/leads/${bluefin.id}`);
    await page.getByRole('tab', { name: /^Calls/ }).click();
    await expect(page.getByRole('list', { name: 'Activity timeline' })).toContainText('Call scheduled · Call back about the proposal');
    await shot(page, 'lead-timeline-app');

    // Everyone, as an administrator.
    await signInAs(page, MAYA);
    await page.goto('/calendar?who=all');
    await expect(page.locator('.csum')).toContainText('open item');
    await shot(page, 'everyone-app');
  } finally {
    cleanup();
  }
});

test('calendar parity: prototype side', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  const go = async (hash: string) => {
    await page.goto(`${PROTO}${hash}`);
    await page.waitForTimeout(500);
  };
  await go('#/dashboard');
  // Arjun (u1) is the demo user; give him a mailbox with calendar sync on, as the app side.
  await page.evaluate(() => {
    const S = (window as unknown as { Store: { db: { emailAccounts: Record<string, unknown>[] }; save(): void; setUser(id: string): void } }).Store;
    S.setUser('u1');
    S.db.emailAccounts.push({ id: 'EA-9', userId: 'u1', provider: 'microsoft', address: 'arjun.mehta@daitpartners.com', status: 'connected', syncMail: true, syncCalendar: true, sharedMailboxes: [] });
    S.save();
  });
  await go('#/dashboard');
  await shot(page, 'dashboard-proto');

  await go('#/calendar');
  await shot(page, 'month-proto');
  await go('#/calendar?view=week');
  await shot(page, 'week-proto');
  await go('#/calendar?view=day');
  await shot(page, 'day-proto');

  await page.locator('[data-act=newfu]').click();
  await shot(page, 'new-followup-proto');
  const leadBox = page.locator('.modal [role=combobox], .modal #fuLead').first();
  await leadBox.click();
  await shot(page, 'new-followup-leads-proto');
  await page.keyboard.press('Escape');
  if (!(await page.locator('.modal #fuType').isVisible())) await page.locator('[data-act=newfu]').click();
  await page.locator('.modal #fuType').selectOption('call');
  await shot(page, 'new-call-proto');
  await page.locator('.modal #fuType').selectOption('meeting');
  await shot(page, 'new-meeting-proto');
  // Plan a call on Northwind (LD-2041) for the lead timeline.
  await page.evaluate(() => {
    const sel = document.querySelector<HTMLSelectElement>('#fuLead')!;
    sel.value = 'LD-2041';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('.modal #fuType').selectOption('call');
  await page.locator('.modal #fuTitle').fill('Call back about the proposal');
  await page.locator('.modal #fuTime').fill('10:30');
  await page.locator('.modal [data-go]').click();
  await page.waitForTimeout(300);

  // The prototype's leadless event (Pipeline review) is Neha's; Everyone shows it.
  await go('#/calendar?view=week&who=all');
  await page.locator('[data-info="EV-5"]').first().click();
  await shot(page, 'info-proto');
  await page.keyboard.press('Escape');

  await go('#/tasks');
  await shot(page, 'tasks-proto');
  await go('#/leads/LD-2041/all');
  await shot(page, 'lead-timeline-proto');

  await page.evaluate(() => (window as unknown as { Store: { setUser(id: string): void } }).Store.setUser('u4'));
  await go('#/calendar?who=all');
  await shot(page, 'everyone-proto');
  await browser.close();
});
