import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { NEHA, signInAs } from '../fixtures';
import { PARITY_OUT } from './_shared';

/**
 * Prototype parity captures for release 3A (Quotations): writes `<screen>-app.png` and `<screen>-proto.png` pairs at
 * 1440×900 (full page) to PARITY_DIR, or e2e/parity/out. The app side signs in as Neha (Manager, seeded mailbox) and
 * builds one quotation per state on companies with unique names (Draft, Sent, Negotiating with revision 2 open,
 * Accepted, Rejected), sending through the fake Graph, then deletes the quotations again. The prototype side opens
 * prototype/index.html from disk in a fresh context.
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
/** Scrolls every table to its right edge so the last columns (the Leads tab's Quotation) are in the capture. */
const scrollTablesRight = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('.tbl').forEach((el) => (el.scrollLeft = el.scrollWidth)));
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
/** Runs the queued sends against the fake Microsoft Graph (apps/api/test/e2e-send-jobs.ts): the e2e server has no worker. */
const runSendJobs = () =>
  execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });

type Detail = { id: number; number: string; updatedAt: string; status: string; sending: boolean };
type Line = { item: string; description: string | null; qty: number; unit: string; unitPrice: number; discount: number };
const line = (item: string, description: string | null, qty: number, unit: string, unitPrice: number, discount = 0): Line => ({ item, description, qty, unit, unitPrice, discount });

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

