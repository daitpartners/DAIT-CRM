import { expect, test } from '@playwright/test';
import { MAYA, NEHA, signInAs } from './fixtures';

test('below 900px the sidebar collapses behind a menu button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, MAYA);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
});

test('« folds the sidebar to an icon rail and the Email folders to a strip; both are remembered after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await signInAs(page, NEHA);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(nav).toHaveClass(/collapsed/);
  // After the .2 s width transition.
  await expect.poll(() => nav.evaluate((el) => el.getBoundingClientRect().width)).toBe(64);
  await expect(nav.getByRole('link', { name: 'Leads', exact: false }).first()).toHaveAttribute('data-label', /^Leads/);
  // The name shows on keyboard focus, not only on hover (review M-4).
  await page.keyboard.press('Tab');
  await nav.getByRole('link', { name: 'Dashboard' }).focus();
  await expect(page.locator('.rail-tip')).toHaveText('Dashboard');
  await expect(nav.getByRole('button', { name: 'Sign out' })).toBeVisible();

  await page.goto('/email?folder=sent');
  const folders = page.getByRole('navigation', { name: 'Mail folders' });
  await folders.getByRole('button', { name: 'Collapse folder pane' }).click();
  await expect(folders).toHaveClass(/collapsed/);
  await page.reload();
  await expect(nav).toHaveClass(/collapsed/);
  await expect(folders).toHaveClass(/collapsed/);
  await expect(page).toHaveURL(/folder=sent/);

  await folders.getByRole('button', { name: 'Expand folder pane' }).click();
  await expect(folders.getByRole('link', { name: 'Sent items' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(nav).not.toHaveClass(/collapsed/);
});
