import { expect, test } from '@playwright/test';
import { MAYA, NEHA, signInAs } from './fixtures';

/**
 * Release 2B-2: the Email screen shows your own synced mail, linked to leads, and acts on it. Web-mail release 1:
 * Administrators and Managers read the team's lead mail, view only.
 */
test('Email screen: read, log on the lead, add a task; team mail is view only for an administrator', async ({ page }) => {
  await signInAs(page, NEHA);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: /^Email\s*2$/ })).toBeVisible();
  await nav.getByRole('link', { name: /^Email/ }).click();
  await expect(page.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible();
  await expect(page.getByText('neha.kapoor@daitpartners.com · Microsoft 365')).toBeVisible();

  const folders = page.getByRole('navigation', { name: 'Mail folders' });
  const list = page.getByRole('region', { name: 'Message list' });
  await expect(list.getByRole('link', { name: /Website enquiry/ })).toContainText('Unlinked · create lead?');

  // Open Orbit's reply: linked records, thread history, attachments; it is now read.
  await list.getByRole('link', { name: /Re: Orbit proposal/ }).click();
  const reader = page.getByRole('article', { name: 'Re: Orbit proposal' });
  await expect(reader).toContainText('Thanks Neha, can we talk on Thursday?');
  await expect(reader).toContainText('Attachments: orbit-notes.pdf');
  const side = page.getByRole('complementary', { name: 'Linked records' });
  await expect(side.getByRole('link', { name: /Company\s*Orbit Fintech/ })).toBeVisible();
  await expect(side.getByRole('link', { name: /Contact\s*/ })).toBeVisible();
  // Thread history, newest first, the open message included (prototype "18 Nov 11:14 · reply received").
  await expect(side).toContainText(/\d{2} \w{3} \d{2}:\d{2} · reply received\s*\d{2} \w{3} \d{2}:\d{2} · sent by Neha/);
  await expect(folders.getByRole('link', { name: /^Inbox\s*1$/ })).toBeVisible();

  await reader.getByRole('button', { name: 'Log as activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Logged on LD-/ })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Log as activity' })).toBeDisabled();
  await reader.getByRole('button', { name: 'Add follow-up task' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task created' })).toBeVisible();

  // Smart views and search.
  await folders.getByRole('link', { name: /^Unlinked/ }).click();
  await expect(list).toContainText(/^Unlinked · 1/);
  await folders.getByRole('link', { name: 'Sent' }).click();
  await expect(list.getByRole('link', { name: /Orbit proposal/ })).toBeVisible();
  await folders.getByRole('link', { name: /^Inbox/ }).click();
  await expect(list).toContainText(/^Inbox · 2/);
  await page.getByRole('searchbox', { name: 'Search mail' }).fill('website');
  await page.getByRole('searchbox', { name: 'Search mail' }).press('Enter');
  await expect(list).toContainText(/^Inbox · 1/);
  await expect(list).toContainText('Website enquiry');

  // An administrator's own mailbox is empty (Mail of: Me). Mail of: Neha Kapoor shows her lead mail, view only, and
  // not her unlinked mail (web-mail release 1); on the lead the timeline now shows the subject.
  await signInAs(page, MAYA);
  await page.goto('/email');
  const mayaList = page.getByRole('region', { name: 'Message list' });
  await expect(mayaList).toContainText('Nothing here.');
  const mailOf = page.getByRole('combobox', { name: 'Mail of:' });
  await expect(mailOf.getByRole('option', { name: 'Neha Kapoor' })).toBeAttached();
  await mailOf.selectOption({ label: 'Neha Kapoor' });
  await expect(page.getByText('Team view · lead mail of Neha Kapoor')).toBeVisible();
  await expect(mayaList.getByRole('link', { name: /Re: Orbit proposal/ })).toBeVisible();
  await expect(mayaList).not.toContainText('Website enquiry');
  await mayaList.getByRole('link', { name: /Re: Orbit proposal/ }).click();
  const theirs = page.getByRole('article', { name: 'Re: Orbit proposal' });
  await expect(theirs.getByText("View only — Neha's mailbox.", { exact: true }).first()).toBeVisible();
  await expect(theirs.getByRole('button', { name: 'Reply' })).toBeDisabled();
  await expect(theirs.getByRole('button', { name: 'Reply' })).toHaveAttribute('title', "View only — Neha's mailbox");
  const leads = (await (await page.request.get('/api/leads?q=Orbit')).json()) as { items: { id: number }[] };
  await page.goto(`/leads/${leads.items[0]!.id}`);
  await page.getByRole('region', { name: 'Follow-up and history' }).getByRole('tab', { name: /^Calls/ }).click();
  const timeline = page.getByRole('list', { name: 'Activity timeline' });
  await expect(timeline).toContainText('Email received');
  await expect(timeline).toContainText('Re: Orbit proposal');
});

test('an unlinked email becomes a lead', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email?folder=unlinked');
  const list = page.getByRole('region', { name: 'Message list' });
  await list.getByRole('link', { name: /Website enquiry/ }).click();
  await page.getByRole('article', { name: 'Website enquiry' }).getByRole('button', { name: 'Create lead from this email' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link email to a lead' });
  await dialog.getByRole('button', { name: 'Link' }).click();
  await expect(page).toHaveURL(/\/leads\/\d+$/);
  await expect(page.getByRole('status').filter({ hasText: 'Lead created and linked' })).toBeVisible();
});
