import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { NEHA, signInAs } from './fixtures';
import { captureParity } from './parity/_shared';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';

/** Runs the queued sends against the fake Microsoft Graph (apps/api/test/e2e-send-jobs.ts) and returns what it was given. */
function runSends(): { to: string[]; subject: string; html: string; text: string }[] {
  const out = execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });
  return out.split('\n').filter((l) => l.startsWith('e2e-sent: ')).map((l) => JSON.parse(l.slice('e2e-sent: '.length)));
}

/** A formatted template as an uploaded Outlook file gives it (bold, a list, a link), with markup that must not survive. */
const OFT_HTML =
  '<html><head><style>p.MsoNormal{margin:0;font-family:Calibri,sans-serif}</style></head><body>'
  + '<p class="MsoNormal">Hi <b>{first_name}</b>,</p>'
  + '<p class="MsoNormal">Thanks for your time. <i>Next steps</i> for {company}:</p>'
  + '<ul><li>Discovery call</li><li>Proposal</li></ul>'
  + '<p class="MsoNormal"><a href="https://daitpartners.com">daitpartners.com</a></p>'
  // An inline picture (cid:, an attachment of the .oft) is not supported yet: it goes, with its handler.
  // A picture pointing at the CRM itself would be a signed-in request from the editor (security review I1): it goes.
  + '<img src="/api/mail/1"><img src="http://localhost:3097/api/me">'
  + '<img src="cid:image001.png@01DB" onerror="alert(1)"><script>alert(2)</script><p onclick="alert(3)">Best regards,<br>{me}</p></body></html>';

async function setLanguage(page: Page, lang: 'en' | 'es') {
  await page.goto('/settings');
  await page.getByLabel(lang === 'es' ? 'Language' : 'Idioma').selectOption(lang);
  await page.getByRole('button', { name: lang === 'es' ? 'Save' : 'Guardar' }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: lang === 'es' ? 'Configuración' : 'Settings', exact: true })).toBeVisible();
}

/** Formatted templates (owner, 24 Nov 2026: "while you select OFT template it comes as text, not in html formatted"). */
test('lead page Email tab: a formatted .oft template fills the editor formatted and is sent as HTML', async ({ page }) => {
  await signInAs(page, NEHA);
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const stamp = Date.now();
  const company = `Formatco ${stamp}`;
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number };
  const name = `Proposal ${stamp}`;
  const tplRes = await page.request.post('/api/email-templates', {
    data: { name, language: 'en', subject: 'Next steps for {company}', body: 'Hi {first_name},\n\nThanks for your time.', bodyHtml: OFT_HTML, sourceType: 'oft', fileName: 'Proposal.oft', fileSize: 9216 },
  });
  expect(tplRes.status()).toBe(201);
  const tpl = (await tplRes.json()) as { id: number; bodyHtml: string };
  // Sanitised on upload: formatting kept, the active parts gone.
  expect(tpl.bodyHtml).toContain('<b>{first_name}</b>');
  for (const bad of ['onerror', '<script', 'onclick', 'alert(', 'cid:', '<img', '/api/']) expect(tpl.bodyHtml).not.toContain(bad);

  try {
    await page.goto(`/leads/${lead.id}`);
    const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
    await email.getByLabel('Template').selectOption({ label: `${name} · .oft` });
    await expect(email.getByLabel('Subject')).toHaveValue(`Next steps for ${company}`);
    // The message shows formatted, in the sandboxed editing frame.
    const frame = email.locator('iframe#em-body');
    await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    const body = page.frameLocator('iframe#em-body').locator('body');
    await expect(body.locator('b')).toHaveText(company);
    await expect(body.locator('i')).toHaveText('Next steps');
    await expect(body.locator('ul > li')).toHaveText(['Discovery call', 'Proposal']);
    await expect(body.locator('a')).toHaveAttribute('href', 'https://daitpartners.com');
    await expect(body.locator('script, [onerror], [onclick]')).toHaveCount(0);
    // It can be edited: a line typed at the end, a word made bold from the toolbar.
    await body.locator('p').last().click();
    for (const key of ['ArrowDown', 'ArrowDown', 'End']) await page.keyboard.press(key);
    await page.keyboard.type(' (DAIT)');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
    await email.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' }).click();
    await expect(body.locator('b').last()).toHaveText('DAIT)');
    await email.getByLabel('To', { exact: true }).fill('client@example.com');
    await captureParity(page, 'template-html-lead-email-en');

    await email.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Email queued — it is sent from neha.kapoor@daitpartners.com' })).toBeVisible();
    const sent = runSends().filter((m) => m.subject === `Next steps for ${company}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain(`Hi <b>${company}</b>,`);
    expect(sent[0]!.html).toContain('<li>Discovery call</li>');
    expect(sent[0]!.html).toContain('href="https://daitpartners.com"');
    expect(sent[0]!.html).toContain('<b>DAIT)</b>');
    for (const bad of ['onerror', '<script', 'onclick', 'alert(']) expect(sent[0]!.html).not.toContain(bad);
    // The plain-text alternative.
    expect(sent[0]!.text).toContain(`Hi ${company},`);
    expect(sent[0]!.text).toContain('Discovery call');
    const panel = page.getByRole('region', { name: 'Follow-up and history' });
    await panel.getByRole('tab', { name: /^Emails/ }).click();
    await expect(panel.getByRole('listitem').filter({ hasText: `Next steps for ${company}` })).toBeVisible();

    // The same in Spanish (screenshot), then the Mailer's message step previews it formatted.
    await setLanguage(page, 'es');
    await page.goto(`/leads/${lead.id}`);
    const correo = page.getByRole('form', { name: 'Correo electrónico' });
    await correo.getByLabel('Plantilla').selectOption({ label: `${name} · .oft` });
    await expect(page.frameLocator('iframe#em-body').locator('b')).toHaveText(company);
    await expect(correo.getByRole('toolbar', { name: 'Formato' }).getByRole('button', { name: 'Negrita' })).toBeVisible();
    await captureParity(page, 'template-html-lead-email-es');
  } finally {
    await setLanguage(page, 'en');
  }

  try {
    await page.goto('/leads');
    await page.getByRole('checkbox', { name: 'Select LD-1001 Northwind Logistics', exact: true }).check();
    await page.getByRole('region', { name: 'Bulk actions' }).getByRole('button', { name: 'Send via mailer' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send via mailer' });
    await dialog.getByLabel('Template').selectOption({ label: `${name} · .oft (EN)` });
    const preview = dialog.frameLocator('.mprev iframe').locator('body');
    await expect(preview.locator('b').first()).toHaveText('Priya');
    await expect(preview.locator('ul > li')).toHaveText(['Discovery call', 'Proposal']);
    await captureParity(page, 'template-html-mailer');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    // Other specs pick the first template: leave the library as it was.
    await page.request.delete(`/api/email-templates/${tpl.id}`);
  }
});
