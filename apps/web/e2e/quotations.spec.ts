import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, NEHA, signInAs } from './fixtures';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
/** Runs the queued sends against the fake Microsoft Graph (apps/api/test/e2e-send-jobs.ts): the e2e server has no worker. */
const runSendJobs = () =>
  execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });

test('Quotations list: sidebar, tiles and tabs; New quotation from the list and from the company page; dashboard tile', async ({ page }) => {
  const company = `Quoteco ${Date.now()}`;
  await signInAs(page, ARJUN);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string; companyId: number };

  // Sidebar: Quotations right after Calendar.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const links = await nav.getByRole('link').allTextContents();
  expect(links.indexOf('Quotations')).toBe(links.indexOf('Calendar') + 1);
  await nav.getByRole('link', { name: 'Quotations' }).click();
  await expect(page).toHaveURL(/\/quotations$/);
  await expect(page.getByRole('heading', { name: 'Quotations', level: 1 })).toBeVisible();
  await expect(page.getByText('Every quotation links to a lead, company and contact. Revisions keep previous versions.')).toBeVisible();
  expect(await page.locator('.tiles .tile .l').allTextContents()).toEqual(['Open value (sent + negotiating)', 'Accepted', 'Expiring within 7 days', 'Win rate']);
  const tabs = await page.getByRole('tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s*\d+$/, '').trim()));
  expect(tabs).toEqual(['All', 'Draft', 'Sent / Negotiating', 'Accepted', 'Rejected / Expired']);

  // New quotation from the list: company, then its lead.
  await page.getByRole('button', { name: 'New quotation' }).click();
  const dialog = page.getByRole('dialog', { name: 'New quotation' });
  await dialog.getByRole('combobox', { name: /Company/ }).fill(company);
  await dialog.getByRole('option', { name: new RegExp(company) }).click();
  await expect(dialog.getByLabel('Lead').locator('option', { hasText: lead.number })).toHaveCount(1);
  await dialog.getByLabel('Lead').selectOption(String(lead.id));
  await dialog.getByRole('button', { name: 'Create quotation' }).click();
  await expect(page).toHaveURL(/\/quotations\/\d+$/);
  const first = Number(page.url().split('/').pop());
  const detail = (await (await page.request.get(`/api/quotations/${first}`)).json()) as { number: string; lead: { id: number } | null };
  expect(detail.lead?.id).toBe(lead.id);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${detail.number} · ${company}`);

  // Back on the list: the Draft row, the Draft tab and the search.
  await page.goto('/quotations');
  const row = page.getByRole('row').filter({ hasText: detail.number });
  await expect(row).toContainText(company);
  await expect(row).toContainText(lead.number);
  await expect(row).toContainText('INR 0.00');
  await expect(row).toContainText('rev 1');
  await expect(row.locator('.badge')).toHaveText('Draft');
  await expect(row.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/quotations/${first}`);
  await page.getByRole('tab', { name: /^Accepted/ }).click();
  await expect(page).toHaveURL(/tab=accepted/);
  await expect(page.getByRole('row').filter({ hasText: detail.number })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Draft/ }).click();
  await expect(page.getByRole('row').filter({ hasText: detail.number })).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search quotations' }).fill('no-such-quotation-zz');
  await expect(page.getByText('No quotations.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search quotations' }).fill(company);
  await expect(page.getByRole('row').filter({ hasText: detail.number })).toHaveCount(1);

  // The company page's New quotation: created for that company with its lead, then opened.
  await page.goto(`/companies/${lead.companyId}`);
  await page.getByRole('button', { name: 'New quotation' }).click();
  await expect(page).toHaveURL(/\/quotations\/\d+$/);
  const second = Number(page.url().split('/').pop());
  expect(second).not.toBe(first);
  const fromCompany = (await (await page.request.get(`/api/quotations/${second}`)).json()) as { company: { id: number }; lead: { id: number } | null };
  expect(fromCompany.company.id).toBe(lead.companyId);
  expect(fromCompany.lead?.id).toBe(lead.id);

  // The company's Leads tab lists both against the lead.
  await page.goto(`/companies/${lead.companyId}#leads`);
  await expect(page.getByRole('row').filter({ hasText: lead.number })).toContainText(`${detail.number} · Draft`);

  // Dashboard: one of Arjun's quotations awaiting a response (marked Sent here; sending is the editor's job).
  sql(`update quotations set status='Sent' where id=${first}`);
  try {
    await page.goto('/');
    const tile = page.locator('.tiles .tile').filter({ hasText: 'Quotes awaiting response' });
    await expect(tile).toHaveAttribute('href', '/quotations');
    await expect(tile.locator('.v')).toHaveText('1');
    await expect(tile.locator('.m')).toHaveText('INR 0.00');
  } finally {
    sql(`delete from quotations where id in (${first}, ${second})`);
  }
});

