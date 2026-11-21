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
  const modal = page.getByRole('dialog', { name: 'New lead' });
  await modal.getByLabel('Company name').fill(company);
  const country = modal.getByRole('combobox', { name: 'Country' });
  await country.fill('Spain');
  await country.press('Enter');
  await modal.getByLabel('Assigned to').selectOption({ label: 'Me' });
  await modal.getByLabel('Next follow-up').fill(inDays(3));
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(modal).toBeHidden();

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  await page.getByRole('tab', { name: /Upcoming/ }).click();
  const task = page.getByRole('listitem').filter({ hasText: `Follow up · ${company}` });
  await expect(task).toBeVisible();
  await expect(task.getByRole('link', { name: /LD-\d+/ })).toBeVisible();

  // The box is controlled by the saved state: click, then the row moves to Done once saved.
  await task.getByRole('checkbox', { name: /Mark done/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task done' })).toBeVisible();
  await expect(task).toHaveCount(0);
  await page.getByRole('tab', { name: /Done/ }).click();
  await expect(page.getByRole('listitem').filter({ hasText: `Follow up · ${company}` })).toBeVisible();
});
