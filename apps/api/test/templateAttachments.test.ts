import type { FastifyInstance } from 'fastify';
import type { Job } from '@prisma/client';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEMPLATE_ATTACHMENTS_MAX_BYTES } from '@dait-crm/shared';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import type { GraphClient, MailMessage } from '../src/graph/client';
import { runOnce } from '../src/jobs/runner';
import { sendUserEmailHandler } from '../src/jobs/handlers/sendUserEmail';
import { campaignStepHandler } from '../src/jobs/handlers/campaignStep';
import { GRAPH_REQUEST_MAX, checkRequestSize, checkUploads, cleanCid, cleanFileName, readStoredFile, sniff } from '../src/mail/files';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Template pictures and attachments (owner, 24 Nov 2026): the files of an .oft kept, checked and sent with the HTML. */

let app: FastifyInstance;
let storage: string;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb();
  await seedLookups();
  storage = await mkdtemp(path.join(tmpdir(), 'crm-tpl-'));
  vi.stubEnv('STORAGE_DIR', storage);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(storage, { recursive: true, force: true });
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, cookie?: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload } : {}) });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('logo-bytes')]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('signature')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const b64 = (b: Buffer) => b.toString('base64');

const FILES = [
  { name: 'dait-logo.png', contentId: 'dait-logo.png', inline: true, data: b64(PNG) },
  { name: 'signature.png', contentId: 'sig@01DB', inline: true, data: b64(PNG2) },
  { name: 'Brochure 2026.pdf', inline: false, data: b64(PDF) },
];
const HTML = '<p>Hi <b>{first_name}</b></p><img src="cid:dait-logo.png" alt="DAIT"><img src="cid:SIG@01DB"><img src="cid:other.png"><p>{me}</p>';

const template = (extra: Record<string, unknown> = {}) => ({
  name: 'Holiday', language: 'en', subject: 'Season’s greetings, {first_name}', body: 'Hi', bodyHtml: HTML, sourceType: 'oft', fileName: 'Holiday.oft', fileSize: 1200,
  attachments: FILES, ...extra,
});

type TemplateJson = { id: number; updatedAt: string; bodyHtml: string; attachments: { id: number; name: string; contentType: string; size: number; contentId: string | null; inline: boolean }[] };

async function filesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(path.join(storage, dir));
  } catch {
    return [];
  }
}

