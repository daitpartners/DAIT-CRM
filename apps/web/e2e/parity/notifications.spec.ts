import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('notifications: prototype topbar, All/Unread tabs, day groups and unread dots', async ({ page }) => {
  // Arjun assigns Maya a task, which notifies her.
  await signInAs(page, MAYA);
  const maya = (await (await page.request.get('/api/me')).json()) as { id: number };
  await signInAs(page, ARJUN);
  const title = `Parity notice ${Date.now()}`;
  const res = await page.request.post('/api/tasks', { data: { title, dueDate: inDays(1), assignedToId: maya.id } });
  expect(res.status()).toBe(201);

  await signInAs(page, MAYA);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toHaveText('What has happened on your leads, newest first');
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeEnabled();

  const tabs = await page.getByRole('tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s*\d+$/, '').trim()));
  expect(tabs).toEqual(['All', 'Unread']);
  const all = Number((await page.getByRole('tab', { name: /All/ }).locator('.n').textContent())?.trim());
  await expect(page.locator('.filters')).toContainText(`Showing ${all} of ${all}`);

  // Newest first under day headings; the new one is under Today, unread, with its kind.
  await expect(page.locator('.ngh').first()).toHaveText('Today');
  const row = page.locator('.nrow').filter({ hasText: title });
  await expect(row).toHaveClass(/unread/);
  await expect(row.locator('.nm')).toContainText('Tasks ·');
  await expect(row.getByText('Unread')).toBeAttached();

  await page.getByRole('tab', { name: /Unread/ }).click();
  await expect(page).toHaveURL(/tab=unread/);
  await expect(page.locator('.nrow').filter({ hasText: title })).toBeVisible();

  await page.goto('/notifications');
  await captureParity(page, 'notifications');

  // Opening one marks it read (and follows its link); Mark all as read empties Unread.
  await page.locator('.nrow').filter({ hasText: title }).click();
  await expect(page).toHaveURL(/\/tasks/);
  await page.goto('/notifications?tab=unread');
  await expect(page.locator('.nrow').filter({ hasText: title })).toHaveCount(0);
  if (await page.getByRole('button', { name: 'Mark all as read' }).isEnabled()) {
    await page.getByRole('button', { name: 'Mark all as read' }).click();
  }
  await expect(page.getByText('You are all caught up.')).toBeVisible();
});
