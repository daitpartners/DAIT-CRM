import { execFileSync } from 'node:child_process';
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { NEHA, signInAs } from './fixtures';
import { captureParity } from './parity/_shared';
import { syntheticTemplate } from '../test/oftFixture';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://mac@localhost:5432/dait_crm_e2e';

type Sent = {
  to: string[]; subject: string; html: string; text: string;
  attachments: { name: string; contentType: string; isInline: boolean; contentId: string | null; size: number }[];
};

/** Runs the queued sends against the fake Microsoft Graph (apps/api/test/e2e-send-jobs.ts) and returns what it was given. */
function runSends(): Sent[] {
  const out = execFileSync('npx', ['tsx', 'test/e2e-send-jobs.ts'], { cwd: new URL('../../api/', import.meta.url), env: { ...process.env, DATABASE_URL: DB }, encoding: 'utf8' });
  return out.split('\n').filter((l) => l.startsWith('e2e-sent: ')).map((l) => JSON.parse(l.slice('e2e-sent: '.length)));
}

async function setLanguage(page: Page, lang: 'en' | 'es') {
  await page.goto('/settings');
  await page.getByLabel(lang === 'es' ? 'Language' : 'Idioma').selectOption(lang);
  await page.getByRole('button', { name: lang === 'es' ? 'Save' : 'Guardar' }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: lang === 'es' ? 'Configuración' : 'Settings', exact: true })).toBeVisible();
}

/** Both inline pictures show in the frame: data: URLs that decoded (a picture that failed has no natural width). */
async function expectPictures(frame: FrameLocator) {
  const imgs = frame.locator('body img');
  await expect(imgs).toHaveCount(2);
  for (const i of [0, 1]) {
    await expect(imgs.nth(i)).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect.poll(() => imgs.nth(i).evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
}

/**
 * Template pictures and attachments (owner, 24 Nov 2026: "it does not look good in plain text, how can be fixed with
 * images and everything similar to outlook"). A synthetic .oft (two inline logos and a PDF; no real content) is
 * uploaded, used on the lead page Email tab, and sent: the fake Graph gets the pictures inline and the PDF attached.
 */
test('an .oft with inline pictures and a PDF: uploaded, shown in the lead Email tab, sent with its files', async ({ page }) => {
  test.setTimeout(90_000);
  await signInAs(page, NEHA);
  const { oft, logo, signature, pdf } = syntheticTemplate();
  const stamp = Date.now();
  const name = `Holiday ${stamp}`;
  const me = (await (await page.request.get('/api/me')).json()) as { id: number };
  const company = `Pictureco ${stamp}`;
  const created = await page.request.post('/api/leads', { data: { companyName: company, country: 'India', leadSource: 'Referral', assignedToId: me.id } });
  expect(created.status()).toBe(201);
  const lead = (await created.json()) as { id: number };
  let templateId: number | null = null;

  try {
    // Upload: the browser reads the file's pictures and PDF; the editor shows the pictures, the PDF is listed.
    await page.goto('/settings/templates');
    const card = page.getByRole('region', { name: 'Email templates' });
    await card.getByLabel('Upload .oft template').setInputFiles({ name: 'Holiday-test.oft', mimeType: 'application/vnd.ms-outlook', buffer: Buffer.from(oft) });
    const editor = page.getByRole('dialog', { name: 'Write a template' });
    await expect(editor).toContainText('Read from Holiday-test.oft');
    await expect(editor.getByLabel('Subject')).toHaveValue('Season’s greetings, {first_name}');
    await expectPictures(page.frameLocator('iframe#tpl-body'));
    await expect(editor.getByRole('list', { name: 'Attachments' }).getByRole('listitem')).toHaveText([/^Season-brochure\.pdf · \d+ KB/]);
    await editor.getByLabel('Name').fill(name);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toBeHidden();
    const row = card.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText('Formatted');
    await expect(row).toContainText('Files: 3');

    const list = (await (await page.request.get('/api/email-templates')).json()) as { items: { id: number; name: string; bodyHtml: string; attachments: { name: string; size: number; inline: boolean; contentId: string | null }[] }[] };
    const tpl = list.items.find((x) => x.name === name)!;
    templateId = tpl.id;
    expect(tpl.attachments.map((a) => [a.name, a.inline, a.contentId, a.size])).toEqual([
      ['test-logo.png', true, 'test-logo.png', logo.length],
      ['test-signature.png', true, 'test-signature.png', signature.length],
      ['Season-brochure.pdf', false, null, pdf.length],
    ]);
    // Stored as cid: (what Outlook sends), never as the data: URLs the editor showed.
    expect(tpl.bodyHtml).toContain('src="cid:test-logo.png"');
    expect(tpl.bodyHtml).not.toContain('data:');

    // The lead page Email tab: the logos show in the message, the PDF is listed under it.
    await page.goto(`/leads/${lead.id}`);
    const email = page.getByRole('region', { name: 'Compose' }).getByRole('form', { name: 'Email' });
    await email.getByLabel('Template').selectOption({ label: `${name} · .oft` });
    await expect(email.getByLabel('Subject')).toHaveValue(/^Season’s greetings, /);
    const frame = page.frameLocator('iframe#em-body');
    await expectPictures(frame);
    await expect(frame.locator('body b')).toHaveText(company);
    const files = email.getByRole('list', { name: 'Attachments' });
    await expect(files.getByRole('listitem')).toHaveText([/^Season-brochure\.pdf · \d+ KB/]);
    await expect(files.getByRole('button', { name: 'Remove Season-brochure.pdf' })).toBeVisible();
    await email.getByLabel('To', { exact: true }).fill('client@example.com');
    await captureParity(page, 'template-attachments-lead-email-en');

    await email.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Email queued — it is sent from neha.kapoor@daitpartners.com' })).toBeVisible();
    const sent = runSends().filter((m) => m.to.includes('client@example.com') && m.html.includes(company));
    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    expect(msg.html).toContain('src="cid:test-logo.png"');
    expect(msg.html).toContain('src="cid:test-signature.png"');
    expect(msg.html).not.toContain('data:image');
    expect(msg.attachments).toEqual([
      { name: 'test-logo.png', contentType: 'image/png', isInline: true, contentId: 'test-logo.png', size: logo.length },
      { name: 'test-signature.png', contentType: 'image/png', isInline: true, contentId: 'test-signature.png', size: signature.length },
      { name: 'Season-brochure.pdf', contentType: 'application/pdf', isInline: false, contentId: null, size: pdf.length },
    ]);

    // The same in Spanish (screenshot).
    await setLanguage(page, 'es');
    await page.goto(`/leads/${lead.id}`);
    const correo = page.getByRole('form', { name: 'Correo electrónico' });
    await correo.getByLabel('Plantilla').selectOption({ label: `${name} · .oft` });
    await expectPictures(page.frameLocator('iframe#em-body'));
    await expect(correo.getByRole('list', { name: 'Adjuntos' }).getByRole('button', { name: 'Quitar Season-brochure.pdf' })).toBeVisible();
    await correo.getByLabel('Para', { exact: true }).fill('client@example.com');
    await captureParity(page, 'template-attachments-lead-email-es');
  } finally {
    await setLanguage(page, 'en');
    // Other specs pick the first template: leave the library as it was.
    if (templateId) await page.request.delete(`/api/email-templates/${templateId}`);
  }
});
