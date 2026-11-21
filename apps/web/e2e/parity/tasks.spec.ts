import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('tasks: prototype sections in one card, Completed and help on the side', async ({ page }) => {
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const stamp = Date.now();
  for (const [title, due] of [[`Parity overdue ${stamp}`, -2], [`Parity today ${stamp}`, 0], [`Parity later ${stamp}`, 4]] as const) {
    const res = await page.request.post('/api/tasks', { data: { title, dueDate: inDays(due), assignedToId: me.id } });
    expect(res.status()).toBe(201);
  }

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toHaveText('Pending and overdue follow-ups, new assignments and transferred leads');
  const scope = page.getByRole('group', { name: 'Whose tasks' });
  await expect(scope.getByRole('button', { name: 'My tasks' })).toHaveAttribute('aria-pressed', 'true');
  await expect(scope.getByRole('button', { name: 'Team' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New task' })).toBeVisible();

  // Main card: Overdue {n}, Due today {n}, Upcoming. Side: Completed, How tasks get here.
  const main = page.locator('.col-main');
  const mainHeads = await main.locator('h2').evaluateAll((els) => els.map((el) => (el.firstChild?.textContent ?? '').trim()));
  expect(mainHeads).toEqual(['Overdue', 'Due today', 'Upcoming']);
  const sideHeads = await page.locator('.col-side h2').allTextContents();
  expect(sideHeads).toEqual(['Completed', 'How tasks get here']);
  await expect(page.locator('.col-side')).toContainText('Lead assigned or transferred to you');

  const section = (name: string) => page.getByRole('region', { name });
  await expect(section('Overdue').getByRole('listitem').filter({ hasText: `Parity overdue ${stamp}` })).toContainText('Overdue');
  await expect(section('Due today').getByRole('listitem').filter({ hasText: `Parity today ${stamp}` })).toBeVisible();
  const later = section('Upcoming').getByRole('listitem').filter({ hasText: `Parity later ${stamp}` });
  await expect(later).toContainText('Upcoming');

  // Ticking moves a task to Completed.
  await later.getByRole('checkbox', { name: /Mark done/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task done' })).toBeVisible();
  await expect(section('Completed').getByRole('listitem').filter({ hasText: `Parity later ${stamp}` })).toBeVisible();

  // Team (view_all_leads) uses the same layout.
  await scope.getByRole('button', { name: 'Team' }).click();
  await expect(page).toHaveURL(/scope=team/);
  await expect(page.locator('.col-main h2').first()).toContainText('Overdue');

  await page.goto('/tasks');
  await captureParity(page, 'tasks');
});
