import { expect, test, type Locator, type Page } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from './fixtures';

/*
 * Order-dependent on the one seeded database: the first and last tests work on Arjun's seeded
 * Northwind Logistics lead (follow-up tomorrow); the transfer test uses a lead it creates itself so
 * the seeded Orbit (Maya) and Meridian (unassigned) leads stay as leads.spec.ts expects them.
 */

/** YYYY-MM-DD `days` from today (browser local date; the e2e users' time zones are close to it). */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Opens a lead from the leads list by company name (the page's title is the lead number). */
async function openLead(page: Page, company: string) {
  await page.goto('/leads');
  const row = page.getByRole('row').filter({ hasText: company }).first();
  const number = (await row.getByRole('link', { name: /^LD-\d+$/ }).first().textContent())!.trim();
  await row.getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: number, level: 1 })).toBeVisible();
}

/** Picks an option of a Combobox: a plain <select> for short lists, a search box for long ones. */
async function choose(field: Locator, label: string) {
  if ((await field.evaluate((el) => el.tagName)) === 'SELECT') await field.selectOption({ label });
  else {
    await field.fill(label);
    await field.press('Enter');
  }
}

/** The lead's status, as the Follow-up tab's Status select shows it. */
const status = async (page: Page) => {
  await page.getByRole('tab', { name: /^Follow-up/ }).click();
  return page.getByLabel('Status', { exact: true });
};
/** The Owner row of the Follow-up tab. */
const owner = async (page: Page) => {
  await page.getByRole('tab', { name: /^Follow-up/ }).click();
  return page.getByRole('group', { name: 'Owner' });
};
/** The activity history sits under the Calls tab of the Follow-up / Emails / Calls card. */
const timeline = async (page: Page) => {
  await page.getByRole('tab', { name: /^Calls/ }).click();
  return page.getByRole('list', { name: 'Activity timeline' });
};
/** The Follow-up tab's next follow-up date. */
const followUp = async (page: Page) => {
  await page.getByRole('tab', { name: /^Follow-up/ }).click();
  return page.getByRole('group', { name: 'Next follow-up' }).getByLabel('Next follow-up');
};

test('log call sets status and creates a follow-up task', async ({ page }) => {
  await signInAs(page, ARJUN);
  await openLead(page, 'Northwind Logistics');
  await expect(await status(page)).toHaveValue('New');

  await page.getByRole('tab', { name: 'Call note' }).click();
  const dialog = page.getByRole('form', { name: 'Call note' });
  await dialog.getByLabel('Outcome').selectOption('Connected');
  await dialog.getByLabel('Minutes').fill('5');
  await dialog.getByLabel('Note').fill('Spoke to the operations head');
  // Closed statuses need a reason: Log call does not offer them.
  await expect(dialog.getByLabel('Status after call').locator('option', { hasText: 'Lost' })).toHaveCount(0);
  await dialog.getByLabel('Status after call').selectOption({ label: 'Contacted' });
  await dialog.getByLabel('Next follow-up').fill(inDays(2));
  await dialog.getByRole('button', { name: 'Save call' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Call logged' })).toBeVisible();
  await expect(dialog.getByLabel('Note')).toHaveValue('');

  await expect(await status(page)).toHaveValue('Contacted');
  await expect((await timeline(page)).getByRole('listitem').filter({ hasText: 'Call · Connected' })).toContainText('5 min · Spoke to the operations head');
  await expect((await timeline(page)).getByRole('listitem').filter({ hasText: 'New → Contacted' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('region', { name: 'Upcoming' }).getByRole('listitem').filter({ hasText: 'Follow up · Northwind Logistics' })).toBeVisible();
});

test('transfer requires a note and notifies the receiver', async ({ page }) => {
  const company = `Transferco ${Date.now()}`;
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', {
    data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id },
  });
  expect(created.status()).toBe(201);
  await openLead(page, company);

  await (await owner(page)).getByRole('button', { name: 'Transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Transfer lead' });
  await choose(dialog.getByRole('combobox', { name: 'Transfer to' }), 'Arjun Mehta');
  await dialog.getByRole('button', { name: 'Transfer' }).click();
  await expect(dialog.getByText('Add a note for the person receiving the lead')).toBeVisible();
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Note').fill('Arjun covers India this quarter');
  await dialog.getByRole('button', { name: 'Transfer' }).click();
  await expect(dialog).toBeHidden();
  await expect(await owner(page)).toContainText('Arjun Mehta');
  await expect(await timeline(page)).toContainText('Arjun covers India this quarter');

  await signInAs(page, ARJUN);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /Notifications/ })).toContainText('1');
  await page.goto('/leads?tab=mine');
  await expect(page.getByRole('row').filter({ hasText: company })).toContainText('Arjun Mehta');
});

