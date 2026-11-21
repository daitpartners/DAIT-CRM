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

const stepper = (page: Page) => page.getByRole('list', { name: 'Lead status' });
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
/** An item of the header's "More" menu. */
const more = async (page: Page, item: string) => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: item }).click();
};

test('log call sets status and creates a follow-up task', async ({ page }) => {
  await signInAs(page, ARJUN);
  await openLead(page, 'Northwind Logistics');
  await expect(stepper(page).getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-current', 'step');

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

  await expect(stepper(page).getByRole('button', { name: 'Contacted', exact: true })).toHaveAttribute('aria-current', 'step');
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

  await more(page, 'Transfer');
  const dialog = page.getByRole('dialog', { name: 'Transfer lead' });
  await choose(dialog.getByRole('combobox', { name: 'Transfer to' }), 'Arjun Mehta');
  await dialog.getByRole('button', { name: 'Transfer' }).click();
  await expect(dialog.getByText('Add a note for the person receiving the lead')).toBeVisible();
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Note').fill('Arjun covers India this quarter');
  await dialog.getByRole('button', { name: 'Transfer' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.topbar .sub')).toContainText('Arjun Mehta');
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

  await more(page, 'Close lead');
  const dialog = page.getByRole('dialog', { name: 'Close lead' });
  await dialog.getByRole('radio', { name: 'Lost' }).check();
  await dialog.getByRole('button', { name: 'Close lead' }).click();
  await expect(dialog.getByText('Enter a reason')).toBeVisible();
  await dialog.getByLabel('Reason').fill('Chose a local vendor');
  await dialog.getByRole('button', { name: 'Close lead' }).click();
  await expect(dialog).toBeHidden();

  await expect(stepper(page).getByRole('button', { name: 'Lost' })).toHaveAttribute('aria-current', 'step');
  await expect(await followUp(page)).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Open tasks' })).toContainText('No open tasks');
  await expect((await timeline(page)).getByRole('listitem').filter({ hasText: 'Contacted → Lost' })).toContainText('Chose a local vendor');

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  // The closed follow-up is no longer open (it may be listed under Completed).
  await expect(page.getByRole('region', { name: 'Upcoming' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Upcoming' }).getByRole('listitem').filter({ hasText: 'Follow up · Northwind Logistics' })).toHaveCount(0);
});
