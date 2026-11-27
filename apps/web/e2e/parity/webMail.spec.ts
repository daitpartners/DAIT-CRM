import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test, type Page } from '@playwright/test';
import { MAYA, NEHA, signInAs } from '../fixtures';
import { PARITY_OUT } from './_shared';

/**
 * Web-mail release 2 parity captures (Task 18): mockup states 1 (Inbox and reading), 4 (right-click menu, Move to ▸)
 * and 5 (administrator team view) at 1440×900 and 1280×800, the app in en, es and fr and the mockup in English, as
 * `state<n>-<w>-<lang>-app.png` and `state<n>-<w>-mockup.png` in PARITY_DIR (or e2e/parity/out).
 *
 * Skipped unless PARITY_WEB_MAIL=1. beforeAll adds mockup-like lead mail through psql: leads and contacts for Neha and
 * Maya (made through the API), Neha's eight conversations over Today, Yesterday and Last week (one HTML message with a
 * PDF and a spreadsheet, graph id `parity-att-…`, which the e2e fake Graph answers with two attachments), flags and
 * unread rows, and Maya's own lead mail for the team view. Every message's graph id starts `parity-`; afterAll deletes
 * them, puts the seeded messages it set aside back in their folders and sets both users' language back to English.
 */
const RUN = process.env.PARITY_WEB_MAIL === '1';
const OUT = process.env.PARITY_DIR ?? PARITY_OUT;
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCKUP_FILE = resolve(HERE, '../../../../docs/superpowers/mockups/2026-11-26-outlook-mail.html');
const MOCKUP = pathToFileURL(MOCKUP_FILE).href;
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }] as const;
const LANGS = ['en', 'es', 'fr'] as const;

const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const lit = (s: string) => `$q$${s}$q$`;

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

/** The mockup's own HTML email (Acme's RFP), so the app frame shows the same message. */
function acmeHtml(): string {
  const src = readFileSync(MOCKUP_FILE, 'utf8');
  const start = src.indexOf('<script type="text/html" id="emailAcme">');
  const body = src.slice(start).replace(/^<script[^>]*>/, '');
  return body.slice(0, body.indexOf('</script>'));
}

type LeadSpec = { key: string; company: string; site: string; city: string; country: string; status: string; first: string; last: string; role: string; email: string; phone: string; followUp: number | null; owner: 'neha' | 'maya' };
const LEADS: LeadSpec[] = [
  { key: 'acme', company: 'Acme Logistics', site: 'https://acme-logistics.com', city: 'Chicago', country: 'United States', status: 'Contacted', first: 'Maria', last: 'Gómez', role: 'Procurement Manager', email: 'maria.gomez@acme-logistics.com', phone: '+1 (312) 555-0148', followUp: 0, owner: 'neha' },
  { key: 'northwind', company: 'Northwind Health', site: 'https://northwind-health.com', city: 'Boston', country: 'United States', status: 'Proposal Sent', first: 'James', last: 'Whitaker', role: 'Head of Digital Products', email: 'james.whitaker@northwind-health.com', phone: '+1 (617) 555-0190', followUp: 1, owner: 'neha' },
  { key: 'brightline', company: 'Brightline Solar', site: 'https://brightline-solar.ca', city: 'Toronto', country: 'Canada', status: 'Qualified', first: 'Priya', last: 'Raman', role: 'Marketing Director', email: 'priya.raman@brightline-solar.ca', phone: '+1 (416) 555-0122', followUp: 0, owner: 'neha' },
  { key: 'cedar', company: 'Cedar & Pine Furniture', site: 'https://cedarandpine.com', city: 'Portland', country: 'United States', status: 'New', first: 'Tom', last: 'Becker', role: 'Owner', email: 'tom@cedarandpine.com', phone: '+1 (503) 555-0177', followUp: 3, owner: 'neha' },
  { key: 'harbor', company: 'Harbor Freightways', site: 'https://harborfreightways.com', city: 'Seattle', country: 'United States', status: 'Negotiation', first: 'Laura', last: 'Chen', role: 'Finance Director', email: 'laura.chen@harborfreightways.com', phone: '+1 (206) 555-0161', followUp: 1, owner: 'neha' },
  { key: 'summit', company: 'Summit Dental Group', site: 'https://summitdental.com', city: 'Phoenix', country: 'United States', status: 'Qualified', first: 'Daniel', last: 'Okafor', role: 'Practice Manager', email: 'daniel.okafor@summitdental.com', phone: '+1 (602) 555-0110', followUp: 7, owner: 'neha' },
  { key: 'pinecrest', company: 'Pinecrest Realty', site: 'https://pinecrestrealty.ca', city: 'Vancouver', country: 'Canada', status: 'Won', first: 'Michael', last: 'Grant', role: 'Managing Broker', email: 'michael.grant@pinecrestrealty.ca', phone: '+1 (604) 555-0133', followUp: null, owner: 'neha' },
  { key: 'lakeside', company: 'Lakeside Foods', site: 'https://lakesidefoods.com', city: 'Madison', country: 'United States', status: 'Contacted', first: 'Sarah', last: 'Kim', role: 'Digital Lead', email: 'sarah.kim@lakesidefoods.com', phone: '+1 (608) 555-0105', followUp: 5, owner: 'neha' },
  { key: 'levante', company: 'Construcciones Levante', site: 'https://construcciones-levante.es', city: 'Valencia', country: 'Spain', status: 'Proposal Sent', first: 'Lucía', last: 'Fernández', role: 'Directora de Marketing', email: 'lucia.fernandez@construcciones-levante.es', phone: '+34 960 555 214', followUp: 4, owner: 'maya' },
  { key: 'molina', company: 'Molina Arquitectos', site: 'https://molina-arquitectos.es', city: 'Sevilla', country: 'Spain', status: 'Contacted', first: 'Andrés', last: 'Molina', role: 'Socio director', email: 'andres@molina-arquitectos.es', phone: '+34 954 555 300', followUp: 2, owner: 'maya' },
];