describe('checking uploaded files', () => {
  it('works out the type from the bytes, never the name', () => {
    expect(sniff(PNG, 'x.pdf')?.contentType).toBe('image/png');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'a')?.contentType).toBe('image/jpeg');
    expect(sniff(Buffer.from('GIF89a....'), 'a')?.contentType).toBe('image/gif');
    expect(sniff(PDF, 'x.png')?.contentType).toBe('application/pdf');
    expect(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'a.docx')?.contentType).toContain('wordprocessingml');
    expect(sniff(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'a.xls')?.contentType).toBe('application/vnd.ms-excel');
    // A zip that is not an Office file by name, an executable, HTML, SVG: refused.
    expect(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), 'a.zip')).toBeNull();
    expect(sniff(Buffer.from('MZ\x90\x00'), 'a.pdf')).toBeNull();
    expect(sniff(Buffer.from('<html><script>'), 'a.png')).toBeNull();
    expect(sniff(Buffer.from('<svg onload=alert(1)>'), 'a.svg')).toBeNull();
  });

  it('cleans file names and content-ids', () => {
    const png = sniff(PNG, '')!;
    expect(cleanFileName('../../etc/passwd', png)).toBe('passwd.png');
    expect(cleanFileName('C:\\Users\\x\\logo.png', png)).toBe('logo.png');
    expect(cleanFileName('a<b>"c|?*.png', png)).toBe('abc.png');
    expect(cleanFileName('...hidden.png', png)).toBe('hidden.png');
    expect(cleanFileName('report\u202Egnp.exe', png)).toBe('reportgnp.exe.png');
    expect(cleanFileName(`${'x'.repeat(300)}.png`, png)).toHaveLength(120);
    // Invisible and bidi format characters (\p{Cf}) and line separators go; Windows device names are prefixed (M4).
    expect(cleanFileName('in\u200Fvoice\u200E\u061C\u200B\u2028.png', png)).toBe('invoice.png');
    expect(cleanFileName('CON.png', png)).toBe('_CON.png');
    expect(cleanFileName('lpt1', png)).toBe('_lpt1.png');
    expect(cleanFileName('Console.png', png)).toBe('Console.png');
    expect(cleanCid('<image001.png@01DB1234.5678>')).toBe('image001.png@01DB1234.5678');
    expect(cleanCid('a"b')).toBeNull();
    expect(cleanCid('a b')).toBeNull();
    expect(cleanCid('x/../y')).toBeNull();
  });

  it('refuses a file too large, too many bytes together, a wrong type, a document shown inline, a duplicate content-id', () => {
    const big = Buffer.alloc(TEMPLATE_ATTACHMENTS_MAX_BYTES + 1, 1);
    PDF.copy(big);
    expect(() => checkUploads([{ name: 'big.pdf', inline: false, data: b64(big) }])).toThrow('attachments_too_large');
    const half = Buffer.alloc(TEMPLATE_ATTACHMENTS_MAX_BYTES / 2 + 10, 1);
    PDF.copy(half);
    expect(() => checkUploads([{ name: 'a.pdf', inline: false, data: b64(half) }, { name: 'b.pdf', inline: false, data: b64(half) }])).toThrow('attachments_too_large');
    expect(() => checkUploads([{ name: 'a.exe', inline: false, data: b64(Buffer.from('MZ')) }])).toThrow('attachment_type');
    expect(() => checkUploads([{ name: 'a.pdf', contentId: 'a', inline: true, data: b64(PDF) }])).toThrow('attachment_type');
    expect(() => checkUploads([
      { name: 'a.png', contentId: 'x', inline: true, data: b64(PNG) }, { name: 'b.png', contentId: 'X', inline: true, data: b64(PNG) },
    ])).toThrow('attachment_invalid');
    expect(() => checkUploads([{ name: 'a.png', contentId: 'bad id', inline: true, data: b64(PNG) }])).toThrow('attachment_invalid');
  });

  it('never reads a stored path outside its folder', async () => {
    await expect(readStoredFile('templates/../../etc/passwd')).rejects.toThrow('outside storage');
    await expect(readStoredFile('/etc/passwd')).rejects.toThrow('outside storage');
  });
});

