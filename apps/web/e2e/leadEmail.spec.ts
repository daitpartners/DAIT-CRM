import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { ARJUN, MAYA, NEHA, signInAs } from './fixtures';
import { captureParity } from './parity/_shared';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';

/** Runs the queued sends against the fake Microsoft Graph (apps/api/test/e2e-send-jobs.ts): the e2e server has no worker. */
function runSends(): void {
  execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });
}

/**
 * Release 2B-1: send from the lead page through your own mailbox. Web-mail release 1: an Administrator reads it too,
 * view only, marked with the sender's mailbox. Web-mail release 3: the lead page uses the one send path (a draft, the
 * follow-up box, the Undo toast); the lead effects are filed when the mail leaves.
 */
test("send from the lead page; an administrator sees it marked with the sender's mailbox", async ({ page }) => {
  await signInAs(page, NEHA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const company = `Mailco ${Date.now()}`;
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };
  await page.goto(`/leads/${id}`);

  const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
  await email.getByLabel('To', { exact: true }).fill('client@example.com');
  await expect(email).not.toContainText('Set follow-up in');
  await email.getByRole('button', { name: 'Send', exact: true }).click();
  const box = page.getByRole('dialog', { name: 'Set the next follow-up' });
  await expect(box).toBeVisible();
  await captureParity(page, 'lead-email-send-dialog');
  await box.getByRole('button', { name: 'Send and add follow-up' }).click();
  await expect(page.locator('.utoast')).toContainText('Sent · follow-up added for');
  await captureParity(page, 'lead-email-undo-toast');
  await expect(email.getByLabel('To', { exact: true })).toHaveValue('');

  const panel = page.getByRole('region', { name: 'Follow-up and history' });
  await panel.getByRole('tab', { name: /^Emails/ }).click();
  await expect(panel.getByRole('tab', { name: /^Emails/ })).toHaveText('Emails 1');
  const row = panel.getByRole('listitem').filter({ hasText: 'Intro call this week?' });
  await expect(row).toContainText('client@example.com');
  await expect(row).toContainText('Sending');
  // The mail leaves (the worker): the tab sees it Sent and the lead shows the "Email sent" line.
  runSends();
  await expect(row).not.toContainText('Sending', { timeout: 15_000 });
  await panel.getByRole('tab', { name: /^Calls/ }).click();
  await expect(page.getByRole('list', { name: 'Activity timeline' })).toContainText('Email sent · Intro call this week?');

  // An administrator reads the team's lead mail (view only): the row says whose mailbox it is in.
  await signInAs(page, MAYA);
  await page.goto(`/leads/${id}`);
  const adminPanel = page.getByRole('region', { name: 'Follow-up and history' });
  await adminPanel.getByRole('tab', { name: /^Emails/ }).click();
  await expect(adminPanel.getByRole('tab', { name: /^Emails/ })).toHaveText('Emails 1');
  await expect(adminPanel.getByRole('listitem').filter({ hasText: 'Intro call this week?' })).toContainText("Neha's mailbox");
  await adminPanel.getByRole('tab', { name: /^Calls/ }).click();
  const timeline = page.getByRole('list', { name: 'Activity timeline' });
  await expect(timeline).toContainText('Email sent · Intro call this week?');
});

test('without a connected mailbox the Email tab says how to connect and does not send', async ({ page }) => {
  await signInAs(page, ARJUN);
  await page.goto('/leads');
  await page.getByRole('row').filter({ hasText: 'Northwind Logistics' }).first().getByRole('link').first().click();
  const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
  await expect(email).toContainText('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.');
  await expect(email.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings/connections');
  await expect(email.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});