/** One message: `at` is an SQL timestamp expression; `att` marks the HTML message with two attachments. */
type Msg = { lead: string; thread: string; subject: string; text: string; at: string; sent?: boolean; unread?: boolean; flag?: boolean; html?: boolean; att?: boolean; owner?: 'neha' | 'maya' };
const today = (h: number, m: number) => `least(now() - interval '1 minute' * ${h * 60 + m}, now())`;
const dayAgo = (days: number, hh: number, mm: number) => `date_trunc('day', now()) - interval '${days} days' + interval '${hh} hours ${mm} minutes'`;

const MESSAGES: Msg[] = [
  // Acme: three messages, the newest an HTML RFP with a PDF and a spreadsheet.
  { lead: 'acme', thread: 'acme', subject: 'RFP-2026-118: Website & customer portal redesign', sent: true, at: dayAgo(8, 10, 12), text: 'Hi Maria,\n\nGreat speaking with you on Tuesday. As promised, here is a short overview of how we would approach the redesign:\n\n• Two-week discovery with your operations and sales teams\n• New marketing site in English and Spanish\n• A simpler shipment-tracking flow in the customer portal\n\nHappy to answer any questions before you send the RFP.\n\nBest regards,\nNeha Kapoor\nDAIT Partners' },
  { lead: 'acme', thread: 'acme', subject: 'RE: RFP-2026-118: Website & customer portal redesign', at: dayAgo(6, 16, 40), text: 'Thanks Neha.\n\nI have shared this with Robert (Head of Digital). We will send the formal RFP early next week through our supplier portal.\n\nRegards,\nMaria' },
  { lead: 'acme', thread: 'acme', subject: 'RFP-2026-118: Website & customer portal redesign', at: today(0, 4), html: true, att: true, text: 'Please find attached our formal RFP and the pricing sheet. Proposals are due 11 Dec 2026.' },
  { lead: 'northwind', thread: 'northwind', subject: 'Re: Discovery call notes and next steps', sent: true, at: dayAgo(2, 15, 10), text: 'Hi James, here are my notes from our call and the next steps we agreed.' },
  { lead: 'northwind', thread: 'northwind', subject: 'Re: Discovery call notes and next steps', at: today(0, 20), unread: true, flag: true, text: 'Thanks Neha, the notes look right. Our CTO would like to see two examples of patient portals you have delivered.' },
  { lead: 'brightline', thread: 'brightline', subject: 'Brand refresh — budget question', at: today(0, 40), unread: true, text: 'Hi Neha, before we go to the board, could you split the estimate into brand and website work?' },
  { lead: 'cedar', thread: 'cedar', subject: 'Website audit for Cedar & Pine', sent: true, at: today(1, 10), text: 'Hi Tom, the audit is ready. Shall we go through it this week?' },
  { lead: 'cedar', thread: 'cedar', subject: 'Automatic reply: Website audit for Cedar & Pine', at: today(1, 0), text: 'I am out of the office until 30 Nov 2026 with limited access to email.' },
  { lead: 'harbor', thread: 'harbor', subject: 'Re: Quotation Q-2026-041', at: dayAgo(1, 17, 46), text: 'We are aligned on scope. Finance asked whether the maintenance plan can be billed quarterly.' },
  { lead: 'harbor', thread: 'harbor', subject: 'Re: Quotation Q-2026-041', sent: true, at: dayAgo(1, 18, 5), text: 'Yes, quarterly billing works for us. I will send the updated quotation tomorrow.' },
  { lead: 'summit', thread: 'summit', subject: "Can we move Thursday's meeting?", at: dayAgo(1, 9, 15), flag: true, text: 'Something came up on our side. Would Friday 4 Dec at 10:00 ET work instead?' },
  { lead: 'pinecrest', thread: 'pinecrest', subject: 'Re: Website maintenance plan', at: dayAgo(7, 11, 30), text: 'Signed copy attached. Looking forward to the kick-off in January.' },
  { lead: 'lakeside', thread: 'lakeside', subject: 'Introduction: Lakeside Foods digital team', at: dayAgo(8, 14, 20), text: 'Hi Neha, Robert passed on your details. We are planning a new ordering site for our wholesale customers.' },
  // Maya's own mailbox (the team view's second mailbox).
  { owner: 'maya', lead: 'levante', thread: 'levante', subject: 'Re: Propuesta de rediseño web', at: today(0, 2), unread: true, text: 'Gracias por la propuesta. La hemos revisado con dirección y nos encaja el enfoque por fases.' },
  { owner: 'maya', lead: 'molina', thread: 'molina', subject: 'Consulta sobre plazos de entrega', at: today(0, 50), unread: true, text: '¿Podríais tener la nueva web lista antes de Semana Santa?' },
];

