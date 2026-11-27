import { expect, test } from '@playwright/test';
import { MAYA, NEHA, signInAs } from './fixtures';

/**
 * Release 2B-2: the Email screen shows your own synced mail, linked to leads, and acts on it. Web-mail release 1:
 * Administrators and Managers read the team's lead mail, view only. Web-mail release 2: the conversation reading pane,
 * attachment cards, the lead panel and Link to lead ▾ (no Unlinked folder).
 */
test('Email screen: read the conversation, log on the lead, create a task; team mail is view only for an administrator', async ({ page }) => {
  await signInAs(page, NEHA);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: /^Email\s*2$/ })).toBeVisible();
  await nav.getByRole('link', { name: /^Email/ }).click();
  await expect(page.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible();
  await expect(page.getByText('neha.kapoor@daitpartners.com · Microsoft 365')).toBeVisible();
  await expect(page.getByRole('main')).toContainText('lead mail only');

  const folders = page.getByRole('navigation', { name: 'Mail folders' });
  const list = page.getByRole('region', { name: 'Message list' });
  // Web-mail release 2: an unlinked row no longer carries release 1's "Unlinked · create lead?" badge, and there is no
  // Unlinked folder; the message stays in the Inbox.
  await expect(list.getByRole('link', { name: /Website enquiry/ })).toBeVisible();
  await expect(list).not.toContainText('Unlinked');
  await expect(folders.getByRole('link', { name: /Unlinked/ })).toHaveCount(0);

  // Open Orbit's reply: the conversation (both messages, newest first), its attachment card, the lead panel; it is now read.
  await list.getByRole('link', { name: /Re: Orbit proposal/ }).click();
  const reader = page.getByRole('region', { name: 'Reading pane' });
  await expect(reader.getByRole('heading', { name: 'Re: Orbit proposal', level: 2 })).toBeVisible();
  await expect(reader).toContainText('2 messages');
  await expect(reader).toContainText(/Thanks Neha, can we talk on Thursday\?[\s\S]*Hi, Please find our proposal\./);
  const card = reader.getByRole('list', { name: 'Attachments' }).getByRole('listitem').filter({ hasText: 'orbit-notes.pdf' });
  await expect(card.getByRole('link', { name: 'Download' })).toBeVisible();
  // At 1280 px the lead panel starts folded to its rail: open it.
  const panel = page.getByRole('complementary', { name: 'Lead' });
  await panel.getByRole('button', { name: 'Expand lead panel' }).click();
  await expect(panel.getByRole('heading', { name: 'Lead', level: 3 })).toBeVisible();
  await expect(panel).toContainText('Orbit Fintech');
  await expect(panel).toContainText('LD-1003');
  await expect(folders.getByRole('link', { name: /^Inbox\s*1$/ })).toBeVisible();

  // Web-mail release 3: Reply opens the inline editor at the top of the conversation (no dialog); Discard on the
  // untouched draft closes it and removes the draft.
  await reader.locator('.msg-foot').getByRole('button', { name: 'Reply', exact: true }).first().click();
  const replyForm = reader.getByRole('form', { name: 'Reply' });
  await expect(replyForm.getByText(/^Draft saved \d\d:\d\d$/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await replyForm.getByRole('button', { name: 'Discard' }).click();
  await expect(replyForm).toHaveCount(0);

  await panel.getByRole('button', { name: 'Log as activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Logged on LD-/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Log as activity' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Task created' })).toBeVisible();

  // Smart views and search.
  await folders.getByRole('link', { name: 'Sent items' }).click();
  await expect(list.getByRole('link', { name: /Orbit proposal/ })).toBeVisible();
  await folders.getByRole('link', { name: /^Inbox/ }).click();
  await expect(list.locator('.mrow')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Search lead mail' }).fill('website');
  await page.getByRole('searchbox', { name: 'Search lead mail' }).press('Enter');
  await expect(list.locator('.mrow')).toHaveCount(1);
  await expect(list).toContainText('Website enquiry');

  // An administrator's own mailbox is empty (Mail of: Me). Mail of: Neha Kapoor shows her lead mail, view only, and
  // not her unlinked mail (web-mail release 1); on the lead the timeline now shows the subject.
  await signInAs(page, MAYA);
  await page.goto('/email');
  const mayaList = page.getByRole('region', { name: 'Message list' });
  await expect(mayaList).toContainText('No lead mail matches this filter.');
  const mailOf = page.getByRole('combobox', { name: 'Mail of:' });
  await expect(mailOf.getByRole('option', { name: 'Neha Kapoor' })).toBeAttached();
  await mailOf.selectOption({ label: 'Neha Kapoor' });
  await expect(page.getByText('Team view · lead mail of Neha Kapoor')).toBeVisible();
  await expect(mayaList.getByRole('link', { name: /Re: Orbit proposal/ })).toBeVisible();
  await expect(mayaList).not.toContainText('Website enquiry');
  await mayaList.getByRole('link', { name: /Re: Orbit proposal/ }).click();
  const theirs = page.getByRole('region', { name: 'Reading pane' });
  await expect(theirs.getByRole('heading', { name: 'Re: Orbit proposal', level: 2 })).toBeVisible();
  await expect(theirs.getByText("View only — Neha's mailbox.", { exact: true }).first()).toBeVisible();
  // No Reply in another user's mailbox: the reading pane offers none, and the command bar's is disabled.
  await expect(theirs.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  const reply = page.getByRole('toolbar', { name: 'Mail commands' }).getByRole('button', { name: 'Reply', exact: true });
  await expect(reply).toBeDisabled();
  await expect(reply).toHaveAttribute('title', "View only — Neha's mailbox");
  const leads = (await (await page.request.get('/api/leads?q=Orbit')).json()) as { items: { id: number }[] };
  await page.goto(`/leads/${leads.items[0]!.id}`);
  await page.getByRole('region', { name: 'Follow-up and history' }).getByRole('tab', { name: /^Calls/ }).click();
  const timeline = page.getByRole('list', { name: 'Activity timeline' });
  await expect(timeline).toContainText('Email received');
  await expect(timeline).toContainText('Re: Orbit proposal');
});

test('an unlinked email becomes a lead', async ({ page }) => {
  await signInAs(page, NEHA);
  await page.goto('/email?folder=inbox');
  const list = page.getByRole('region', { name: 'Message list' });
  await list.getByRole('link', { name: /Website enquiry/ }).click();
  await expect(page.getByRole('region', { name: 'Reading pane' }).getByRole('heading', { name: 'Website enquiry' })).toBeVisible();
  // Link to lead ▾ → Create lead from this email… opens release 1's dialog.
  await page.getByRole('toolbar', { name: 'Mail commands' }).getByRole('button', { name: 'Link to lead' }).click();
  await page.getByRole('menu', { name: 'Link to lead' }).getByRole('menuitem', { name: 'Create lead from this email…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link email to a lead' });
  await dialog.getByRole('button', { name: 'Link' }).click();
  await expect(page).toHaveURL(/\/leads\/\d+$/);
  await expect(page.getByRole('status').filter({ hasText: 'Lead created and linked' })).toBeVisible();
});
