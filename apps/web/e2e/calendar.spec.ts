import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from './fixtures';

/** YYYY-MM-DD `days` from today (browser local date; the e2e users' time zones are close to it). */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('a call planned from an empty day shows on the calendar, the lead timeline and Tasks', async ({ page }) => {
  const company = `Calco ${Date.now()}`;
  const title = `Call about the proposal ${Date.now()}`;
  await signInAs(page, ARJUN);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string };

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  await expect(page.getByText('Follow-ups, calls and meetings for your leads')).toBeVisible();
  // Mine / Everyone is for administrators only.
  await expect(page.getByRole('link', { name: 'Everyone' })).toHaveCount(0);

  // Week view three weeks out: every day is still empty for this new lead.
  const day = inDays(21);
  await page.goto(`/calendar?view=week&d=${day}`);
  const cell = page.locator(`.cc[data-day="${day}"]`);
  await cell.click({ position: { x: 20, y: 300 } });
  const dialog = page.getByRole('dialog', { name: 'New follow-up' });
  await expect(dialog.getByLabel(/^Date/)).toHaveValue(day);

  const leadBox = dialog.getByRole('combobox', { name: /Lead/ });
  await leadBox.fill(company);
  await dialog.getByRole('option', { name: new RegExp(`${lead.number} · ${company}`) }).click();
  await dialog.getByLabel(/What to do/).fill(title);
  await dialog.getByLabel('Type').selectOption('call');
  await dialog.getByRole('button', { name: 'Add to calendar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'A call needs a time' })).toBeVisible();
  await dialog.getByLabel(/^Time/).fill('10:00');
  await dialog.getByRole('button', { name: 'Add to calendar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Call added for ' })).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const chip = cell.getByRole('link', { name: new RegExp(title) });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveClass(/t-call/);
  await expect(chip).toContainText('10:00');

  // The chip opens the lead, whose timeline has the planned call.
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/leads/${lead.id}$`));
  // The activity history sits under the Calls tab.
  await page.getByRole('tab', { name: /^Calls/ }).click();
  await expect(page.getByRole('list', { name: 'Activity timeline' }).getByRole('listitem').filter({ hasText: `Call scheduled · ${title}` })).toBeVisible();

  // And it is on Tasks, as a call with its time.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tasks' }).click();
  const task = page.getByRole('region', { name: 'Upcoming' }).getByRole('listitem').filter({ hasText: title });
  await expect(task).toBeVisible();
  await expect(task).toContainText('Call · 10:00–10:30');
});

test('an administrator can switch to Everyone', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/calendar');
  const everyone = page.getByRole('link', { name: 'Everyone' });
  await expect(page.getByRole('link', { name: 'Mine' })).toHaveClass('on');
  await everyone.click();
  await expect(page).toHaveURL(/who=all/);
  await expect(everyone).toHaveClass('on');
  await page.getByRole('link', { name: 'Day', exact: true }).click();
  await expect(page).toHaveURL(/view=day/);
  await expect(page).toHaveURL(/who=all/);
});