const SET_ASIDE = 'parity-set-aside';

test.describe('web-mail release 2 parity', () => {
  test.skip(!RUN, 'Parity captures run only with PARITY_WEB_MAIL=1');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const ids = Object.fromEntries(sql(`select email||'|'||id from users where email in ('${NEHA}','${MAYA}')`).split('\n').map((r) => r.split('|'))) as Record<string, string>;
    const userId = { neha: Number(ids[NEHA]), maya: Number(ids[MAYA]) };
    const account = { neha: Number(sql(`select id from email_accounts where user_id=${userId.neha} and kind='personal'`)), maya: Number(sql(`select id from email_accounts where user_id=${userId.maya} and kind='personal'`)) };
    const address = { neha: NEHA, maya: MAYA };

    // The seeded e2e messages leave the lists for the capture (their folder is kept in last_error and put back afterwards).
    sql(`update email_messages set last_error = '${SET_ASIDE}:' || folder, folder = 'parity-hidden' where graph_id like 'e2e-%'`);

    await signInAs(page, MAYA);
    const leadIds: Record<string, { lead: number; contact: number; company: number }> = {};
    for (const l of LEADS) {
      const res = await page.request.post('/api/leads', {
        data: { companyName: l.company, website: l.site, country: l.country, city: l.city, leadSource: 'Website form', status: l.status, assignedToId: userId[l.owner], createCompany: true },
      });
      expect(res.status(), await res.text()).toBe(201);
      const lead = (await res.json()) as { id: number; companyId: number };
      const c = await page.request.post('/api/contacts', {
        data: { companyId: lead.companyId, firstName: l.first, lastName: l.last, designation: l.role, businessEmail: l.email, phone: l.phone, isPrimary: true },
      });
      expect(c.status(), await c.text()).toBe(201);
      const contact = (await c.json()) as { id: number };
      const fu = l.followUp === null ? 'null' : `current_date + ${l.followUp}`;
      sql(`update leads set contact_id=${contact.id}, next_follow_up=${fu} where id=${lead.id}`);
      leadIds[l.key] = { lead: lead.id, contact: contact.id, company: lead.companyId };
    }
    await page.close();

    const html = acmeHtml();
    MESSAGES.forEach((m, i) => {
      const who = m.owner ?? 'neha';
      const l = LEADS.find((x) => x.key === m.lead)!;
      const ref = leadIds[m.lead]!;
      const from = m.sent ? address[who] : l.email;
      const fromName = m.sent ? null : `${l.first} ${l.last}`;
      const to = m.sent ? l.email : address[who];
      const graphId = m.att ? `parity-att-${i}` : `parity-${i}`;
      sql(`insert into email_messages (user_id, account_id, lead_id, contact_id, company_id, folder, status, from_address, from_name, to_addresses, cc_addresses, subject, body_text, body_html,
             is_read, occurred_at, updated_at, source, graph_id, thread_id, flag_status, attachment_names, size_bytes)
           values (${userId[who]}, ${account[who]}, ${ref.lead}, ${ref.contact}, ${ref.company}, '${m.sent ? 'sent' : 'inbox'}', '${m.sent ? 'sent' : 'received'}',
             ${lit(from)}, ${fromName ? lit(fromName) : 'null'}, '[${JSON.stringify(to)}]'::jsonb, '${m.html ? '["robert.hayes@acme-logistics.com"]' : '[]'}'::jsonb, ${lit(m.subject)}, ${lit(m.text)},
             ${m.html ? lit(html) : 'null'}, ${m.unread ? 'false' : 'true'}, ${m.at}, now(), 'sync', '${graphId}', 'parity-${who}-${m.thread}',
             '${m.flag ? 'flagged' : 'notFlagged'}', '${m.att ? '["Acme_RFP-2026-118_Website-Portal.pdf","RFP-2026-118_Pricing-Sheet.xlsx"]' : '[]'}'::jsonb, ${m.att ? 2_600_000 : 24_000})`);
    });
  });

  test.afterAll(async ({ browser }) => {
    sql(`delete from email_messages where graph_id like 'parity-%'`);
    sql(`update email_messages set folder = substr(last_error, ${SET_ASIDE.length + 2}), last_error = null where last_error like '${SET_ASIDE}:%'`);
    const page = await browser.newPage();
    for (const who of [NEHA, MAYA]) {
      await signInAs(page, who);
      await setLanguage(page, 'en');
    }
    await page.close();
  });

  const list = (page: Page) => page.locator('section.msglist');
  const row = (page: Page, subject: string) => list(page).locator('.mrow').filter({ hasText: subject }).first();
  const reader = (page: Page) => page.locator('section.rpane');

  async function openAcme(page: Page): Promise<void> {
    await row(page, 'RFP-2026-118').click();
    await expect(reader(page).locator('.att').first()).toBeVisible();
    const frame = page.frameLocator('iframe.canvas').first();
    await expect(frame.getByText('Thank you for your interest in working with Acme Logistics.', { exact: false })).toBeVisible();
  }

  for (const lang of LANGS) {
    test(`app: states 1, 4 and 5 in ${lang}`, async ({ page }) => {
      test.setTimeout(180_000);
      for (const vp of VIEWPORTS) {
        // Opening a row (state 4) marks it read: the unread rows start unread in every capture.
        sql(`update email_messages set is_read = true where graph_id like 'parity-%'`);
        sql(`update email_messages set is_read = false where graph_id in (${MESSAGES.map((m, i) => (m.unread ? `'${m.att ? 'parity-att-' : 'parity-'}${i}'` : '')).filter(Boolean).join(',')})`);
        await page.setViewportSize(vp);
        // State 1: Neha, Inbox, the HTML conversation open, the third row hovered (as the mockup).
        await signInAs(page, NEHA);
        await setLanguage(page, lang);
        await page.goto('/email?folder=inbox');
        await openAcme(page);
        await row(page, 'Brand refresh').hover();
        await shot(page, `state1-${vp.width}-${lang}-app`);
        if (lang === 'en' && vp.width === 1440) await checkFrameRefits(page);

        // State 4: the second row open (as the mockup's state 4), right-click it, hover Move to.
        const second = list(page).locator('.mrow').nth(1);
        await second.click();
        await expect(reader(page).getByRole('heading', { level: 2 })).toContainText('Discovery call notes');
        await page.mouse.move(0, 0);
        const box = (await second.boundingBox())!;
        await page.mouse.click(box.x + 150, box.y + 30, { button: 'right' });
        const menu = page.locator('[role="menu"]').first();
        await expect(menu).toBeVisible();
        await menu.getByRole('menuitem').nth(await moveIndex(page)).hover();
        await page.waitForTimeout(300);
        await shot(page, `state4-${vp.width}-${lang}-app`);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        // State 5: Maya (Administrator), Mail of: Everyone, Neha's HTML conversation open (view only).
        await signInAs(page, MAYA);
        await setLanguage(page, lang);
        await page.goto('/email?folder=inbox&mailof=all');
        await openAcme(page);
        await page.mouse.move(0, 0);
        await shot(page, `state5-${vp.width}-${lang}-app`);
      }
    });
  }

  test('mockup: states 1, 4 and 5', async () => {
    test.setTimeout(120_000);
    const b = await chromium.launch();
    for (const vp of VIEWPORTS) {
      const page = await (await b.newContext({ viewport: vp })).newPage();
      for (const n of [1, 4, 5]) {
        await page.goto(`${MOCKUP}#s=${n}`);
        await page.reload();
        await page.waitForTimeout(800);
        await shot(page, `state${n}-${vp.width}-mockup`);
      }
      await page.close();
    }
    await b.close();
  });
});

