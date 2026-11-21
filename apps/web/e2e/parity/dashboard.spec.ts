import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('dashboard: greeting, prototype tiles, tasks, agenda placeholder, notifications, pipeline', async ({ page }) => {
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const title = `Dashboard parity ${Date.now()}`;
  const res = await page.request.post('/api/tasks', { data: { title, dueDate: inDays(-1), assignedToId: me.id } });
  expect(res.status()).toBe(201);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Maya$/);
  await expect(page.locator('.topbar .sub')).toContainText('everything assigned to you across leads, email, calendar and quotations');
  await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New lead' })).toBeVisible();

  // Tiles in prototype order; the calendar and quotation tiles wait for release 3.
  const labels = await page.locator('.tiles .tile .l').allTextContents();
  expect(labels).toEqual(['My open leads', 'Follow-ups due today', 'Meetings today', 'Quotes awaiting response']);
  await expect(page.locator('.tiles .tile').first()).toContainText('new since yesterday');
  await expect(page.locator('.tiles .tile').first()).toHaveAttribute('href', '/leads?tab=mine');
  await expect(page.locator('.tiles .tile').nth(1)).toContainText('overdue');
  await expect(page.locator('.tiles .tile').nth(2)).toContainText('Available in release 3');

  // Columns: Tasks & follow-ups | Today's agenda + Notifications | My pipeline by status.
  const heads = await page.locator('.dash-cols h2').allTextContents();
  expect(heads).toEqual(['Tasks & follow-ups', "Today's agenda", 'Notifications', 'My pipeline by status']);
  const tasks = page.getByRole('region', { name: 'Tasks & follow-ups' });
  await expect(tasks.locator('.dash-badges')).toContainText(/\d+ overdue/);
  await expect(tasks.getByRole('listitem').filter({ hasText: title })).toContainText('Overdue');
  await expect(tasks.getByRole('link', { name: /^View all \d+ tasks$/ })).toBeVisible();
  const agenda = page.getByRole('region', { name: "Today's agenda" });
  await expect(agenda).toHaveAttribute('aria-disabled', 'true');
  await expect(agenda.getByRole('button')).toHaveCount(0);
  const pipe = page.getByRole('region', { name: 'My pipeline by status' });
  await expect(pipe.getByRole('listitem')).toHaveCount(7);
  await expect(pipe.getByRole('listitem').first()).toContainText('New');
  await expect(pipe).toContainText(/Won: \d+ · Lost: \d+/);

  await captureParity(page, 'dashboard');

  // Ticking a task from the dashboard completes it.
  await tasks.getByRole('listitem').filter({ hasText: title }).getByRole('checkbox', { name: /Mark done/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task done' })).toBeVisible();
  await expect(tasks.getByRole('listitem').filter({ hasText: title })).toHaveCount(0);
});
