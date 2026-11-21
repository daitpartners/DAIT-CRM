import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, NEHA, signInAs } from './fixtures';

/** Release 2C: tick leads → Send via mailer → campaign page; administrators see every campaign, reps only their own. */
test('send via mailer from the Leads list; the campaign is listed for its sender and administrators only', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/leads');
  // The seeded leads (other specs add more leads for the same companies).
  for (const label of ['Select LD-1003 Orbit Fintech', 'Select LD-1001 Northwind Logistics']) {
    await page.getByRole('checkbox', { name: label, exact: true }).check();
  }
  await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Send via mailer' }).click();

  const dialog = page.getByRole('dialog', { name: 'Send via mailer' });
  await expect(dialog.getByText(/^Preview for /)).toBeVisible();
  await dialog.getByLabel('Campaign name').fill('E2E mailer');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByLabel(/Only send in the client's working hours/).check();
  await dialog.getByRole('button', { name: 'Next' }).click();
  const review = dialog.getByRole('table');
  await expect(review).toContainText('Europe/Berlin');
  await dialog.getByLabel(/Lawful basis/).selectOption('Legitimate interest (B2B outreach relevant to their role)');
  await dialog.getByRole('button', { name: /^Queue \d emails?$/ }).click();

  await expect(page).toHaveURL(/\/mailer\/\d+$/);
  await expect(page.getByRole('heading', { name: /MC-\d+ · E2E mailer/ })).toBeVisible();
  const recipients = page.getByRole('table', { name: 'Recipients' });
  await expect(recipients).toContainText('Queued');
  const url = page.url();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /^Mailer\s*1 live$/ })).toBeVisible();

  // Administrators see it (no actions); a rep does not.
  await signInAs(page, MAYA);
  await page.goto('/mailer');
  await expect(page.getByRole('table', { name: 'Campaigns' })).toContainText('E2E mailer');
  await page.goto(new URL(url).pathname);
  await expect(page.getByRole('heading', { name: /E2E mailer/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  await signInAs(page, ARJUN);
  await page.goto('/mailer');
  await expect(page.getByRole('table', { name: 'Campaigns' })).toContainText('No campaigns yet.');

  // The sender pauses and cancels the rest.
  await signInAs(page, NEHA);
  await page.goto(new URL(url).pathname);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel remaining' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel remaining' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
});

test('Do not email from Edit profile shows on the lead', async ({ page }) => {
  await signInAs(page, NEHA);
  const leads = (await (await page.request.get('/api/leads?q=Orbit')).json()) as { items: { id: number }[] };
  await page.goto(`/leads/${leads.items[0]!.id}`);
  await page.getByRole('button', { name: 'Edit profile' }).click();
  const dialog = page.getByRole('dialog', { name: /^Edit profile/ });
  await dialog.getByLabel('Do not email').check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('region', { name: 'Profile' }).getByText('Do not email')).toBeVisible();
});
