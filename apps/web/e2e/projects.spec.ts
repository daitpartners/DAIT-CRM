import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ARJUN, signInAs } from './fixtures';
import { captureParity } from './parity/_shared';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();

type Tiles = { active: number; clients: number; completedThisYear: number; onHold: number };

test('Projects: sidebar, create a project for a client from the list, edit it to On hold, tiles follow', async ({ page }) => {
  const company = `Projectco ${Date.now()}`;
  await signInAs(page, ARJUN);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string; companyId: number };
  const contact = await page.request.post('/api/contacts', {
    data: { companyId: lead.companyId, firstName: 'Ravi', lastName: 'Shah', designation: 'CFO', contactType: 'Decision Maker', businessEmail: `ravi.${Date.now()}@projectco.example` },
  });
  expect(contact.status()).toBe(201);
  // A client (a Won lead or an accepted quotation sets the flag; set directly here).
  sql(`update companies set is_client=true where id=${lead.companyId}`);
  const tilesNow = async () => ((await (await page.request.get('/api/projects')).json()) as { tiles: Tiles }).tiles;
  const before = await tilesNow();

  // Sidebar: Projects right after Quotations.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const links = await nav.getByRole('link').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\d+$/, '')));
  expect(links.indexOf('Projects')).toBe(links.indexOf('Quotations') + 1);
  await nav.getByRole('link', { name: /^Projects/ }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  await expect(page.getByText('Engagements won from leads. One client can have many projects, each from its own lead.')).toBeVisible();
  expect(await page.locator('.tiles .tile .l').allTextContents()).toEqual(['Active projects', 'Total value', 'Completed', 'On hold']);
  const tileValue = (label: string) => page.locator('.tiles .tile').filter({ has: page.locator('.l', { hasText: new RegExp(`^${label}$`) }) }).locator('.v');
  await expect(tileValue('Active projects')).toHaveText(String(before.active));

  // Create project: choose the client; the name, currency and the Decision Maker are filled in.
  await page.getByRole('button', { name: 'Create project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  await dialog.getByRole('combobox', { name: /Client/ }).fill(company);
  await dialog.getByRole('option', { name: `${company} · client` }).click();
  await expect(dialog.getByLabel(/Project name/)).toHaveValue(`${company} · `);
  await expect(dialog.getByLabel('Currency')).toHaveValue('INR');
  await expect(dialog.getByRole('checkbox', { name: /Ravi Shah · CFO/ })).toBeChecked();
  await dialog.getByLabel('From lead').selectOption(String(lead.id));
  await dialog.getByLabel(/Project name/).fill(`${company} · Advisory`);
  await dialog.getByLabel('Value').fill('250000');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText(/^PRJ-\d+ created · 1 stakeholders$/)).toBeVisible();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: `${company} · Advisory` });
  await expect(row).toContainText(lead.number);
  await expect(row).toContainText('INR 2,50,000');
  await expect(row).toContainText('Ravi Shah');
  await expect(row).toContainText('Arjun Mehta');
  await expect(row.locator('.badge')).toHaveText('Active');
  await expect(tileValue('Active projects')).toHaveText(String(before.active + 1));

  // Edit: the client is locked; status to On hold.
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit project' });
  await expect(edit.getByLabel(/Client/)).toBeDisabled();
  await expect(edit.getByRole('checkbox', { name: /Ravi Shah/ })).toBeChecked();
  await edit.getByLabel('Status').selectOption('On hold');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Project updated')).toBeVisible();
  await expect(row.locator('.badge')).toHaveText('On hold');
  await expect(tileValue('Active projects')).toHaveText(String(before.active));
  await expect(tileValue('On hold')).toHaveText(String(before.onHold + 1));

  // The filters live in the URL.
  await page.getByLabel('Status').selectOption('On hold');
  await expect(page).toHaveURL(/status=On\+hold/);
  await expect(row).toBeVisible();
  await page.getByRole('link', { name: '✕ Clear' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test('Convert an accepted quotation: the project at net value, on the list, the lead page card and the company Projects tab', async ({ page }) => {
  const company = `Convertco ${Date.now()}`;
  await signInAs(page, ARJUN);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string; companyId: number };
  const q = (await (await page.request.post('/api/quotations', { data: { companyId: lead.companyId, leadId: lead.id } })).json()) as { id: number; number: string };
  type Detail = { status: string; lines: { item: string }[]; project: { id: number; number: string; name: string } | null };
  const api = async () => (await (await page.request.get(`/api/quotations/${q.id}`)).json()) as Detail;

  // One line of 2 × 1,000 with 18 % GST: total 2,360, net 2,000.
  await page.goto(`/quotations/${q.id}`);
  const first = page.getByRole('row').nth(1);
  await first.getByRole('textbox', { name: 'Item' }).fill('Strategy workshop');
  await first.getByRole('spinbutton', { name: 'Qty' }).fill('2');
  await first.getByRole('spinbutton', { name: 'Unit price' }).fill('1000');
  await expect(page.locator('.totals')).toContainText('Total INR2,360.00');
  await expect.poll(async () => (await api()).lines.map((l) => l.item)).toEqual(['Strategy workshop']);
  await expect(page.getByRole('button', { name: 'Convert to project' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Mark accepted' }).click();
  await expect(page.locator('.topbar .badge').first()).toHaveText('Accepted');

  // Convert: the toast, then the editor shows the project instead of the button.
  await page.getByRole('button', { name: 'Convert to project' }).click();
  await expect(page.getByText(new RegExp(`^Project PRJ-\\d+ created from ${q.number}$`))).toBeVisible();
  const project = (await api()).project!;
  expect(project.name).toBe(`Advisory services for ${company}`);
  const link = page.getByRole('link', { name: `Project ${project.number}` });
  await expect(link).toHaveClass(/\bbadge b-ok\b/);
  await expect(link).toHaveAttribute('href', `/projects?company=${lead.companyId}`);
  await expect(page.getByRole('button', { name: 'Convert to project' })).toHaveCount(0);

  // The Projects list (filtered to the client): net value before GST, lead and quotation.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/projects\\?company=${lead.companyId}$`));
  const row = page.getByRole('row').filter({ hasText: project.number });
  await expect(row).toContainText(project.name);
  await expect(row).toContainText('INR 2,000');
  await expect(row).not.toContainText('2,360');
  await expect(row).toContainText(lead.number);
  await expect(row).toContainText(q.number);
  await expect(row).toContainText('Arjun Mehta');

  // Lead page: the Projects card lists it, highlighted as this lead's.
  await page.goto(`/leads/${lead.id}`);
  const card = page.getByRole('region', { name: /^Projects/ });
  await expect(card.getByRole('heading')).toHaveText('Projects 1');
  const item = card.getByRole('link', { name: new RegExp(project.name) });
  await expect(item).toContainText(`${project.number} · from ${lead.number} · INR 2,000 · Arjun Mehta`);
  await expect(item).toHaveClass(/pj-mine/);
  await expect(card.getByRole('button', { name: '+ Create project' })).toBeVisible();
  // Email form (Task 6): the client's projects, defaulting to the one from this lead.
  const emailForm = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
  await expect(emailForm.getByLabel('Project')).toBeEnabled();
  await expect(emailForm.getByLabel('Project')).toHaveValue(String(project.id));
  await emailForm.scrollIntoViewIfNeeded();
  await captureParity(page, 'lead-email-project');

  // Company profile: the Projects tab with its count and the row.
  await page.goto(`/companies/${lead.companyId}#projects`);
  await expect(page.getByRole('tab', { name: /^Projects/ })).toHaveText('Projects 1');
  await expect(page.getByRole('heading', { name: `Projects at ${company}` })).toBeVisible();
  const tabRow = page.getByRole('row').filter({ hasText: `${project.number} · ${q.number}` });
  await expect(tabRow).toContainText('INR 2,000.00');
  await expect(tabRow.getByRole('link', { name: lead.number })).toHaveAttribute('href', `/leads/${lead.id}`);
  await expect(page.getByRole('region', { name: 'How projects work' })).toBeVisible();

  // The row's Email button opens Compose preset with the client, lead and project; the filters keep the project.
  await tabRow.getByRole('link', { name: 'Email' }).click();
  const compose = page.getByRole('dialog', { name: 'Compose email' });
  await expect(compose.getByLabel('Project')).toHaveValue(String(project.id));
  await expect(compose.getByLabel('Lead')).toHaveValue(String(lead.id));
  await expect(compose.getByText(`${company} · ${lead.number} · ${project.name}`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/email\\?company=${lead.companyId}&lead=${lead.id}&project=${project.id}$`));
  await captureParity(page, 'compose-project');
});