test('quotations parity: app side', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(VIEWPORT);
  await signInAs(page, NEHA);
  const api = page.request;
  const me = await json<{ id: number }>(await api.get('/api/me'), 200);
  const tag = Date.now().toString(36).slice(-4).toUpperCase();
  const made: number[] = [];

  /** A lead (and its company) of Neha's with a contact who has an email address. */
  async function company(name: string, country: string, first: string, last: string, designation: string) {
    const lead = await json<{ id: number; number: string; companyId: number }>(
      await api.post('/api/leads', { data: { companyName: `${name} ${tag}`, country, leadSource: 'Referral', assignedToId: me.id } }), 201);
    const contact = await json<{ id: number }>(await api.post('/api/contacts', {
      data: { companyId: lead.companyId, firstName: first, lastName: last, designation, businessEmail: `${first.toLowerCase()}.${tag.toLowerCase()}@${name.split(' ')[0]!.toLowerCase()}.example` },
    }), 201);
    return { ...lead, contactId: contact.id };
  }
  async function quote(c: { companyId: number; id: number; contactId: number }, body: Record<string, unknown>): Promise<Detail> {
    const q = await json<Detail>(await api.post('/api/quotations', { data: { companyId: c.companyId, leadId: c.id } }), 201);
    made.push(q.id);
    return json<Detail>(await api.patch(`/api/quotations/${q.id}`, { data: { updatedAt: q.updatedAt, contactId: c.contactId, ...body } }), 200);
  }
  async function send(q: Detail): Promise<void> {
    await json(await api.post(`/api/quotations/${q.id}/send`, { data: {} }), 202);
    runSendJobs();
    await expect.poll(async () => (await json<Detail>(await api.get(`/api/quotations/${q.id}`), 200)).sending, { timeout: 15_000 }).toBe(false);
  }
  const fresh = async (q: Detail) => json<Detail>(await api.get(`/api/quotations/${q.id}`), 200);

  try {
    // Negotiating, revision 2 open (prototype Q-2026-041 · Sunrise Pharma).
    const sunrise = await company('Sunrise Pharma', 'India', 'Anil', 'Verma', 'CIO');
    const roadmap = await quote(sunrise, {
      subject: 'Digital transformation roadmap and ERP vendor selection – Hyderabad and Vizag plants',
      notes: 'Payment: 40% on acceptance, 40% at roadmap sign-off, 20% on vendor selection. Travel to Hyderabad and Vizag billed at cost.',
      lines: [
        line('Discovery & current-state assessment', '2 plants, 12 stakeholder interviews, systems inventory', 1, 'project', 12500),
        line('Transformation roadmap workshop series', '4 workshops, roadmap document, board presentation', 4, 'workshop', 4250, 10),
        line('ERP vendor selection & RFP management', 'Requirements, shortlist of 4 vendors, scoring, negotiation support', 1, 'project', 28000),
      ],
    });
    await send(roadmap);
    await json(await api.post(`/api/quotations/${roadmap.id}/negotiate`, { data: {} }), 200);
    const neg = await fresh(roadmap);
    await json(await api.patch(`/api/quotations/${roadmap.id}`, {
      data: { updatedAt: neg.updatedAt, lines: [
        line('Discovery & current-state assessment', '2 plants, 12 stakeholder interviews, systems inventory', 1, 'project', 12500),
        line('Transformation roadmap workshop series', '4 workshops, roadmap document, board presentation', 4, 'workshop', 4250, 10),
        line('ERP vendor selection & RFP management', 'Requirements, shortlist of 4 vendors, scoring, negotiation support', 1, 'project', 28000),
        line('Advisory retainer', 'Senior consultant, 2 days per month during implementation', 6, 'month', 2200),
      ] },
    }), 200);

    // Sent (prototype Q-2026-040 · Bluefin Marine).
    const bluefin = await company('Bluefin Marine', 'Canada', 'Tom', 'Delaney', 'COO');
    const inventory = await quote(bluefin, {
      subject: 'Inventory and procurement platform – implementation partner',
      lines: [line('Implementation partner selection', null, 1, 'project', 24000), line('Implementation oversight', null, 5, 'month', 6000)],
    });
    await send(inventory);

    // Accepted (prototype Q-2026-038 · Orbit Fintech).
    const orbit = await company('Orbit Fintech', 'United States', 'Lena', 'Fischer', 'CTO');
    const payments = await quote(orbit, { subject: 'Payments platform scaling programme', lines: [line('Scaling programme phase 1', null, 1, 'project', 48000)] });
    await send(payments);
    await json(await api.post(`/api/quotations/${payments.id}/accept`, { data: {} }), 200);

    // Draft (prototype Q-2026-029) and Rejected (prototype Q-2025-114).
    const harbor = await company('Harbor Logistics', 'India', 'Priya', 'Nair', 'Head of Operations');
    const wms = await quote(harbor, { subject: 'WMS selection advisory', validUntil: null, lines: [line('WMS selection advisory · 6 weeks', null, 1, 'project', 28400)] });
    const infra = await quote(harbor, { subject: 'IT infrastructure review', lines: [line('IT infrastructure review', null, 1, 'project', 19800)] });
    await send(infra);
    await json(await api.post(`/api/quotations/${infra.id}/reject`, { data: {} }), 200);

    // The list, each tab.
    for (const [tab, name] of [['', 'list-all'], ['draft', 'list-draft'], ['sent', 'list-sent'], ['accepted', 'list-accepted'], ['closed', 'list-closed']] as const) {
      await page.goto(`/quotations${tab ? `?tab=${tab}` : ''}`);
      await expect(page.locator('.tbl tbody tr').first()).toBeVisible();
      await shot(page, `${name}-app`);
    }

    // New quotation dialog (list).
    await page.goto('/quotations');
    await page.getByRole('button', { name: 'New quotation' }).click();
    await expect(page.getByRole('dialog', { name: 'New quotation' })).toBeVisible();
    await shot(page, 'new-quotation-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    // The editor in each state.
    const editor = async (q: Detail, name: string) => {
      await page.goto(`/quotations/${q.id}`);
      await expect(page.locator('.topbar h1')).toContainText(q.number);
      await expect(page.locator('.q-hist div').first()).toBeVisible();
      await shot(page, `${name}-app`);
    };
    await editor(wms, 'editor-draft');
    await editor(inventory, 'editor-sent');
    await editor(roadmap, 'editor-revision');
    await editor(payments, 'editor-accepted');
    await editor(infra, 'editor-rejected');

    // PDF preview dialog and the PDF itself (first page rendered with macOS sips, when there).
    await page.goto(`/quotations/${roadmap.id}`);
    await page.getByRole('button', { name: 'Preview PDF' }).click();
    await expect(page.getByRole('dialog', { name: /^Quotation / })).toBeVisible();
    await page.waitForTimeout(1000);
    await shot(page, 'pdf-preview-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    const pdf = await api.get(`/api/quotations/${roadmap.id}/pdf`);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'pdf-app.pdf'), await pdf.body());
    if (process.platform === 'darwin') {
      execFileSync('sips', ['-s', 'format', 'png', '-Z', '1400', join(OUT, 'pdf-app.pdf'), '--out', join(OUT, 'pdf-render-app.png')], { stdio: 'ignore' });
    }

    // Send dialog (the Sent quotation).
    await page.goto(`/quotations/${inventory.id}`);
    await page.getByRole('button', { name: 'Send by email' }).click();
    await expect(page.getByRole('dialog', { name: /^Send / })).toBeVisible();
    await shot(page, 'send-dialog-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    // Company page: header with New quotation, then the Leads tab with the Quotation column and Open quotation value.
    await page.goto(`/companies/${sunrise.companyId}`);
    await expect(page.getByRole('button', { name: 'New quotation' })).toBeVisible();
    await shot(page, 'company-app');
    await page.goto(`/companies/${sunrise.companyId}#leads`);
    await expect(page.getByRole('row').filter({ hasText: sunrise.number })).toContainText(roadmap.number);
    await scrollTablesRight(page);
    await shot(page, 'company-leads-app');

    // Dashboard: Quotes awaiting response.
    await page.goto('/');
    await expect(page.locator('.tiles .tile').filter({ hasText: 'Quotes awaiting response' })).toBeVisible();
    await shot(page, 'dashboard-app');

    // Settings → Company details beside another Settings tab (no prototype screen).
    await signInAs(page, 'maya.pillai@daitpartners.com');
    await page.goto('/settings/company');
    await expect(page.getByLabel(/^Legal name/)).toHaveValue(/./);
    await shot(page, 'settings-company-app');
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    await shot(page, 'settings-preferences-app');
    await page.goto('/settings/allocation');
    await page.waitForLoadState('networkidle');
    await shot(page, 'settings-allocation-app');

    // Email list with its pager, beside the Leads pager (owner request; the prototype has no pager).
    await signInAs(page, NEHA);
    await page.goto('/email');
    await page.waitForLoadState('networkidle');
    await shot(page, 'email-app');
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    await shot(page, 'leads-pager-app');
  } finally {
    if (made.length) sql(`delete from quotations where id in (${made.join(',')})`);
  }
});

test('quotations parity: prototype side', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  const go = async (hash: string) => {
    await page.goto(`${PROTO}${hash}`);
    await page.waitForTimeout(500);
  };
  for (const [tab, name] of [['', 'list-all'], ['draft', 'list-draft'], ['sent', 'list-sent'], ['accepted', 'list-accepted'], ['closed', 'list-closed']] as const) {
    await go(`#/quotes${tab ? `?tab=${tab}` : ''}`);
    await shot(page, `${name}-proto`);
  }
  await go('#/quotes/Q-2026-029');
  await shot(page, 'editor-draft-proto');
  await go('#/quotes/Q-2026-040');
  await shot(page, 'editor-sent-proto');
  await page.locator('[data-act=send]').click();
  await shot(page, 'send-dialog-proto');
  await page.keyboard.press('Escape');
  await go('#/quotes/Q-2026-041');
  await shot(page, 'editor-negotiating-proto');
  // Revision 2 editing: the first edit on the Sent quotation opens it.
  await go('#/quotes/Q-2026-040');
  await page.locator('[name=overallDiscount]').fill('5');
  await page.waitForTimeout(400);
  await go('#/quotes/Q-2026-040');
  await shot(page, 'editor-revision-proto');
  // Clears the "Revision 2 opened" toast before the next captures.
  await page.reload();
  await go('#/quotes/Q-2026-038');
  await shot(page, 'editor-accepted-proto');
  await go('#/quotes/Q-2025-114');
  await shot(page, 'editor-rejected-proto');
  await go('#/quotes/Q-2026-041');
  await page.locator('[data-act=pdf]').click();
  await shot(page, 'pdf-preview-proto');
  await page.keyboard.press('Escape');
  await go('#/companies/CO-0211');
  await shot(page, 'company-proto');
  await go('#/companies/CO-0211/leads');
  await scrollTablesRight(page);
  await shot(page, 'company-leads-proto');
  await go('#/dashboard');
  await shot(page, 'dashboard-proto');
  await go('#/email');
  await shot(page, 'email-proto');
  await go('#/leads');
  await shot(page, 'leads-pager-proto');
  // New quotation: the prototype creates one at once (no dialog) and opens it.
  await go('#/quotes/new');
  await page.waitForTimeout(500);
  await shot(page, 'new-quotation-proto');
  await browser.close();
});
