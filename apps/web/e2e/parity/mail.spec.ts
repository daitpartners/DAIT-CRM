import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test, type Page } from '@playwright/test';
import { NEHA, signInAs } from '../fixtures';
import { PARITY_OUT } from './_shared';

/**
 * Prototype parity captures for the mail releases (2B-2 Email screen, 2C Mailer, Do not email): writes
 * `<screen>-app.png` and `<screen>-proto.png` pairs at 1440×900 (full page) to PARITY_DIR, or e2e/parity/out.
 * The prototype side opens prototype/index.html from disk in a fresh context and seeds its store in the page.
 */
const OUT = process.env.PARITY_DIR ?? PARITY_OUT;
const VIEWPORT = { width: 1440, height: 900 };
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const PROTO = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../prototype/index.html')).href;

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();

test('mail parity: app side', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await signInAs(page, NEHA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  // Three more emailable leads of Neha's, so the campaign has a recipient per status.
  const extra: { co: string; contact: number; country: string }[] = [
    { co: 'CO-0211', contact: 6, country: 'India' }, { co: 'CO-0315', contact: 9, country: 'Germany' }, { co: 'CO-0301', contact: 4, country: 'Australia' },
  ];
  const numbers: string[] = [];
  for (const x of extra) {
    const [companyId, name] = sql(`select id||'|'||name from companies where number='${x.co}'`).split('|');
    const res = await page.request.post('/api/leads', {
      data: { companyName: name, country: x.country, leadSource: 'Referral', linkCompanyId: Number(companyId), contactId: x.contact, assignedToId: me.id, createCompany: false },
    });
    expect(res.status()).toBe(201);
    numbers.push(((await res.json()) as { number: string }).number);
  }
  const orbit = (await (await page.request.get('/api/leads?q=Orbit')).json()) as { items: { id: number; number: string; companyId: number }[] };
  const ob = orbit.items.find((l) => l.number === 'LD-1003')!;

  // 1. Email screen with Orbit's reply open.
  await page.goto('/email');
  await page.getByRole('region', { name: 'Message list' }).getByRole('link', { name: /Re: Orbit proposal/ }).click();
  await expect(page.getByRole('article', { name: 'Re: Orbit proposal' })).toBeVisible();
  await shot(page, 'email-app');

  // 2. Compose with a lead chosen.
  await page.goto(`/email?company=${ob.companyId}&lead=${ob.id}`);
  await page.getByRole('button', { name: '+ Compose' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot(page, 'compose-open-app');
  // The client picker takes focus and opens its list; close it to see the whole form.
  await page.getByRole('dialog').getByText('Compose email', { exact: true }).click();
  await shot(page, 'compose-app');
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();

  // 3. Link email to a lead.
  await page.goto('/email?folder=unlinked');
  await page.getByRole('region', { name: 'Message list' }).getByRole('link', { name: /Website enquiry/ }).click();
  await page.getByRole('article', { name: 'Website enquiry' }).getByRole('button', { name: 'Link to lead / create lead' }).click();
  await expect(page.getByRole('dialog', { name: 'Link email to a lead' })).toBeVisible();
  await shot(page, 'link-lead-app');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // 7. Edit profile with Do not email ticked, then the lead page with its badge.
  await page.goto(`/leads/${ob.id}`);
  await page.getByRole('button', { name: 'Edit profile' }).click();
  const edit = page.getByRole('dialog', { name: /^Edit profile/ });
  await shot(page, 'edit-profile-top-app');
  await edit.getByLabel('Do not email').check();
  await shot(page, 'edit-profile-dne-app');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('region', { name: 'Profile' }).getByText('Do not email')).toBeVisible();
  await shot(page, 'lead-dne-app');

  // 6b. Refusal toast: only the Do not email lead ticked.
  await page.goto('/leads');
  await page.getByRole('checkbox', { name: 'Select LD-1003 Orbit Fintech', exact: true }).check();
  await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Send via mailer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'None of the selected leads can be emailed' })).toBeVisible();
  await shot(page, 'mailer-refusal-app');

  // 6. The wizard, step by step (Orbit is skipped on the review step).
  await page.goto('/leads');
  for (const want of ['LD-1001', 'LD-1002', 'LD-1003', ...numbers]) {
    await page.getByRole('checkbox', { name: new RegExp(`^Select ${want} `) }).check();
  }
  await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Send via mailer' }).click();
  const wiz = page.getByRole('dialog', { name: 'Send via mailer' });
  await expect(wiz.getByText(/^Preview for /)).toBeVisible();
  await shot(page, 'wizard-1-template-app');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await shot(page, 'wizard-2-cc-app');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await shot(page, 'wizard-3-timing-app');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByLabel(/Lawful basis/).selectOption('Legitimate interest (B2B outreach relevant to their role)');
  await shot(page, 'wizard-4-review-app');
  await wiz.getByRole('button', { name: /^Queue \d emails?$/ }).click();
  await expect(page).toHaveURL(/\/mailer\/\d+$/);
  const campaignId = Number(new URL(page.url()).pathname.split('/').pop());

  // 5. Campaign paused by its sender, recipients in every status.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  const queued = sql(`select id from email_campaign_recipients where campaign_id=${campaignId} and status='Queued' order by position`).split('\n').map(Number);
  const sent = sql(`select id from email_messages where graph_id='e2e-1'`);
  sql(`update email_messages set message_id='<AAMkAGI2-e2e-1@daitpartners.com>' where id=${sent}`);
  sql(`update email_campaign_recipients set status='Sent', sent_at=now() - interval '20 minutes', email_message_id=${sent} where id=${queued[0]}`);
  sql(`update email_campaign_recipients set status='Sent', sent_at=now() - interval '17 minutes' where id=${queued[1]}`);
  sql(`update email_campaign_recipients set status='Failed', error='Mailbox rejected the address (550 5.1.1)' where id=${queued[2]}`);
  await page.reload();
  await expect(page.getByRole('table', { name: 'Recipients' })).toContainText('Failed');
  await shot(page, 'campaign-app');
  // The recipients table is wider than its card: scroll it to the end to see the last columns.
  await page.getByRole('table', { name: 'Recipients' }).evaluate((el) => {
    for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) if (n.scrollWidth > n.clientWidth) { n.scrollLeft = n.scrollWidth; break; }
  });
  await shot(page, 'campaign-scrolled-app');
  await page.goto('/mailer');
  await expect(page.getByRole('table', { name: 'Campaigns' })).toContainText('Paused');
  await shot(page, 'mailer-list-app');
});