describe('template files API', () => {
  it('stores the files (0600, ids-only paths), keeps only cid: pictures of its own inline files, lists them', async () => {
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const res = await call('POST', '/api/email-templates', await signIn(app, rep), template());
    expect(res.statusCode).toBe(201);
    const t = res.json() as TemplateJson;
    expect(t.attachments).toEqual([
      { id: expect.any(Number), name: 'dait-logo.png', contentType: 'image/png', size: PNG.length, contentId: 'dait-logo.png', inline: true },
      { id: expect.any(Number), name: 'signature.png', contentType: 'image/png', size: PNG2.length, contentId: 'sig@01DB', inline: true },
      { id: expect.any(Number), name: 'Brochure 2026.pdf', contentType: 'application/pdf', size: PDF.length, contentId: null, inline: false },
    ]);
    // cid: kept for its own inline pictures (any case), dropped for one it does not have.
    expect(t.bodyHtml).toContain('src="cid:dait-logo.png"');
    // Kept in the stored content-id's own case (review I2): the HTML said SIG@01DB, the file says sig@01DB.
    expect(t.bodyHtml).toContain('src="cid:sig@01DB"');
    expect(t.bodyHtml).not.toContain('cid:other.png');
    const rows = await prisma.emailTemplateAttachment.findMany({ where: { templateId: t.id }, orderBy: { id: 'asc' } });
    for (const r of rows) {
      expect(r.storagePath).toMatch(new RegExp(`^templates/${t.id}/[0-9a-f-]{36}$`));
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect((await stat(path.join(storage, r.storagePath))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(path.join(storage, `templates/${t.id}`))).mode & 0o777).toBe(0o700);
    // Every signed-in user lists them (every compose box offers templates).
    const other = await signIn(app, await makeUser({ role: 'DATA_RESEARCH_USER' }));
    expect((await call('GET', '/api/email-templates', other)).json().items[0].attachments).toHaveLength(3);
    // The audit record names the files, never their bytes.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'email_template', action: 'create' } });
    expect(log.after).toMatchObject({ attachments: [{ name: 'dait-logo.png', inline: true }, { name: 'signature.png' }, { name: 'Brochure 2026.pdf', inline: false }] });
    expect(JSON.stringify(log)).not.toContain(b64(PDF));
  });

  it('a template without files keeps no cid: picture at all', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const res = await call('POST', '/api/email-templates', cookie, template({ attachments: undefined }));
    expect(res.json().bodyHtml).not.toContain('cid:');
    expect(res.json().attachments).toEqual([]);
  });

  it('download: signed-in users only, always as an attachment with nosniff; only a file of that template', async () => {
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const t = (await call('POST', '/api/email-templates', await signIn(app, rep), template())).json() as TemplateJson;
    const [logo, , pdf] = t.attachments;
    expect((await call('GET', `/api/email-templates/${t.id}/attachments/${logo!.id}`)).statusCode).toBe(401);
    const viewer = await signIn(app, await makeUser({ role: 'DATA_RESEARCH_USER' }));
    const res = await call('GET', `/api/email-templates/${t.id}/attachments/${logo!.id}`, viewer);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="dait-logo.png"; filename*=UTF-8''dait-logo.png`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    const doc = await call('GET', `/api/email-templates/${t.id}/attachments/${pdf!.id}`, viewer);
    expect(doc.headers['content-disposition']).toContain('filename*=UTF-8\'\'Brochure%202026.pdf');
    // Another template's id with this file, or a file that does not exist: 404.
    const other = (await call('POST', '/api/email-templates', await signIn(app, rep), template({ name: 'B', attachments: [] }))).json() as TemplateJson;
    expect((await call('GET', `/api/email-templates/${other.id}/attachments/${logo!.id}`, viewer)).statusCode).toBe(404);
    expect((await call('GET', `/api/email-templates/${t.id}/attachments/999999`, viewer)).statusCode).toBe(404);
    expect((await call('GET', `/api/email-templates/${t.id}/attachments/..%2F..%2Fetc`, viewer)).statusCode).toBe(404);
  });

  it('413 attachments_too_large, 422 attachment_type: nothing saved, no file left behind', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const big = Buffer.alloc(TEMPLATE_ATTACHMENTS_MAX_BYTES - 50, 1);
    PDF.copy(big);
    const tooMuch = await call('POST', '/api/email-templates', cookie, template({ attachments: [...FILES, { name: 'big.pdf', inline: false, data: b64(big) }] }));
    expect(tooMuch.statusCode).toBe(413);
    expect(tooMuch.json().error).toBe('attachments_too_large');
    const exe = await call('POST', '/api/email-templates', cookie, template({ attachments: [{ name: 'invoice.pdf', inline: false, data: b64(Buffer.from('MZ\x90\x00binary')) }] }));
    expect(exe.statusCode).toBe(422);
    expect(exe.json().error).toBe('attachment_type');
    expect(await prisma.emailTemplate.count()).toBe(0);
    expect(await filesIn('templates')).toEqual([]);
  });

  it('replacing the files removes the old ones; a failed replace keeps them; deleting the template removes its folder', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const t = (await call('POST', '/api/email-templates', cookie, template())).json() as TemplateJson;
    const oldPaths = (await prisma.emailTemplateAttachment.findMany({ where: { templateId: t.id } })).map((a) => a.storagePath);
    expect(await filesIn(`templates/${t.id}`)).toHaveLength(3);

    // A refused replace changes nothing.
    const bad = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { attachments: [{ name: 'x.png', inline: false, data: b64(Buffer.from('nope')) }], updatedAt: t.updatedAt });
    expect(bad.statusCode).toBe(422);
    expect(await filesIn(`templates/${t.id}`)).toHaveLength(3);

    // Only the logo now: the stored HTML is sanitised again, keeping only that cid: picture.
    const res = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { attachments: [FILES[0]], updatedAt: t.updatedAt });
    expect(res.statusCode).toBe(200);
    const after = res.json() as TemplateJson;
    expect(after.attachments.map((a) => a.name)).toEqual(['dait-logo.png']);
    expect(after.bodyHtml).toContain('cid:dait-logo.png');
    expect(after.bodyHtml).not.toContain('cid:SIG@01DB');
    const files = await filesIn(`templates/${t.id}`);
    expect(files).toHaveLength(1);
    for (const p of oldPaths) expect(files).not.toContain(path.basename(p));

    // A change without files keeps them.
    const renamed = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { name: 'Renamed', updatedAt: after.updatedAt });
    expect(renamed.json().attachments).toHaveLength(1);
    // New HTML keeps the cid: pictures of the files the template has.
    const html = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { bodyHtml: '<p>x</p><img src="cid:dait-logo.png"><img src="cid:sig@01DB">', updatedAt: renamed.json().updatedAt });
    expect(html.json().bodyHtml).toBe('<p>x</p><img src="cid:dait-logo.png" />');

    expect((await call('DELETE', `/api/email-templates/${t.id}`, cookie)).statusCode).toBe(204);
    expect(await prisma.emailTemplateAttachment.count()).toBe(0);
    expect(await filesIn('templates')).toEqual([]);
  });

  it('sanitize (uploaded .oft preview) keeps the cid: pictures it is told about', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const res = await call('POST', '/api/email-templates/sanitize', cookie, { html: HTML, cids: ['dait-logo.png'] });
    expect(res.json().html).toContain('src="cid:dait-logo.png"');
    expect(res.json().html).not.toContain('cid:SIG');
    expect((await call('POST', '/api/email-templates/sanitize', cookie, { html: HTML })).json().html).not.toContain('cid:');
  });
});

/* ------------------------------------------------------------------ sending */

async function sender() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Sebastian Passalacqua' });
  await prisma.emailAccount.create({ data: { address: 'seba@daitpartners.com', provider: 'microsoft', kind: 'personal', userId: rep.id, refreshTokenEnc: encrypt('rt'), status: 'connected' } });
  const company = await makeCompany({ name: 'Grupo Andino' });
  const contact = await makeContact({ companyId: company.id, firstName: 'Ana', lastName: 'Torres', businessEmail: 'ana@andino.cl' });
  const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: rep.id, status: 'Contacted' });
  const cookie = await signIn(app, rep);
  const res = await call('POST', '/api/email-templates', cookie, template());
  expect(res.statusCode).toBe(201);
  const t = res.json() as TemplateJson;
  return { rep, lead, cookie, t, company };
}

function recordingGraph(): GraphClient & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { ...fakeGraph(), sent, async sendMail(_a, msg) { sent.push(msg); } };
}
const runSends = (graph: GraphClient) => runOnce({ types: ['send_user_email'], handlers: { send_user_email: sendUserEmailHandler }, graph });

describe('sending a template with files', () => {
  it('lead email: inline pictures (isInline + contentId) and the kept attachment go to Graph; the message lists the attachment', async () => {
    const { lead, cookie, t } = await sender();
    const pdf = t.attachments.find((a) => !a.inline)!;
    const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, {
      to: 'ana@andino.cl', cc: [], subject: 'Season’s greetings', body: 'Hi', bodyHtml: t.bodyHtml.replace('{first_name}', 'Ana'),
      templateId: t.id, attachmentIds: [pdf.id], updatedAt: lead.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(201);
    const graph = recordingGraph();
    await runSends(graph);
    expect(graph.sent).toHaveLength(1);
    const msg = graph.sent[0]!;
    expect(msg.html).toContain('src="cid:dait-logo.png"');
    expect(msg.attachments).toEqual([
      { name: 'dait-logo.png', contentType: 'image/png', contentBase64: b64(PNG), isInline: true, contentId: 'dait-logo.png' },
      { name: 'signature.png', contentType: 'image/png', contentBase64: b64(PNG2), isInline: true, contentId: 'sig@01DB' },
      { name: 'Brochure 2026.pdf', contentType: 'application/pdf', contentBase64: b64(PDF) },
    ]);
    const stored = await prisma.emailMessage.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(stored.attachmentNames).toEqual(['Brochure 2026.pdf']);
    expect(stored.status).toBe('sent');
  });

  it('a removed attachment and a picture taken out of the message are not sent; a cid: the template lacks is dropped', async () => {
    const { lead, cookie, t } = await sender();
    const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, {
      to: 'ana@andino.cl', cc: [], subject: 'S', body: 'Hi', bodyHtml: '<p>Hi</p><img src="cid:dait-logo.png"><img src="cid:image009.png">',
      templateId: t.id, attachmentIds: [], updatedAt: lead.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(201);
    const graph = recordingGraph();
    await runSends(graph);
    expect(graph.sent[0]!.html).not.toContain('image009');
    expect(graph.sent[0]!.attachments?.map((a) => a.name)).toEqual(['dait-logo.png']);
  });

  it('without a template no cid: picture survives; attachments no longer the template’s are 409 template_files_missing, without one a 400', async () => {
    const { lead, cookie, t } = await sender();
    const other = (await call('POST', '/api/email-templates', cookie, template({ name: 'Other' }))).json() as TemplateJson;
    const base = { to: 'ana@andino.cl', cc: [], subject: 'S', body: 'Hi', updatedAt: lead.updatedAt.toISOString() };
    const wrong = await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...base, templateId: t.id, attachmentIds: [other.attachments[2]!.id] });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toEqual({ error: 'template_files_missing' });
    // An inline picture is not a "kept attachment" either.
    expect((await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...base, templateId: t.id, attachmentIds: [t.attachments[0]!.id] })).statusCode).toBe(409);
    expect((await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...base, attachmentIds: [t.attachments[2]!.id] })).statusCode).toBe(400);
    expect((await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...base, templateId: 999999 })).statusCode).toBe(404);
    const plain = await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...base, bodyHtml: '<p>Hi</p><img src="cid:dait-logo.png">' });
    expect(plain.statusCode).toBe(201);
    const graph = recordingGraph();
    await runSends(graph);
    expect(graph.sent[0]!.html).not.toContain('cid:');
    expect(graph.sent[0]!.attachments).toBeUndefined();
  });

  it('413 attachments_too_large when the files together are over the cap (a template stored before a lower cap)', async () => {
    const { lead, cookie, t } = await sender();
    await prisma.emailTemplateAttachment.updateMany({ where: { templateId: t.id, isInline: false }, data: { size: TEMPLATE_ATTACHMENTS_MAX_BYTES } });
    const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, {
      to: 'ana@andino.cl', cc: [], subject: 'S', body: 'Hi', bodyHtml: t.bodyHtml, templateId: t.id, attachmentIds: [t.attachments[2]!.id], updatedAt: lead.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('attachments_too_large');
    expect(await prisma.emailMessage.count()).toBe(0);
  });

  it('Compose (Email screen) sends a template’s files too', async () => {
    const { cookie, t } = await sender();
    const res = await call('POST', '/api/mail', cookie, {
      to: 'someone@example.com', cc: [], subject: 'S', body: 'Hi', bodyHtml: t.bodyHtml, templateId: t.id, attachmentIds: [t.attachments[2]!.id],
    });
    expect(res.statusCode).toBe(201);
    const graph = recordingGraph();
    await runSends(graph);
    expect(graph.sent[0]!.attachments?.map((a) => [a.name, a.isInline ?? false])).toEqual([['dait-logo.png', true], ['signature.png', true], ['Brochure 2026.pdf', false]]);
  });

  it('Mailer: the campaign keeps its own copies of the files, and each email sends them even after the template is deleted', async () => {
    const { rep, lead, cookie, t } = await sender();
    const created = await call('POST', '/api/mailer', cookie, {
      leadIds: [lead.id], name: 'Holiday', templateId: t.id, cc: [], bcc: [], startAt: null, intervalMinutes: 3,
      workingHoursOnly: false, unsubscribeLine: true, lawfulBasis: 'Legitimate interest (B2B outreach relevant to their role)',
    });
    expect(created.statusCode).toBe(201);
    const c = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: created.json().id } });
    const copies = c.attachments as { storagePath: string; fileName: string }[];
    expect(copies.map((f) => f.fileName)).toEqual(['dait-logo.png', 'signature.png', 'Brochure 2026.pdf']);
    for (const f of copies) expect(f.storagePath).toMatch(new RegExp(`^campaigns/${c.id}/[0-9a-f-]{36}$`));
    expect((await call('DELETE', `/api/email-templates/${t.id}`, cookie)).statusCode).toBe(204);

    const sent: MailMessage[] = [];
    await campaignStepHandler({ id: 1, type: 'campaign_step', payload: { campaignId: c.id }, attempts: 0, maxAttempts: 1 } as unknown as Job, {
      graph: fakeGraph({ async sendMail(_a, m) { sent.push(m); } }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('src="cid:dait-logo.png"');
    expect(sent[0]!.html).toContain('unsubscribe');
    expect(sent[0]!.attachments?.map((a) => ({ name: a.name, isInline: a.isInline ?? false, contentId: a.contentId ?? null }))).toEqual([
      { name: 'dait-logo.png', isInline: true, contentId: 'dait-logo.png' },
      { name: 'signature.png', isInline: true, contentId: 'sig@01DB' },
      { name: 'Brochure 2026.pdf', isInline: false, contentId: null },
    ]);
    const msg = await prisma.emailMessage.findFirstOrThrow({ where: { campaignId: c.id, userId: rep.id } });
    expect(msg.attachmentNames).toEqual(['Brochure 2026.pdf']);
  });
});


/* ------------------------------------------------------------------ security review fixes (25 Nov 2026) */

describe('security review fixes', () => {
  // A fresh app: the per-user rate limits (30 template saves a minute) are counted per app, and user ids repeat after
  // each reset, so the earlier tests would otherwise use up this user's minute.
  beforeAll(async () => {
    await app.close();
    app = await buildApp();
  });

  it('I1: the cap is 2.5 MB, and a message whose Graph request would pass 3.9 MB is refused when queued (413)', () => {
    expect(TEMPLATE_ATTACHMENTS_MAX_BYTES).toBe(2_500_000);
    expect(GRAPH_REQUEST_MAX).toBe(3_900_000);
    // Files at the cap with ordinary HTML fit; the same files with 190,000 characters of three-byte text do not.
    expect(() => checkRequestSize(Math.ceil(2_500_000 / 3) * 4, '<p>Hi</p>')).not.toThrow();
    expect(() => checkRequestSize(Math.ceil(2_500_000 / 3) * 4, `<p>${'€'.repeat(190_000)}</p>`)).toThrow('attachments_too_large');
  });

  it('I1: lead send at the cap with very long HTML is 413 attachments_too_large and nothing is queued', async () => {
    const { lead, cookie } = await sender();
    const big = Buffer.alloc(TEMPLATE_ATTACHMENTS_MAX_BYTES - PNG.length, 1);
    PDF.copy(big);
    const t = (await call('POST', '/api/email-templates', cookie, template({ name: 'Big', attachments: [FILES[0], { name: 'big.pdf', inline: false, data: b64(big) }] }))).json() as TemplateJson;
    const base = { to: 'ana@andino.cl', cc: [], subject: 'S', body: 'Hi', templateId: t.id, attachmentIds: [t.attachments[1]!.id], updatedAt: lead.updatedAt.toISOString() };
    const long = await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...base, bodyHtml: `<p>${'€'.repeat(190_000)}</p><img src="cid:dait-logo.png">` });
    expect(long.statusCode).toBe(413);
    expect(long.json()).toEqual({ error: 'attachments_too_large' });
    expect(await prisma.emailMessage.count()).toBe(0);
    // The same files with an ordinary message go, and the request Graph gets is under its limit.
    const ok = await call('POST', `/api/leads/${lead.id}/emails`, cookie, { ...base, bodyHtml: t.bodyHtml });
    expect(ok.statusCode).toBe(201);
    const graph = recordingGraph();
    await runSends(graph);
    const m = graph.sent[0]!;
    const size = JSON.stringify({ message: { body: { content: m.html }, attachments: m.attachments } }).length;
    expect(size).toBeLessThan(GRAPH_REQUEST_MAX);
  });

  it('I2: an Outlook-style cid goes to Graph in the file’s exact case, in the HTML and as contentId', async () => {
    const { lead, cookie } = await sender();
    const cid = 'image001.png@01DB4F1E.6B7C5A40';
    const t = (await call('POST', '/api/email-templates', cookie, template({
      name: 'Outlook', bodyHtml: `<p>Hi</p><img src="cid:${cid}">`, attachments: [{ name: 'image001.png', contentId: cid, inline: true, data: b64(PNG) }],
    }))).json() as TemplateJson;
    expect(t.bodyHtml).toContain(`src="cid:${cid}"`);
    // A browser or editor that lower-cased it: still sent as the file has it.
    const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, {
      to: 'ana@andino.cl', cc: [], subject: 'S', body: 'Hi', bodyHtml: `<p>Hi</p><img src="cid:${cid.toLowerCase()}">`, templateId: t.id, attachmentIds: [], updatedAt: lead.updatedAt.toISOString(),
    });
    expect(res.statusCode).toBe(201);
    const graph = recordingGraph();
    await runSends(graph);
    expect(graph.sent[0]!.html).toContain(`src="cid:${cid}"`);
    expect(graph.sent[0]!.attachments).toEqual([{ name: 'image001.png', contentType: 'image/png', contentBase64: b64(PNG), isInline: true, contentId: cid }]);
  });

  it('I3: replacing only the files moves updatedAt, so a stale copy is refused (409)', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const t = (await call('POST', '/api/email-templates', cookie, template({ bodyHtml: undefined, body: 'Plain', attachments: [FILES[2]] }))).json() as TemplateJson;
    const first = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { attachments: [{ ...FILES[2], name: 'New.pdf' }], updatedAt: t.updatedAt });
    expect(first.statusCode).toBe(200);
    expect(first.json().updatedAt).not.toBe(t.updatedAt);
    const stale = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { attachments: [{ ...FILES[2], name: 'Other.pdf' }], updatedAt: t.updatedAt });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stale');
    expect((await prisma.emailTemplateAttachment.findMany({ where: { templateId: t.id } })).map((a) => a.fileName)).toEqual(['New.pdf']);
    expect(await filesIn(`templates/${t.id}`)).toHaveLength(1);
  });

  it('I4: a stored file gone from disk is 409 template_files_missing on lead send, Compose and Mailer create, with no path', async () => {
    const { lead, cookie, t } = await sender();
    const row = await prisma.emailTemplateAttachment.findFirstOrThrow({ where: { templateId: t.id, isInline: false } });
    await rm(path.join(storage, row.storagePath));
    const lead1 = await call('POST', `/api/leads/${lead.id}/emails`, cookie, {
      to: 'ana@andino.cl', cc: [], subject: 'S', body: 'Hi', bodyHtml: t.bodyHtml, templateId: t.id, attachmentIds: [row.id], updatedAt: lead.updatedAt.toISOString(),
    });
    expect(lead1.statusCode).toBe(409);
    expect(lead1.json()).toEqual({ error: 'template_files_missing' });
    const compose = await call('POST', '/api/mail', cookie, { to: 'x@example.com', cc: [], subject: 'S', body: 'Hi', bodyHtml: t.bodyHtml, templateId: t.id, attachmentIds: [row.id] });
    expect(compose.statusCode).toBe(409);
    const mailer = await call('POST', '/api/mailer', cookie, {
      leadIds: [lead.id], name: 'X', templateId: t.id, cc: [], bcc: [], startAt: null, intervalMinutes: 3,
      workingHoursOnly: false, unsubscribeLine: true, lawfulBasis: 'Legitimate interest (B2B outreach relevant to their role)',
    });
    expect(mailer.statusCode).toBe(409);
    expect(mailer.json()).toEqual({ error: 'template_files_missing' });
    expect(await prisma.emailCampaign.count()).toBe(0);
    expect(await filesIn('campaigns')).toEqual([]);
    for (const r of [lead1, compose, mailer]) expect(r.body).not.toContain(storage);
    expect(await prisma.emailMessage.count()).toBe(0);
  });

  it('I4: any other server error is answered without its message', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const t = (await call('POST', '/api/email-templates', cookie, template())).json() as TemplateJson;
    const row = await prisma.emailTemplateAttachment.findFirstOrThrow({ where: { templateId: t.id } });
    // A directory where the file should be: EISDIR, not a missing file.
    await rm(path.join(storage, row.storagePath));
    await mkdir(path.join(storage, row.storagePath));
    const res = await call('GET', `/api/email-templates/${t.id}/attachments/${row.id}`, cookie);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'server_error' });
    expect(res.body).not.toContain(storage);
  });

  it('M1: old files that cannot be removed after a replace are logged; the new files stay', async () => {
    const cookie = await signIn(app, await makeUser({ role: 'SALES_REPRESENTATIVE' }));
    const t = (await call('POST', '/api/email-templates', cookie, template({ attachments: [FILES[2]] }))).json() as TemplateJson;
    // The old file's path is made something removing a file cannot remove (a folder with a file in it).
    const old = await prisma.emailTemplateAttachment.findFirstOrThrow({ where: { templateId: t.id } });
    const oldPath = path.join(storage, old.storagePath);
    await rm(oldPath);
    await mkdir(oldPath);
    await writeFile(path.join(oldPath, 'x'), 'x');
    const res = await call('PATCH', `/api/email-templates/${t.id}`, cookie, { attachments: [{ ...FILES[2], name: 'New.pdf' }], updatedAt: t.updatedAt });
    expect(res.statusCode).toBe(200);
    const row = await prisma.emailTemplateAttachment.findFirstOrThrow({ where: { templateId: t.id } });
    expect(row.fileName).toBe('New.pdf');
    expect((await readStoredFile(row.storagePath)).equals(PDF)).toBe(true);
  });

  it('M2: a campaign’s copies go when it is cancelled, and when it completes', async () => {
    const { lead, cookie, t, rep, company } = await sender();
    const contact2 = await makeContact({ companyId: company.id, firstName: 'Luis', lastName: 'Rojas', businessEmail: 'luis@andino.cl' });
    const lead2 = await makeLead({ companyId: company.id, contactId: contact2.id, assignedToId: rep.id, status: 'Contacted' });
    const create = (name: string, leadId: number) => call('POST', '/api/mailer', cookie, {
      leadIds: [leadId], name, templateId: t.id, cc: [], bcc: [], startAt: null, intervalMinutes: 3,
      workingHoursOnly: false, unsubscribeLine: true, lawfulBasis: 'Legitimate interest (B2B outreach relevant to their role)',
    });
    const a = (await create('A', lead.id)).json() as { id: number };
    expect(await filesIn(`campaigns/${a.id}`)).toHaveLength(3);
    expect((await call('POST', `/api/mailer/${a.id}/cancel`, cookie)).statusCode).toBe(200);
    expect(await filesIn(`campaigns/${a.id}`)).toEqual([]);

    const resB = await create('B', lead2.id);
    expect(resB.json()).toMatchObject({ id: expect.any(Number) });
    const b = resB.json() as { id: number };
    expect(await filesIn(`campaigns/${b.id}`)).toHaveLength(3);
    const sent: MailMessage[] = [];
    await campaignStepHandler({ id: 1, type: 'campaign_step', payload: { campaignId: b.id }, attempts: 0, maxAttempts: 1 } as unknown as Job, {
      graph: fakeGraph({ async sendMail(_a, m) { sent.push(m); } }),
    });
    expect(sent[0]!.attachments).toHaveLength(3);
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('Completed');
    expect(await filesIn(`campaigns/${b.id}`)).toEqual([]);
  });
});
