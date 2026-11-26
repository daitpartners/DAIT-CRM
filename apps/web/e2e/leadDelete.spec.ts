import { expect, test } from '@playwright/test';
import { MAYA, NEHA, signInAs } from './fixtures';

test('an Administrator deletes a lead whose company has no other leads: lead and company are gone', async ({ page }) => {
  const company = `Deleteco ${Date.now()}`;
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const { id, number, companyId } = (await created.json()) as { id: number; number: string; companyId: number };
  expect(companyId).toBeTruthy();
  const contact = await page.request.post('/api/contacts', { data: { companyId, firstName: 'Priya', lastName: 'Nair', businessEmail: 'priya@deleteco.test' } });
  expect(contact.status()).toBe(201);
  const { id: contactId } = (await contact.json()) as { id: number };
  await page.goto(`/leads/${id}`);

  await page.locator('.topbar').getByRole('button', { name: 'Edit profile' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete lead…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete lead?' });
  await expect(dialog).toContainText('Will be removed for good: 1 lead with their notes, tasks and timeline, 1 company, 1 contact.');
  await expect(dialog.getByText('Priya Nair')).toBeVisible();
  await expect(dialog.getByText(`${number} · ${company}`)).toBeVisible();
  await expect(dialog.getByText(new RegExp(`CO-\\d+ · ${company}`))).toBeVisible();
  const remove = dialog.getByRole('button', { name: 'Delete permanently' });
  await expect(remove).toBeDisabled();
  await dialog.getByLabel('Type "delete" to confirm').fill('delete');
  await remove.click();

  await expect(page).toHaveURL(/\/leads$/);
  await expect(page.getByRole('status').filter({ hasText: 'Lead deleted' })).toBeVisible();
  expect((await page.request.get(`/api/leads/${id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/companies/${companyId}`)).status()).toBe(404);
  expect((await page.request.get(`/api/contacts/${contactId}`)).status()).toBe(404);
});

test('a Manager sees no delete action on the lead page or in the bulk bar, and the API refuses', async ({ page }) => {
  await signInAs(page, NEHA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const created = await page.request.post('/api/leads', {
    data: { companyName: `Keepco ${Date.now()}`, country: 'India', leadSource: 'Referral', assignedToId: me.id },
  });
  expect(created.status()).toBe(201);
  const { id, number } = (await created.json()) as { id: number; number: string };
  await page.goto(`/leads/${id}`);
  await page.locator('.topbar').getByRole('button', { name: 'Edit profile' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Archive' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Delete/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto('/leads');
  await page.getByRole('searchbox', { name: 'Search leads' }).fill(number);
  await page.getByRole('row').filter({ hasText: number }).getByRole('checkbox').check();
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar.getByRole('button', { name: 'Archive' })).toBeVisible();
  await expect(bar.getByRole('button', { name: /Delete/ })).toHaveCount(0);
  expect((await page.request.post('/api/leads/delete/preview', { data: { ids: [id] } })).status()).toBe(403);
});
