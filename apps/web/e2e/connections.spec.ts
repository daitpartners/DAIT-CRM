import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, signInAs } from './fixtures';
import { captureParity } from './parity/_shared';

/** Prototype views-settings.js V.connectionsCard (release 2A). Order-dependent: the Disconnect test runs last. */
const card = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Email & calendar connections' });

test('a user without a mailbox sees Connect Microsoft 365, Other provider and the warning', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/settings/connections');
  const c = card(page);
  await expect(c.getByRole('heading', { name: 'Email & calendar connections' })).toBeVisible();
  await expect(c).toContainText('Each user connects their own mailbox. Sending, receiving and calendar sync run through it.');
  await expect(c.getByRole('link', { name: 'Connect Microsoft 365' })).toHaveAttribute('href', '/api/auth/microsoft/connect?mode=personal');
  await expect(c).toContainText('Your mailbox is not connected.');
  await expect(c).toContainText('No mailboxes connected yet.');
  await expect(c).not.toContainText('Microsoft 365 app registration');

  await c.getByRole('button', { name: 'Other provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a mailbox' });
  await expect(dialog.getByRole('link', { name: /Microsoft 365 \/ Outlook/ })).toHaveAttribute('href', '/api/auth/microsoft/connect?mode=personal');
  for (const name of [/Google Workspace \/ Gmail/, /Other \(IMAP \/ SMTP\)/]) {
    const option = dialog.getByRole('button', { name });
    await expect(option).toBeDisabled();
    await expect(option).toContainText('Coming later');
  }
});

test('a connected mailbox: row, Sync now, Options; administrators see the app-registration note and System mailbox', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings/connections');
  const c = card(page);
  await expect(c.getByRole('link', { name: 'Connect Microsoft 365' })).toHaveCount(0);
  await expect(c.getByRole('button', { name: 'Other provider' })).toBeVisible();
  await expect(c).not.toContainText('Your mailbox is not connected.');
  const row = c.getByRole('listitem').filter({ hasText: 'maya.pillai@daitpartners.com' });
  await expect(row).toContainText('Maya Pillai');
  await expect(row).toContainText('Microsoft 365');
  await expect(row).toContainText('Connected');
  await expect(row).toContainText('synced never');
  await expect(row).toContainText('0 messages');
  await expect(c.getByText('Administrator: Microsoft 365 app registration (one-time)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'System mailbox' })).toBeVisible();
  await captureParity(page, 'connections');

  await row.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sync started — new mail appears in a few seconds' })).toBeVisible();

  await row.getByRole('button', { name: 'Options' }).click();
  const options = page.getByRole('dialog', { name: /Mailbox options/ });
  await expect(options.getByRole('checkbox', { name: /Sync mail/ })).toBeChecked();
  await options.getByRole('checkbox', { name: /Sync calendar/ }).check();
  await options.getByLabel('Shared mailboxes to include').fill('hello@daitpartners.com');
  await options.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Mailbox options saved' })).toBeVisible();
  await row.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByRole('dialog', { name: /Mailbox options/ }).getByRole('checkbox', { name: /Sync calendar/ })).toBeChecked();
  await expect(page.getByRole('dialog', { name: /Mailbox options/ }).getByLabel('Shared mailboxes to include')).toHaveValue('hello@daitpartners.com');
});

test('returning from Microsoft shows the result once', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings/connections?mailbox=connected');
  await expect(page.getByRole('status').filter({ hasText: 'Your mailbox is connected' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});

test("a mailbox someone else already connected is refused with an explanation", async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/settings/connections?mailbox=taken');
  await expect(page.getByRole('status').filter({ hasText: 'This mailbox is already connected by another user. Ask them to disconnect it first.' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});

test('Disconnect asks first, then the Connect button is back', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings/connections');
  const c = card(page);
  await c.getByRole('listitem').filter({ hasText: 'maya.pillai@daitpartners.com' }).getByRole('button', { name: 'Disconnect' }).click();
  const confirm = page.getByRole('dialog', { name: 'Disconnect mailbox?' });
  await expect(confirm).toContainText('The CRM stops syncing and sending through this account and deletes its tokens.');
  await confirm.getByRole('button', { name: 'Disconnect' }).click();
  await expect(c.getByRole('link', { name: 'Connect Microsoft 365' })).toBeVisible();
  await expect(c.getByRole('listitem').filter({ hasText: 'maya.pillai@daitpartners.com' })).toHaveCount(0);
});
