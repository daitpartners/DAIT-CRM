import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

test('settings: prototype cards as tabs, in prototype order', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toHaveText('Configuration the CRM reads at runtime; nothing here is hard-coded in forms');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  expect(await nav.getByRole('link').allTextContents()).toEqual([
    'Preferences', 'Email & calendar connections', 'Email templates', 'Dropdown configuration', 'Lead allocation rules', 'Users',
  ]);

  // Preferences: Language, Date format, Time zone (prototype order).
  const prefs = page.getByRole('region', { name: 'Preferences' });
  await expect(prefs).toContainText('Saved per user.');
  const fieldOrder = await prefs.locator('.grid3 label').allTextContents();
  expect(fieldOrder.map((s) => s.replace('*', '').trim())).toEqual(['Language', 'Date format', 'Time zone']);
  await captureParity(page, 'settings');

  // Email & calendar connections: release-2 placeholder, then the 1A system mailbox for administrators.
  await nav.getByRole('link', { name: 'Email & calendar connections' }).click();
  const conn = page.getByRole('region', { name: 'Email & calendar connections' });
  await expect(conn).toHaveAttribute('aria-disabled', 'true');
  await expect(conn).toContainText('Available in release 2');
  await expect(page.getByRole('heading', { name: 'System mailbox' })).toBeVisible();

  // The 1A mailbox path (also the Microsoft callback target) still lands there, query string kept
  // (the page reads ?connected=1, shows its toast, then drops the parameter).
  await page.goto('/settings/mailbox?connected=1');
  await expect(page.getByRole('status').filter({ hasText: 'Mailbox connected' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/connections$/);
  await expect(page.getByRole('heading', { name: 'System mailbox' })).toBeVisible();

  await nav.getByRole('link', { name: 'Email templates' }).click();
  const tpl = page.getByRole('region', { name: 'Email templates' });
  await expect(tpl).toContainText('Available in release 2');
  await expect(tpl.getByRole('button')).toHaveCount(0);

  await nav.getByRole('link', { name: 'Dropdown configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Dropdown configuration', level: 2 })).toBeVisible();
  await nav.getByRole('link', { name: 'Lead allocation rules' }).click();
  await expect(page.getByRole('heading', { name: 'Lead allocation rules', level: 2 })).toBeVisible();
  await nav.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users', level: 2 })).toBeVisible();
});

test('settings: a sales representative sees only the personal tabs', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/settings');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  expect(await nav.getByRole('link').allTextContents()).toEqual(['Preferences', 'Email & calendar connections', 'Email templates']);
  await nav.getByRole('link', { name: 'Email & calendar connections' }).click();
  await expect(page.getByRole('region', { name: 'Email & calendar connections' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System mailbox' })).toHaveCount(0);
  await page.goto('/settings/allocation');
  await expect(page.getByText('You do not have access')).toBeVisible();
});