test('mail parity: prototype side', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  const go = async (hash: string) => {
    await page.goto(`${PROTO}${hash}`);
    await page.waitForTimeout(500);
  };
  await go('#/dashboard');
  // Neha (u2) has the connected mailbox in the demo data.
  await page.evaluate(() => (window as unknown as { Store: { setUser(id: string): void } }).Store.setUser('u2'));

  await go('#/email/' + (await page.evaluate(() => {
    const db = (window as unknown as { Store: { db: { emails: { id: string; leadId?: string; folder: string; history?: unknown[] }[] } } }).Store.db;
    return (db.emails.find((e) => e.folder === 'inbox' && e.leadId && e.history?.length) ?? db.emails[0]!).id;
  })));
  await shot(page, 'email-proto');

  await go('#/email?folder=inbox&company=CO-0310&lead=LD-2036');
  await page.locator('[data-act=compose]').click();
  await shot(page, 'compose-proto');
  await page.keyboard.press('Escape');

  await go('#/email?folder=unlinked');
  await page.locator('.reader [data-act=link]').first().click();
  await shot(page, 'link-lead-proto');
  await page.keyboard.press('Escape');

  await go('#/leads/LD-2036');
  await page.locator('[data-act=editp]').first().click();
  await shot(page, 'edit-profile-top-proto');
  await page.locator('.modal label', { hasText: 'Do not email' }).locator('input').check();
  await shot(page, 'edit-profile-dne-proto');
  await page.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(400);
  await shot(page, 'lead-dne-proto');

  const tick = async (ids: string[]) => {
    for (const id of ids) await page.locator('tr', { has: page.locator(`a[href="#/leads/${id}"]`) }).locator('input[type=checkbox]').first().check();
  };
  await go('#/leads');
  await tick(['LD-2036']);
  await page.locator('[data-act=mailer]').click();
  await shot(page, 'mailer-refusal-proto');

  await go('#/leads');
  await tick(['LD-2041', 'LD-2039', 'LD-2036', 'LD-2035', 'LD-2033', 'LD-2038']);
  await page.locator('[data-act=mailer]').click();
  await shot(page, 'wizard-1-template-proto');
  await page.locator('[data-next]').click();
  await shot(page, 'wizard-2-cc-proto');
  await page.locator('[data-next]').click();
  await shot(page, 'wizard-3-timing-proto');
  await page.locator('[data-next]').click();
  await page.locator('#mwLaw').selectOption('Legitimate interest (B2B outreach relevant to their role)');
  await shot(page, 'wizard-4-review-proto');
  // Freeze the run as the app spec does: paused by its sender, recipients in every status.
  await page.locator('[data-next]').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    type R = { status: string; sentAt: string | null; messageId: string | null; error: string | null };
    const S = (window as unknown as { Store: { db: { campaigns: { id: string; status: string; pauseReason?: string; recipients: R[] }[] }; save(): void; now(): string } }).Store;
    const c = S.db.campaigns[0]!;
    c.status = 'Paused';
    c.pauseReason = 'Paused by Neha Kapoor';
    const q = c.recipients.filter((r) => r.status !== 'Skipped');
    q.forEach((r) => { r.status = 'Queued'; r.sentAt = null; r.messageId = null; r.error = null; });
    Object.assign(q[0]!, { status: 'Sent', sentAt: S.now(), messageId: 'E-1042' });
    Object.assign(q[1]!, { status: 'Sent', sentAt: S.now(), messageId: 'E-1043' });
    Object.assign(q[2]!, { status: 'Failed', error: 'Mailbox rejected the address (550 5.1.1)' });
    S.save();
  });
  const id = await page.evaluate(() => (window as unknown as { Store: { db: { campaigns: { id: string }[] } } }).Store.db.campaigns[0]!.id);
  await go(`#/mailer/${id}`);
  await shot(page, 'campaign-proto');
  await go('#/mailer');
  await shot(page, 'mailer-list-proto');
  await browser.close();
});
