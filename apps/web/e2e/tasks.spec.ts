import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

/** YYYY-MM-DD `days` from today (browser local date; the e2e users' time zones are close to it). */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('follow-up date creates a task that appears under Upcoming and can be ticked', async ({ page }) => {
  const company = `Taskco ${Date.now()}`;
  await signInAs(page, MAYA);
  await page.goto('/leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  const form = page.getByRole('form', { name: 'Create lead or prospect' });
  await form.getByLabel('Company name').fill(company);
  const country = form.getByRole('combobox', { name: 'Country' });
  await country.fill('Spain');
  await country.press('Enter');
  // The creator is the default owner.
  await expect(form.getByLabel('Assigned to').locator('option:checked')).toHaveText('Maya Pillai (me)');
  await form.getByLabel('Next follow-up date').fill(inDays(3));
  await form.getByRole('button', { name: 'Create lead' }).click();
  await expect(page).toHaveURL(/\/leads\/\d+$/);

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  const task = page.getByRole('region', { name: 'Upcoming' }).getByRole('listitem').filter({ hasText: `Follow up · ${company}` });
  await expect(task).toBeVisible();
  await expect(task.getByRole('link', { name: /LD-\d+/ })).toBeVisible();

  // The box is controlled by the saved state: click, then the row moves to Completed once saved.
  await task.getByRole('checkbox', { name: /Mark done/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task done' })).toBeVisible();
  await expect(task).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Completed' }).getByRole('listitem').filter({ hasText: `Follow up · ${company}` })).toBeVisible();
});
