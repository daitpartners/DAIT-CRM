import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from './fixtures';
import { captureParity } from './parity/_shared';

/** Prototype views-settings.js V.templatesCard (release 2A). */
test('email templates: write, upload .oft, edit and delete', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings/templates');
  const card = page.getByRole('region', { name: 'Email templates' });
  await expect(card).toContainText('Available in every compose box. Merge fields: {first_name} {company} {me} {quote_no} {lead_id}');
  await expect(card).toContainText('Save a message in Outlook as File → Save As → Outlook Template (*.oft), then upload it here.');
  const heads = await card.locator('thead th').allTextContents();
  expect(heads.filter(Boolean)).toEqual(['Template', 'Source', 'Language', 'Subject', 'Added']);

  // Write a template.
  const name = `Intro ${Date.now()}`;
  await card.getByRole('button', { name: 'Write a template' }).click();
  let editor = page.getByRole('dialog', { name: 'Write a template' });
  await editor.getByLabel('Name').fill(name);
  await editor.getByLabel('Language').selectOption('en');
  await editor.getByLabel('Subject').fill('Intro call with {company}?');
  await editor.getByLabel('Body').fill('Hi {first_name},\n\nBest regards,\n{me}');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();
  const row = card.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Written here');
  await expect(row).toContainText('English');
  await expect(row).toContainText('Intro call with {company}?');
  await expect(row).toContainText('Maya Pillai');

  // Upload an Outlook template: the editor opens with the file's subject and body.
  await card.getByLabel('Upload .oft template').setInputFiles(resolve(process.cwd(), '../../docs/sample-template.oft'));
  editor = page.getByRole('dialog', { name: 'Write a template' });
  await expect(editor).toContainText('Read from sample-template.oft');
  await expect(editor.getByLabel('Subject')).toHaveValue('Quotation {quote_no} from DAIT Partners');
  // The file's formatting (its HTML, sanitised by the server first) is kept: the body shows in the formatted editor.
  await expect(editor.locator('iframe#tpl-body')).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(page.frameLocator('iframe#tpl-body').locator('body p').first()).toHaveText('Hi {first_name},');
  const oftName = `Quotation send ${Date.now()}`;
  await editor.getByLabel('Name').fill(oftName);
  await editor.getByRole('button', { name: 'Save' }).click();
  const oftRow = card.getByRole('row').filter({ hasText: oftName });
  await expect(oftRow).toContainText('Outlook .oft');
  await expect(oftRow).toContainText('sample-template.oft · 9 KB');
  await expect(oftRow).toContainText('Formatted');
  await expect(row).not.toContainText('Formatted');
  await captureParity(page, 'templates');

  // Edit, then delete.
  await row.getByRole('button', { name: 'Edit' }).click();
  editor = page.getByRole('dialog', { name: 'Edit template' });
  await editor.getByLabel('Subject').fill('Quick intro call?');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Quick intro call?');
  await row.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this template?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(card.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});

test('an Outlook file over 10 MB is refused before it is read', async ({ page }) => {
  await signInAs(page, MAYA);
  await page.goto('/settings/templates');
  await page.getByRole('region', { name: 'Email templates' }).getByLabel('Upload .oft template').setInputFiles({
    name: 'huge.oft', mimeType: 'application/vnd.ms-outlook', buffer: Buffer.alloc(11 * 1024 * 1024),
  });
  await expect(page.getByRole('status').filter({ hasText: 'That file is larger than 10 MB. Outlook templates are usually under 1 MB.' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Write a template' })).toHaveCount(0);
});
