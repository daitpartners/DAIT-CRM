import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, NEHA, signInAs } from './fixtures';

/** Release 2B-1: send from the lead page through your own mailbox; mail is private to its sender. */
test('send from the lead page; others see only "Email sent"', async ({ page }) => {
  await signInAs(page, NEHA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const company = `Mailco ${Date.now()}`;
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };
  await page.goto(`/leads/${id}`);

  const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
  await email.getByLabel('To', { exact: true }).fill('client@example.com');
  await email.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Email queued — it is sent from neha.kapoor@daitpartners.com' })).toBeVisible();
  await expect(email.getByLabel('To', { exact: true })).toHaveValue('');

  const panel = page.getByRole('region', { name: 'Follow-up and history' });
  await panel.getByRole('tab', { name: /^Emails/ }).click();
  await expect(panel.getByRole('tab', { name: /^Emails/ })).toHaveText('Emails 1');
  const row = panel.getByRole('listitem').filter({ hasText: 'Intro call this week?' });
  await expect(row).toContainText('client@example.com');
  await expect(row).toContainText('Sending');
  await panel.getByRole('tab', { name: /^Calls/ }).click();
  await expect(page.getByRole('list', { name: 'Activity timeline' })).toContainText('Email sent · Intro call this week?');

  // An administrator sees that an email was sent, not what it said.
  await signInAs(page, MAYA);
  await page.goto(`/leads/${id}`);
  const adminPanel = page.getByRole('region', { name: 'Follow-up and history' });
  await adminPanel.getByRole('tab', { name: /^Emails/ }).click();
  await expect(adminPanel.getByRole('tab', { name: /^Emails/ })).toHaveText('Emails 0');
  await expect(adminPanel).toContainText('No emails yet');
  await adminPanel.getByRole('tab', { name: /^Calls/ }).click();
  const timeline = page.getByRole('list', { name: 'Activity timeline' });
  await expect(timeline).toContainText('Email sent');
  await expect(timeline).not.toContainText('Intro call this week?');
});

test('without a connected mailbox the Email tab says how to connect and does not send', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/leads');
  await page.getByRole('row').filter({ hasText: 'Northwind Logistics' }).first().getByRole('link').first().click();
  const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
  await expect(email).toContainText('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.');
  await expect(email.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings/connections');
  await expect(email.getByRole('button', { name: 'Send email' })).toBeDisabled();
});
