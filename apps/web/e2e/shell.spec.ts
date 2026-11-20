import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';

test('below 900px the sidebar collapses behind a menu button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, MAYA);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
});
