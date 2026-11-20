import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

test('unauthenticated visitors are sent to sign-in', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('signing in as an administrator shows name and role, and signing out returns to sign-in', async ({ page }) => {
  await signInAs(page, MAYA);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByText('Maya Pillai')).toBeVisible();
  await expect(nav.getByText('Administrator')).toBeVisible();
  await nav.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});
