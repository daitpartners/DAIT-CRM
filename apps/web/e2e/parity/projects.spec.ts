import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { NEHA, signInAs } from '../fixtures';
import { PARITY_OUT } from './_shared';

/**
 * Prototype parity captures for release 3B (Projects): writes `<screen>-app.png` and `<screen>-proto.png` pairs at
 * 1440×900 (full page) to PARITY_DIR, or e2e/parity/out. The app side signs in as Neha (Manager, seeded mailbox) and
 * builds the prototype's Orbit Fintech story on new companies with unique names: a client whose accepted quotation
 * was converted to a project (prototype CO-0310 · LD-2036 · Q-2026-038 · PRJ-1), a second client without projects
 * (the empty list) and a prospect that is not a client (prototype LD-2041, the Won confirmation). The projects,
 * quotation and tagged message are deleted again. The prototype side opens prototype/index.html from disk.
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
/** Scrolls every table to its right edge so the last columns (Quotation, Email / Edit) are in the capture. */
const scrollTablesRight = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('.tbl').forEach((el) => (el.scrollLeft = el.scrollWidth)));
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
/** Runs the queued sends against the fake Microsoft Graph (apps/api/test/e2e-send-jobs.ts): the e2e server has no worker. */
const runSendJobs = () =>
  execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}