test('closing as Lost needs a reason and clears follow-up', async ({ page }) => {
  await signInAs(page, ARJUN);
  await openLead(page, 'Northwind Logistics');
  await expect(await followUp(page)).not.toHaveValue('');

  // Picking Lost in the Follow-up tab's Status opens Close lead with Lost chosen; the reason is still required.
  await (await status(page)).selectOption('Lost');
  const dialog = page.getByRole('dialog', { name: 'Close lead' });
  await expect(dialog.getByRole('radio', { name: 'Lost' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Close lead' }).click();
  await expect(dialog.getByText('Enter a reason')).toBeVisible();
  await dialog.getByLabel('Reason').fill('Chose a local vendor');
  await dialog.getByRole('button', { name: 'Close lead' }).click();
  await expect(dialog).toBeHidden();

  await expect(await status(page)).toHaveValue('Lost');
  await expect(await followUp(page)).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Open tasks' })).toContainText('No open tasks');
  await expect((await timeline(page)).getByRole('listitem').filter({ hasText: 'Contacted → Lost' })).toContainText('Chose a local vendor');

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  // The closed follow-up is no longer open (it may be listed under Completed).
  await expect(page.getByRole('region', { name: 'Upcoming' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Upcoming' }).getByRole('listitem').filter({ hasText: 'Follow up · Northwind Logistics' })).toHaveCount(0);
});

test('a closed lead reopens from the Status select', async ({ page }) => {
  // Runs after the Lost test above: Arjun's Northwind lead is closed as Lost.
  await signInAs(page, ARJUN);
  await openLead(page, 'Northwind Logistics');
  await expect(await status(page)).toHaveValue('Lost');
  await (await status(page)).selectOption('Contacted');
  await expect(page.getByRole('status').filter({ hasText: 'Status changed to Contacted' })).toBeVisible();
  await expect(await status(page)).toHaveValue('Contacted');
});

test('a sales representative claims an unassigned lead from the Owner row', async ({ page }) => {
  const company = `Claimco ${Date.now()}`;
  await signInAs(page, MAYA);
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral' } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };

  await signInAs(page, ARJUN);
  await page.goto(`/leads/${id}`);
  const row = await owner(page);
  await expect(row).toContainText('Unassigned');
  await expect(row.getByRole('button', { name: 'Transfer' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Claim' }).click();
  await expect(row).toContainText('Arjun Mehta');
});

test('the Follow-up tab has no quick date buttons', async ({ page }) => {
  await signInAs(page, ARJUN);
  await openLead(page, 'Northwind Logistics');
  await page.getByRole('tab', { name: /^Follow-up/ }).click();
  for (const name of ['Tomorrow', '+4 days', 'Next week', 'Clear']) {
    await expect(page.getByRole('region', { name: 'Follow-up and history' }).getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('Edit profile holds Edit lead details, Switch contact and Archive; an archived lead is read-only', async ({ page }) => {
  const company = `Archiveco ${Date.now()}`;
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };
  await page.goto(`/leads/${id}`);

  await page.locator('.topbar').getByRole('button', { name: 'Edit profile' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Edit lead details' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Switch contact' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Archive' }).click();
  const confirm = page.getByRole('dialog', { name: 'Archive lead?' });
  await confirm.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText('This lead is archived.')).toBeVisible();

  // Read-only while archived: no Owner actions, Status disabled, Restore offered.
  await page.getByRole('tab', { name: /^Follow-up/ }).click();
  await expect(page.getByLabel('Status', { exact: true })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Owner' }).getByRole('button')).toHaveCount(0);
  await page.locator('.topbar').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('This lead is archived.')).toHaveCount(0);
  await expect(page.getByLabel('Status', { exact: true })).toBeEnabled();
});

test('Edit lead details: experience on a lead without a contact creates and links the person', async ({ page }) => {
  const company = `Xpco ${Date.now()}`;
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };
  await page.goto(`/leads/${id}`);

  await page.locator('.topbar').getByRole('button', { name: 'Edit profile' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit lead details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit lead' });
  const xp = dialog.getByRole('group', { name: 'Experience' });
  await xp.getByLabel('First name').fill('Rohan');
  await xp.getByLabel('Last name').fill('Mehra');
  await xp.getByRole('button', { name: '+ Add role' }).click();
  await xp.getByLabel('Job title').fill('Founder');
  await xp.getByLabel('Company', { exact: true }).fill(company);
  await xp.getByLabel('From year').fill('2019');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  const profile = page.getByRole('region', { name: 'Profile' });
  await expect(profile.getByRole('heading', { name: 'Rohan Mehra' })).toBeVisible();
  const list = profile.getByRole('list', { name: 'Experience' });
  await expect(list).toContainText('Founder');
  await expect(list).toContainText('2019 – Present');
});

test('Edit lead details: a lead with a contact edits that person\'s experience', async ({ page }) => {
  // Runs after the test above: Rohan Mehra is the contact of the newest Xpco lead.
  await signInAs(page, MAYA);
  await openLead(page, 'Xpco');
  await page.locator('.topbar').getByRole('button', { name: 'Edit profile' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit lead details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit lead' });
  const xp = dialog.getByRole('group', { name: 'Experience' });
  await expect(xp.getByLabel('First name')).toHaveCount(0);
  await expect(xp.getByLabel('Job title')).toHaveValue('Founder');
  await xp.getByLabel('Job title').fill('Founder & CEO');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: 'Profile' }).getByRole('list', { name: 'Experience' })).toContainText('Founder & CEO');
});
