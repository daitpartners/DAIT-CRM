import { expect, test } from '@playwright/test';
import { MAYA, signInAs } from '../fixtures';
import { captureParity } from './_shared';

/** YYYY-MM-DD `days` from today (browser local date). */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Section titles of the prototype's lead page (views-lead-detail.js + views-leads2.js), in page order. */
const PROTOTYPE_ORDER = [
  'Profile', 'Experience', 'Email', 'Call note', 'Meeting', 'Research note', 'Follow-up', 'Emails', 'Calls',
  'Northwind Logistics Private Limited', 'Skills & languages', 'Projects', 'Coming up', 'Original enquiry',
];

test('lead page: prototype sections in order, a contact without a profile, then the full profile', async ({ page }) => {
  await signInAs(page, MAYA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const contacts = (await (await page.request.get('/api/contacts?q=priya.raman')).json()) as {
    items: { id: number; companyId: number }[];
  };
  const priya = contacts.items[0]!;
  // A Northwind lead of Maya's with Priya Raman (seeded without any profile fields) as the contact.
  const created = await page.request.post('/api/leads', {
    data: {
      companyName: 'Northwind Logistics', country: 'India', leadSource: 'Website Contact Form', priority: 'High',
      linkCompanyId: priya.companyId, contactId: priya.id, assignedToId: me.id, nextFollowUp: inDays(2), createCompany: false,
    },
  });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number; number: string };

  await page.goto(`/leads/${lead.id}`);
  await expect(page.getByRole('heading', { name: lead.number, level: 1 })).toBeVisible();
  await expect(page.locator('.topbar .sub')).toContainText('Lead created:');
  await expect(page.locator('.topbar .sub')).toContainText('Last contact: —');
  // Topbar as in the prototype: number, created, last contact; Email and Edit profile only.
  const topbar = page.locator('.topbar');
  await expect(topbar.getByRole('link', { name: 'Leads' })).toHaveCount(0);
  await expect(topbar).not.toContainText('Owner:');
  await expect(topbar.getByRole('button', { name: 'More' })).toHaveCount(0);
  await expect(topbar.getByRole('button', { name: 'Claim' })).toHaveCount(0);
  await expect(topbar.getByRole('button', { name: 'Email' })).toBeEnabled();
  await expect(topbar.getByRole('button', { name: 'Edit profile' })).toBeVisible();
  // No status steps bar: status lives in the Follow-up tab.
  await expect(page.getByRole('list', { name: 'Lead status' })).toHaveCount(0);

  // No profile yet: no "undefined", no empty pills, the empty states read as text.
  const profile = page.getByRole('region', { name: 'Profile' });
  await expect(profile.getByRole('heading', { name: 'Priya Raman' })).toBeVisible();
  await expect(profile.getByText('No experience recorded yet. Add it from Edit profile.')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/undefined|NaN/);
  await expect(page.locator('.sk')).toHaveCount(0);
  await expect(page.getByText('No skills yet')).toBeVisible();

  // Prototype order of the sections, tabs and cards.
  const titles = await page
    .locator('h2, .l2tt, .l2h, [role=tab], .ctab-ph')
    .evaluateAll((els) => els.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()));
  let at = -1;
  for (const want of PROTOTYPE_ORDER) {
    const next = titles.findIndex((x, i) => i > at && (x === want || x.startsWith(`${want} `)));
    expect(next, `"${want}" after position ${at} in ${JSON.stringify(titles)}`).toBeGreaterThan(at);
    at = next;
  }

  // Composer: Email is the first tab and open, with the prototype's form; sending arrives in release 2.
  const compose = page.getByRole('region', { name: 'Compose' });
  const ctabs = await compose.getByRole('tab').evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
  expect(ctabs).toEqual(['Email', 'Call note', 'Meeting', 'Research note']);
  await expect(compose.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
  const email = compose.getByRole('form', { name: 'Email' });
  await expect(email.getByLabel('To', { exact: true })).toHaveValue('priya.raman@northwindlogistics.in');
  await expect(email.getByRole('combobox', { name: 'Cc stakeholders' })).toHaveAttribute('placeholder', 'Choose people or type an email…');
  await expect(email.getByLabel('Project')).toBeDisabled();
  await expect(email.getByLabel('Project').locator('option:checked')).toHaveText('available once the lead is Won');
  await expect(email.getByLabel('Template').locator('option:checked')).toHaveText('— blank —');
  await expect(email.getByLabel('Subject')).toHaveValue('Intro call this week?');
  await expect(email.getByLabel('Message')).toHaveValue(/^Hi Priya,\n\nThanks for getting in touch with DAIT Partners\. I'd love to hear more about what you're working on at Northwind Logistics\./);
  await expect(email.getByLabel('Message')).toHaveValue(/Best regards,\nMaya Pillai$/);
  await expect(email.getByRole('checkbox', { name: /Set follow-up in/ })).toBeChecked();
  await expect(email.getByLabel('Follow-up in', { exact: true })).toHaveValue('3');
  // A typed address becomes a chip.
  await email.getByRole('combobox', { name: 'Cc stakeholders' }).fill('ops@northwindlogistics.in');
  await email.getByRole('combobox', { name: 'Cc stakeholders' }).press('Enter');
  await expect(email.getByRole('button', { name: 'Remove ops@northwindlogistics.in' })).toBeVisible();
  await email.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sending email arrives in release 2' })).toBeVisible();
  await expect(email.getByLabel('Subject')).toHaveValue('Intro call this week?');
  // The topbar Email button opens the Email tab.
  await compose.getByRole('tab', { name: 'Meeting' }).click();
  await topbar.getByRole('button', { name: 'Email' }).click();
  await expect(compose.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
  // Focus on email folds the profile and puts the cursor in Subject.
  await compose.getByRole('tab', { name: 'Call note' }).click();
  await page.getByRole('button', { name: /Focus on email/ }).click();
  await expect(compose.getByRole('tab', { name: 'Email' })).toHaveAttribute('aria-selected', 'true');
  await expect(email.getByLabel('Subject')).toBeFocused();
  await page.getByRole('button', { name: /Show or hide the profile|Profile/ }).first().click();
  await expect(page.getByRole('region', { name: 'Original enquiry' })).toContainText('Available in release 1D');

  // Fill the profile and add a research note, then capture the page for the side-by-side comparison.
  const detail = (await (await page.request.get(`/api/leads/${lead.id}`)).json()) as { updatedAt: string; contact: { updatedAt: string } };
  const saved = await page.request.patch(`/api/contacts/${priya.id}`, {
    data: {
      updatedAt: detail.contact.updatedAt,
      headline: 'Head of Operations at Northwind Logistics · Warehouse automation & 3PL',
      location: 'Pune, Maharashtra, India',
      about: 'Operations leader with 14 years in logistics and supply chain. Runs three warehouses across Maharashtra.',
      experience: [
        { title: 'Head of Operations', company: 'Northwind Logistics', from: '2021', to: null, description: 'Leads warehousing and transport for 3 sites.' },
        { title: 'Regional Operations Manager', company: 'Gati-KWE', from: '2016', to: '2021', description: null },
      ],
      skills: ['Warehouse management', 'WMS implementation', 'Lean'],
      languages: ['English', 'Hindi', 'Marathi'],
    },
  });
  expect(saved.status()).toBe(200);
  const note = await page.request.post(`/api/leads/${lead.id}/research`, {
    data: { title: 'LinkedIn: automation programme', url: 'https://northwindlogistics.in', updatedAt: detail.updatedAt },
  });
  expect(note.status()).toBe(201);
  await page.reload();
  await expect(profile.getByText('Current')).toBeVisible();
  await expect(page.locator('.sk')).toHaveCount(6);
  await captureParity(page, 'lead-page');
});

test('lead page: a prospect without a contact person', async ({ page }) => {
  await signInAs(page, MAYA);
  const companies = (await (await page.request.get('/api/companies?q=Helix')).json()) as { items: { id: number; name: string }[] };
  const helix = companies.items[0]!;
  const created = await page.request.post('/api/leads', {
    data: { leadType: 'Prospect', companyName: helix.name, linkCompanyId: helix.id, country: 'United Arab Emirates', leadSource: 'Google Places API' },
  });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number };
  await page.goto(`/leads/${lead.id}`);

  const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
  await expect(email.getByLabel('To', { exact: true })).toHaveValue('');
  await expect(email.getByLabel('To', { exact: true })).toHaveAttribute('placeholder', 'No email on file – add a contact');
  await expect(email.getByLabel('Message')).toHaveValue(new RegExp(`^Hi ${helix.name},`));
  await email.getByRole('button', { name: 'Send email' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sending email arrives in release 2' })).toBeVisible();
});