test('projects parity: app side', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(VIEWPORT);
  await signInAs(page, NEHA);
  const api = page.request;
  const me = await json<{ id: number }>(await api.get('/api/me'), 200);
  const tag = Date.now().toString(36).slice(-4).toUpperCase();
  const quotes: number[] = [];
  const projects: number[] = [];
  let messageId: number | null = null;

  /** A lead (and its company) of Neha's with a contact who has an email address and is the lead's contact. */
  async function company(name: string, country: string, first: string, last: string, designation: string, contactType = 'Decision Maker') {
    const lead = await json<{ id: number; number: string; companyId: number }>(
      await api.post('/api/leads', { data: { companyName: `${name} ${tag}`, country, leadSource: 'Referral', assignedToId: me.id } }), 201);
    const contact = await json<{ id: number }>(await api.post('/api/contacts', {
      data: { companyId: lead.companyId, firstName: first, lastName: last, designation, contactType, businessEmail: `${first.toLowerCase()}.${tag.toLowerCase()}@${name.split(' ')[0]!.toLowerCase()}.example` },
    }), 201);
    sql(`update leads set contact_id=${contact.id} where id=${lead.id}`);
    return { ...lead, contactId: contact.id };
  }

  try {
    // Client with a converted quotation (prototype Orbit Fintech CO-0310 · LD-2036 · Q-2026-038 → PRJ-1).
    const orbit = await company('Orbit Fintech', 'United States', 'Lena', 'Fischer', 'CTO');
    let q = await json<{ id: number; number: string; updatedAt: string }>(await api.post('/api/quotations', { data: { companyId: orbit.companyId, leadId: orbit.id } }), 201);
    quotes.push(q.id);
    q = await json(await api.patch(`/api/quotations/${q.id}`, {
      data: { updatedAt: q.updatedAt, contactId: orbit.contactId, subject: 'Payments platform scaling programme', lines: [{ item: 'Scaling programme phase 1', description: null, qty: 1, unit: 'project', unitPrice: 48000, discount: 0 }] },
    }), 200);
    await json(await api.post(`/api/quotations/${q.id}/send`, { data: {} }), 202);
    runSendJobs();
    await expect.poll(async () => (await json<{ sending: boolean }>(await api.get(`/api/quotations/${q.id}`), 200)).sending, { timeout: 15_000 }).toBe(false);
    await json(await api.post(`/api/quotations/${q.id}/accept`, { data: {} }), 200);
    const project = await json<{ id: number; number: string }>(await api.post(`/api/quotations/${q.id}/convert`, { data: {} }), 201);
    projects.push(project.id);
    // The prototype's PRJ-1 has a description and a later start; a project mail like the prototype's E-5.
    sql(`update projects set description='Phase 1 of the scaling programme agreed in ${q.number}.' where id=${project.id}`);
    const box = sql(`select id from email_accounts where user_id=${me.id} and kind='personal'`);
    messageId = Number(sql(
      `insert into email_messages (user_id, account_id, contact_id, source, graph_id, folder, status, from_address, from_name, to_addresses, subject, body_text, thread_id, lead_id, company_id, project_id, is_read, occurred_at, created_at, updated_at)
       values (${me.id}, ${box}, ${orbit.contactId}, 'sync', 'e2e-prj-${tag}', 'inbox', 'received', 'lena.${tag.toLowerCase()}@orbit.example', 'Lena Fischer', '["neha.kapoor@daitpartners.com"]'::jsonb, 'Signed: ${q.number} accepted',
       E'Hi Neha,\\n\\nAttached the signed quotation. Looking forward to kick-off in December.\\n\\nLena', 'e2e-prj-conv-${tag}', ${orbit.id}, ${orbit.companyId}, ${project.id}, true, now(), now(), now()) returning id`,
    ).split('\n')[0]);

    // A second client without projects (the empty list) and a prospect that is not a client (prototype LD-2041).
    const zenith = await company('Zenith Retail', 'United States', 'Mark', 'Olsen', 'CEO');
    sql(`update companies set is_client=true where id=${zenith.companyId}`);
    const northwind = await company('Northwind Logistics', 'India', 'Priya', 'Raman', 'Head of Operations');

    // Projects list with data (sidebar included), and the empty list.
    await page.goto('/projects');
    await expect(page.getByRole('row').filter({ hasText: project.number })).toBeVisible();
    await shot(page, 'list-app');
    await scrollTablesRight(page);
    await shot(page, 'list-right-app');
    await page.goto(`/projects?company=${zenith.companyId}`);
    await expect(page.getByText('No projects yet. Mark a lead as Won or accept a quotation, then create the project.')).toBeVisible();
    await shot(page, 'list-empty-app');

    // Create project (blank, from the list) and Edit project (the converted one).
    await page.goto('/projects');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('dialog', { name: 'Create project' })).toBeVisible();
    await shot(page, 'create-blank-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('row').filter({ hasText: project.number }).getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit project' })).toBeVisible();
    await shot(page, 'edit-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    // Company: Projects tab, Create project preset with the client, Overview card.
    await page.goto(`/companies/${orbit.companyId}#projects`);
    await expect(page.getByRole('heading', { name: `Projects at Orbit Fintech ${tag}` })).toBeVisible();
    await shot(page, 'company-projects-app');
    await page.getByRole('button', { name: '+ Create project' }).click();
    await expect(page.getByRole('dialog', { name: 'Create project' })).toBeVisible();
    await shot(page, 'create-preset-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.goto(`/companies/${orbit.companyId}`);
    await expect(page.getByRole('region', { name: /^Projects/ })).toBeVisible();
    await shot(page, 'company-overview-app');

    // Lead page: client (Projects card, email form Project picker) and not a client.
    await page.goto(`/leads/${orbit.id}`);
    await expect(page.getByRole('region', { name: /^Projects/ }).getByRole('heading')).toHaveText('Projects 1');
    await shot(page, 'lead-client-app');
    await page.goto(`/leads/${northwind.id}`);
    await expect(page.getByRole('region', { name: /^Projects/ })).toContainText('Projects unlock when a lead at this company is marked');
    await shot(page, 'lead-not-client-app');

    // Won confirmation (Status select → Won; the prototype's select clicks its hidden stepper's Won).
    await page.getByLabel('Status', { exact: true }).selectOption('Won');
    await expect(page.getByRole('dialog', { name: `Mark ${northwind.number} as Won?` })).toBeVisible();
    await shot(page, 'won-dialog-app');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    // Quotation editor after Convert.
    await page.goto(`/quotations/${q.id}`);
    await expect(page.getByRole('link', { name: `Project ${project.number}` })).toBeVisible();
    await shot(page, 'quote-converted-app');

    // Compose with a project, then the Email Project filter.
    await page.goto(`/email?compose=1&company=${orbit.companyId}&lead=${orbit.id}&project=${project.id}`);
    await expect(page.getByRole('dialog', { name: 'Compose email' }).getByLabel('Project')).toHaveValue(String(project.id));
    await shot(page, 'compose-project-app');
    await page.goto(`/email?company=${orbit.companyId}&project=${project.id}`);
    await expect(page.getByText(`Signed: ${q.number} accepted`).first()).toBeVisible();
    await shot(page, 'email-project-app');
  } finally {
    if (messageId) sql(`delete from email_messages where id=${messageId}`);
    if (projects.length) sql(`delete from projects where id in (${projects.join(',')})`);
    if (quotes.length) sql(`delete from quotations where id in (${quotes.join(',')})`);
  }
});