/**
 * Carried check (T16): folding the lead panel widens the HTML frame and unfolding narrows it again; each time the frame
 * takes its content's new height (no inner scrollbar, no cut-off) and the content fits its width.
 */
async function checkFrameRefits(page: Page): Promise<void> {
  const frame = page.locator('iframe.canvas').first();
  const body = page.frameLocator('iframe.canvas').first().locator('html');
  const fits = async () => {
    await page.waitForTimeout(400); // the panel's width transition (.15s)
    await expect.poll(async () => {
      const box = (await frame.boundingBox())!;
      const [h, sw, cw] = await body.evaluate((el) => [el.scrollHeight, el.scrollWidth, el.clientWidth]);
      return Math.abs(box.height - h) <= 2 && sw <= cw;
    }).toBe(true);
    return (await frame.boundingBox())!.width;
  };
  const open = await fits();
  await page.getByRole('button', { name: 'Collapse lead panel' }).click();
  const folded = await fits();
  expect(folded).toBeGreaterThan(open + 100);
  await page.getByRole('button', { name: 'Expand lead panel' }).first().click();
  expect(Math.abs((await fits()) - open)).toBeLessThanOrEqual(2);
}

/** Sets the signed-in user's language (PATCH /api/me/preferences takes the whole set, so the rest is kept). */
async function setLanguage(page: Page, language: string): Promise<void> {
  const me = (await (await page.request.get('/api/me')).json()) as { timezone: string; dateFormat: string };
  const res = await page.request.patch('/api/me/preferences', { data: { language, timezone: me.timezone, dateFormat: me.dateFormat } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** The index of the "Move to" item in the open row menu (its label is translated). */
async function moveIndex(page: Page): Promise<number> {
  const items = page.locator('[role="menu"]').first().getByRole('menuitem');
  const n = await items.count();
  for (let i = 0; i < n; i++) if ((await items.nth(i).getAttribute('aria-haspopup')) !== null) {
    const text = (await items.nth(i).innerText()).trim();
    if (/Move|Mover|Déplacer/i.test(text)) return i;
  }
  throw new Error('Move to not found in the row menu');
}