test('Quotation editor: lines and live totals, send (fake Graph), revision, accept → lead Won, Preview PDF, Duplicate', async ({ page }) => {
  test.setTimeout(90_000);
  const company = `Editorco ${Date.now()}`;
  await signInAs(page, NEHA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string; companyId: number };
  const contact = await page.request.post('/api/contacts', {
    data: { companyId: lead.companyId, firstName: 'Ravi', lastName: 'Shah', designation: 'CFO', businessEmail: `ravi.${Date.now()}@editorco.example` },
  });
  expect(contact.status()).toBe(201);
  const ravi = (await contact.json()) as { id: number; businessEmail: string };
  const q = (await (await page.request.post('/api/quotations', { data: { companyId: lead.companyId, leadId: lead.id } })).json()) as { id: number; number: string };
  const api = async () => (await (await page.request.get(`/api/quotations/${q.id}`)).json()) as {
    status: string; revision: number; editingNewRevision: boolean; currency: string; taxRate: number; contact: { id: number } | null;
    lines: { item: string; qty: number; unitPrice: number }[];
  };

  await page.goto(`/quotations/${q.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${q.number} · ${company}`);
  const topbar = page.locator('.topbar');
  await expect(topbar.locator('.badge')).toHaveText(['Draft', 'Revision 1']);
  await expect(topbar.locator('.sub')).toContainText(`Lead ${lead.number}`);

  // Contact, lines and live totals; every change saves itself.
  await page.getByLabel('Contact', { exact: true }).selectOption(String(ravi.id));
  const first = page.getByRole('row').nth(1);
  await first.getByRole('textbox', { name: 'Item' }).fill('Strategy workshop');
  await first.getByRole('spinbutton', { name: 'Qty' }).fill('2');
  await first.getByRole('spinbutton', { name: 'Unit price' }).fill('1000');
  await page.getByRole('button', { name: '+ Add line' }).click();
  const second = page.getByRole('row').nth(2);
  await second.getByRole('textbox', { name: 'Item' }).fill('Follow-up review');
  await second.getByRole('spinbutton', { name: 'Unit price' }).fill('500');
  const totals = page.locator('.totals');
  await expect(totals).toContainText('Subtotal2,500.00');
  await expect(totals).toContainText('Total INR2,950.00');
  await expect.poll(async () => (await api()).lines.map((l) => [l.item, l.qty, l.unitPrice])).toEqual([['Strategy workshop', 2, 1000], ['Follow-up review', 1, 500]]);
  expect((await api()).contact?.id).toBe(ravi.id);

  // Currency resets GST to its default.
  await page.getByLabel('Currency').selectOption('USD');
  await expect(page.getByRole('spinbutton', { name: 'GST %' })).toHaveValue('0');
  await expect(totals).toContainText('Total USD2,500.00');
  await expect.poll(async () => [(await api()).currency, (await api()).taxRate]).toEqual(['USD', 0]);
  await page.getByLabel('Currency').selectOption('INR');
  await expect(page.getByRole('spinbutton', { name: 'GST %' })).toHaveValue('18');
  await expect.poll(async () => [(await api()).currency, (await api()).taxRate]).toEqual(['INR', 18]);

  // Preview PDF: the server's PDF in a dialog, with Download.
  await page.getByRole('button', { name: 'Preview PDF' }).click();
  const preview = page.getByRole('dialog', { name: `Quotation ${q.number}` });
  await expect(preview.locator('iframe')).toHaveAttribute('src', `/api/quotations/${q.id}/pdf#toolbar=0&navpanes=0&view=FitH`);
  await expect(preview.getByRole('link', { name: 'Download' })).toHaveAttribute('download', `${q.number}-rev1.pdf`);
  const pdf = await page.request.get(`/api/quotations/${q.id}/pdf`);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  await preview.getByRole('button', { name: 'Close' }).click();

  // Send by email: prototype dialog; "Sending…" until the (fake) Graph send succeeds, then Sent and the lead moves.
  await page.getByRole('button', { name: 'Send by email' }).click();
  const send = page.getByRole('dialog', { name: `Send ${q.number} by email` });
  await expect(send).toContainText('A PDF of revision 1 (INR 2,950.00) is attached and the revision is frozen. The lead moves to Proposal Sent if it is earlier in the pipeline.');
  await expect(send.getByLabel('To')).toHaveValue(ravi.businessEmail);
  await expect(send.getByLabel('Message')).toHaveValue(new RegExp(`^Please find attached quotation ${q.number} \\(revision 1\\)`));
  await send.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Sending…' })).toBeDisabled();
  await expect(first.getByRole('textbox', { name: 'Item' })).toBeDisabled();
  runSendJobs();
  await expect(topbar.locator('.badge').first()).toHaveText('Sent', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send by email' })).toBeVisible();
  await expect(page.getByText('Rev 1 · current')).toBeVisible();
  const afterSend = (await (await page.request.get(`/api/leads/${lead.id}`)).json()) as { status: string };
  expect(afterSend.status).toBe('Proposal Sent');

  // The first edit after sending opens revision 2.
  await page.getByRole('spinbutton', { name: 'Overall discount %' }).fill('10');
  await expect(page.getByRole('status').filter({ hasText: 'Revision 2 opened · previous version kept' })).toBeVisible();
  await expect(topbar.locator('.badge')).toHaveText(['Sent', 'Revision 2 · editing']);
  await expect(page.getByText('Rev 2 · editing')).toBeVisible();
  await expect(page.getByText(/^Rev 1 · sent /)).toBeVisible();

  // Accept with revision 2 unsent: confirm, the edit is discarded, the lead is Won, the quotation locked.
  await page.getByRole('button', { name: 'Mark accepted' }).click();
  const confirm = page.getByRole('dialog', { name: 'Mark accepted' });
  await expect(confirm).toContainText('Revision 2 has unsent changes — they will be discarded');
  await confirm.getByRole('button', { name: 'Mark accepted' }).click();
  await expect(topbar.locator('.badge')).toHaveText(['Accepted', 'Revision 1']);
  await expect(page.getByRole('button', { name: 'Send by email' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Convert to project' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Convert to project' })).toHaveAttribute('title', 'Available in release 3B');
  await expect(first.getByRole('textbox', { name: 'Item' })).toBeDisabled();
  await expect(totals).toContainText('Total INR2,950.00');
  const won = (await (await page.request.get(`/api/leads/${lead.id}`)).json()) as { status: string };
  expect(won.status).toBe('Won');

  // Duplicate still works on a locked quotation and opens the new Draft.
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/quotations/${q.id}$`));
  await expect(page).toHaveURL(/\/quotations\/\d+$/);
  await expect(topbar.locator('.badge')).toHaveText(['Draft', 'Revision 1']);
  await expect(page.getByRole('row').nth(1).getByRole('textbox', { name: 'Item' })).toHaveValue('Strategy workshop');
});

test('Settings → Company details: Administrators only', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Company details' }).click();
  await expect(page).toHaveURL(/\/settings\/company$/);
  await expect(page.getByLabel(/^Legal name/)).toHaveValue('DAIT Partners LLP');
  await expect(page.getByLabel('Default GST % · INR')).toHaveValue('18');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  await signInAs(page, ARJUN);
  await page.goto('/settings');
  await expect(page.getByRole('link', { name: 'Company details' })).toHaveCount(0);
  await page.goto('/settings/company');
  await expect(page.getByText('You do not have access')).toBeVisible();
});