test('projects parity: prototype side', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
  const go = async (hash: string) => {
    await page.goto(`${PROTO}${hash}`);
    await page.waitForTimeout(500);
  };
  await go('#/projects');
  await shot(page, 'list-proto');
  await scrollTablesRight(page);
  await shot(page, 'list-right-proto');
  // The prototype has one client (Orbit Fintech, with PRJ-1): the empty list is a status with no projects.
  await go('#/projects?status=Cancelled');
  await shot(page, 'list-empty-proto');
  await go('#/projects');
  await page.locator('[data-act=newproject]').click();
  await shot(page, 'create-blank-proto');
  await page.keyboard.press('Escape');
  await go('#/projects');
  await page.locator('[data-edit="PRJ-1"]').click();
  await shot(page, 'edit-proto');
  await page.keyboard.press('Escape');
  await go('#/companies/CO-0310/projects');
  await shot(page, 'company-projects-proto');
  await page.getByRole('button', { name: '+ Create project' }).click();
  await shot(page, 'create-preset-proto');
  await page.keyboard.press('Escape');
  await go('#/companies/CO-0310');
  await shot(page, 'company-overview-proto');
  await go('#/leads/LD-2036');
  await shot(page, 'lead-client-proto');
  await go('#/leads/LD-2041');
  await shot(page, 'lead-not-client-proto');
  // Won confirmation: it lives on the prototype's base lead page (V.leadDetail, with the status stepper), which this
  // layout wraps; render that page for LD-2041 and click the stepper's Won.
  await page.evaluate(() => {
    const w = window as unknown as { V: { leadDetail: (id: string, tab: string) => { html: string; mount: (el: HTMLElement) => void } } };
    const v = w.V.leadDetail('LD-2041', 'email');
    const el = document.getElementById('view')!;
    el.innerHTML = v.html;
    v.mount(el);
    (el.querySelector('[data-stage=Won]') as HTMLElement).click();
  });
  await shot(page, 'won-dialog-proto');
  await go('#/quotes/Q-2026-038');
  await shot(page, 'quote-converted-proto');
  await go('#/email?compose=1&company=CO-0310&lead=LD-2036&project=PRJ-1');
  await page.waitForTimeout(300);
  await shot(page, 'compose-project-proto');
  await page.keyboard.press('Escape');
  await go('#/email?company=CO-0310&project=PRJ-1');
  await shot(page, 'email-project-proto');
  // The page's own Status select (a search combo over a hidden <select>) has no stepper to hand over to, so picking
  // "Won" there marks the lead Won at once (toast "LD-2041 won · client created"). Last, as it changes the data.
  await go('#/leads/LD-2041');
  await page.locator('[name=status]').evaluate((el: HTMLSelectElement) => {
    el.value = 'Won';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await shot(page, 'won-select-proto');
  await browser.close();
});
