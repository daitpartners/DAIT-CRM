import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEMPLATE_ATTACHMENTS_MAX_BYTES } from '@dait-crm/shared';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type DraftFields, type GraphAttachment, type GraphClient, type GraphDraft } from '../src/graph/client';
import { removeFiles, saveFile } from '../src/mail/files';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeUser, signIn } from './factory';

/**
 * Web-mail release 3, Task 7: files on the Outlook draft — attachments and inline pictures uploaded from the CRM,
 * template files, and the files Outlook already put on a draft (a forward's attachments, a quote's or an Outlook-made
 * draft's pictures), whose cid: pictures must survive the save sanitiser.
 */

const g = vi.hoisted(() => ({
  calls: [] as unknown[][],
  next: 0,
  replyHtml: '',
  draft: null as null | ((id: string) => unknown),
  content: null as null | ((id: string) => Promise<Buffer>),
  removeError: null as Error | null,
}));

const draft = (over: Partial<GraphDraft> = {}): GraphDraft => ({
  id: 'D1', conversationId: null, subject: '', html: '', to: [], cc: [], bcc: [], lastModified: '2026-11-27T10:00:00Z', attachments: [], ...over,
});
const att = (over: Partial<GraphAttachment>): GraphAttachment => ({ id: 'A', name: 'a', contentType: 'image/png', size: 10, isInline: false, kind: 'file', ...over });

const graphImpl: Partial<GraphClient> = {
  async createReplyDraft(_account, graphId, kind) {
    g.calls.push(['createReplyDraft', graphId, kind]);
    return draft({ id: 'FW1', conversationId: 'conv-1', html: g.replyHtml });
  },
  async getDraft(_account, id) {
    g.calls.push(['getDraft', id]);
    return (g.draft ? g.draft(id) : draft({ id })) as GraphDraft;
  },
  async updateDraft(_account, id, d) {
    g.calls.push(['updateDraft', id, d]);
  },
  async addAttachment(_account, draftId, a) {
    g.calls.push(['addAttachment', draftId, a]);
    g.next += 1;
    return { id: `ATT+${g.next}=` };
  },
  async removeAttachment(_account, draftId, id) {
    g.calls.push(['removeAttachment', draftId, id]);
    if (g.removeError) throw g.removeError;
  },
  async attachmentContent(_account, graphId, id, max) {
    g.calls.push(['attachmentContent', graphId, id, max]);
    return g.content!(id);
  },
};

let app: FastifyInstance;
let storage: string;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({ graph: fakeGraph(graphImpl) });
});
afterAll(() => app.close());
beforeEach(async () => {
  g.calls = [];
  g.next = 0;
  g.replyHtml = '';
  g.draft = null;
  g.content = null;
  g.removeError = null;
  await resetDb();
  await seedLookups();
  storage = await mkdtemp(path.join(tmpdir(), 'crm-draft-files-'));
  vi.stubEnv('STORAGE_DIR', storage);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(storage, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture-bytes')]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('logo')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const b64 = (b: Buffer) => b.toString('base64');
const PDF_BASE64 = b64(PDF);
const PNG_CID = `img-${createHash('sha256').update(PNG).digest('hex').slice(0, 16)}@dait`;
const pngUrl = (b: Buffer) => `data:image/png;base64,${b64(b)}`;

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const box = (userId: number, address: string) =>
    prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' } });
  const repBox = await box(rep.id, 'maya@daitpartners.com');
  await box(carlos.id, 'carlos@daitpartners.com');
  await box(admin.id, 'deepak@daitpartners.com');
  const d = await prisma.emailMessage.create({
    data: {
      userId: rep.id, accountId: repBox.id, folder: 'drafts', status: 'draft', source: 'crm', graphId: 'D1', fromAddress: 'maya@daitpartners.com',
      toAddresses: [], subject: 'Offer', bodyText: '', bodyHtml: '', occurredAt: new Date('2026-11-27T10:00:00Z'),
    },
  });
  return { rep, carlos, admin, repBox, d, repCookie: await signIn(app, rep) };
}

const row = (id: number) => prisma.emailMessage.findUniqueOrThrow({ where: { id } });
const ofKind = (kind: string) => g.calls.filter((c) => c[0] === kind);
const updates = () => ofKind('updateDraft') as [string, string, DraftFields][];

/** A template with two inline pictures and two attachments, stored as an .oft upload keeps them. */
async function makeTemplate() {
  const t = await prisma.emailTemplate.create({ data: { name: 'Holiday', language: 'en', subject: 'Hi', bodyHtml: '<img src="cid:logo@tpl">', sourceType: 'oft' } });
  const file = async (fileName: string, data: Buffer, contentType: string, contentId: string | null) =>
    prisma.emailTemplateAttachment.create({
      data: {
        templateId: t.id, fileName, contentType, size: data.length, contentId, isInline: contentId !== null,
        storagePath: await saveFile('templates', t.id, data), sha256: createHash('sha256').update(data).digest('hex'),
      },
    });
  return {
    t,
    logo: await file('logo.png', PNG2, 'image/png', 'logo@tpl'),
    brochure: await file('Brochure.pdf', PDF, 'application/pdf', null),
    terms: await file('Terms.pdf', PDF, 'application/pdf', null),
  };
}

describe('draft files (web-mail release 3)', () => {
  it('attaches a PDF to the Outlook draft and lists it; removes it', async () => {
    const { d, repCookie } = await setup();
    const res = await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'Proposal.pdf', data: PDF_BASE64 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'ATT+1=', name: 'Proposal.pdf', contentType: 'application/pdf', size: PDF.length, inline: false, contentId: null, dataUrl: null });
    expect(g.calls).toEqual([['addAttachment', 'D1', { name: 'Proposal.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64 }]]);
    expect(await row(d.id)).toMatchObject({
      draftFiles: [{ id: 'ATT+1=', name: 'Proposal.pdf', contentType: 'application/pdf', size: PDF.length, inline: false, contentId: null }],
      attachmentNames: ['Proposal.pdf'],
    });
    expect((await call('GET', `/api/mail/drafts/${d.id}`, repCookie)).json().files).toEqual([res.json()]);

    // The id is a Graph attachment id (base64: `+`, `/`, `=`), encoded as one path segment.
    const del = await call('DELETE', `/api/mail/drafts/${d.id}/files/${encodeURIComponent('ATT+1=')}`, repCookie);
    expect(del.statusCode).toBe(204);
    expect(g.calls.at(-1)).toEqual(['removeAttachment', 'D1', 'ATT+1=']);
    expect(await row(d.id)).toMatchObject({ draftFiles: [], attachmentNames: [] });
    // Not a file of the draft (any more), or not an attachment id at all: 404.
    expect((await call('DELETE', `/api/mail/drafts/${d.id}/files/${encodeURIComponent('ATT+1=')}`, repCookie)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/mail/drafts/${d.id}/files/${encodeURIComponent('a b')}`, repCookie)).statusCode).toBe(404);
  });

  it('removing a file already gone in Outlook is fine (404 tolerated); another refusal keeps it listed', async () => {
    const { d, repCookie } = await setup();
    await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'a.pdf', data: PDF_BASE64 });
    await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'b.pdf', data: PDF_BASE64 });
    g.removeError = new GraphError('graph_request_failed status=503', 503);
    expect((await call('DELETE', `/api/mail/drafts/${d.id}/files/ATT%2B1%3D`, repCookie)).json()).toEqual({ error: 'outlook_busy' });
    expect(await row(d.id)).toMatchObject({ attachmentNames: ['a.pdf', 'b.pdf'] });
    g.removeError = new GraphError('graph_request_failed status=404', 404);
    expect((await call('DELETE', `/api/mail/drafts/${d.id}/files/ATT%2B1%3D`, repCookie)).statusCode).toBe(204);
    expect(await row(d.id)).toMatchObject({ attachmentNames: ['b.pdf'] });
  });

  it('an inline picture gets a content-id; its cid: survives the save sanitiser; a removed picture is detached on save', async () => {
    const { d, repCookie } = await setup();
    const res = await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'chart.png', data: b64(PNG), inline: true });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'ATT+1=', name: 'chart.png', contentType: 'image/png', size: PNG.length, inline: true, contentId: PNG_CID, dataUrl: pngUrl(PNG) });
    expect(g.calls).toEqual([['addAttachment', 'D1', { name: 'chart.png', contentType: 'image/png', contentBase64: b64(PNG), isInline: true, contentId: PNG_CID }]]);
    // An inline picture is not an attachment in the list of names.
    expect(await row(d.id)).toMatchObject({ attachmentNames: [] });
    // The same picture again is the file already there.
    expect((await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'again.png', data: b64(PNG), inline: true })).json()).toMatchObject({ id: 'ATT+1=' });
    expect(ofKind('addAttachment')).toHaveLength(1);

    const shown = `<p>See</p><img src="cid:${PNG_CID}"><img src="cid:not-mine@x">`;
    expect((await call('PATCH', `/api/mail/drafts/${d.id}`, repCookie, { subject: 'Offer', bodyHtml: shown })).statusCode).toBe(200);
    const html = updates().at(-1)![2].html;
    expect(html).toContain(`src="cid:${PNG_CID}"`);
    expect(html).not.toContain('not-mine');
    expect(ofKind('removeAttachment')).toEqual([]);

    expect((await call('PATCH', `/api/mail/drafts/${d.id}`, repCookie, { subject: 'Offer', bodyHtml: '<p>See</p>' })).statusCode).toBe(200);
    expect(ofKind('removeAttachment')).toEqual([['removeAttachment', 'D1', 'ATT+1=']]);
    expect(await row(d.id)).toMatchObject({ draftFiles: [] });
  });

  it('a picture uploaded but not yet in a saved body is not detached by a save on its way', async () => {
    const { d, repCookie } = await setup();
    await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'chart.png', data: b64(PNG), inline: true });
    await call('PATCH', `/api/mail/drafts/${d.id}`, repCookie, { bodyHtml: '<p>typing</p>' });
    expect(ofKind('removeAttachment')).toEqual([]);
    expect((await row(d.id)).draftFiles).toHaveLength(1);
  });

  it('refuses a .pdf whose bytes are HTML (422 attachment_type), an inline PDF, empty bytes, over 2.5 MB (413), the 21st file (422)', async () => {
    const { d, repCookie } = await setup();
    const post = (body: Record<string, unknown>) => call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, body);
    const html = await post({ name: 'Proposal.pdf', data: b64(Buffer.from('<html><script>alert(1)</script></html>')) });
    expect([html.statusCode, html.json()]).toEqual([422, { error: 'attachment_type' }]);
    const inlinePdf = await post({ name: 'x.pdf', data: PDF_BASE64, inline: true });
    expect([inlinePdf.statusCode, inlinePdf.json()]).toEqual([422, { error: 'attachment_type' }]);
    const empty = await post({ name: 'x.pdf', data: 'A' });
    expect([empty.statusCode, empty.json()]).toEqual([422, { error: 'attachment_invalid' }]);
    const big = Buffer.concat([PDF, Buffer.alloc(TEMPLATE_ATTACHMENTS_MAX_BYTES + 1 - PDF.length)]);
    const tooBig = await post({ name: 'big.pdf', data: b64(big) });
    expect([tooBig.statusCode, tooBig.json()]).toEqual([413, { error: 'attachments_too_large' }]);
    expect(g.calls).toEqual([]);

    const twenty = Array.from({ length: 20 }, (_, i) => ({ id: `F${i}`, name: `f${i}.pdf`, contentType: 'application/pdf', size: 1, inline: false, contentId: null }));
    await prisma.emailMessage.update({ where: { id: d.id }, data: { draftFiles: twenty } });
    const extra = await post({ name: 'one-more.pdf', data: PDF_BASE64 });
    expect([extra.statusCode, extra.json()]).toEqual([422, { error: 'attachment_invalid' }]);
    expect(g.calls).toEqual([]);
  });

  it('applying a template copies its inline pictures and kept attachments onto the draft; files replaced since → 409 template_files_missing', async () => {
    const { d, repCookie } = await setup();
    const { t, logo, brochure, terms } = await makeTemplate();
    await call('POST', `/api/mail/drafts/${d.id}/files`, repCookie, { name: 'mine.pdf', data: PDF_BASE64 });

    const res = await call('POST', `/api/mail/drafts/${d.id}/template`, repCookie, { templateId: t.id, attachmentIds: [brochure.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      files: [
        { id: 'ATT+2=', name: 'logo.png', contentType: 'image/png', size: PNG2.length, inline: true, contentId: 'logo@tpl', dataUrl: pngUrl(PNG2) },
        { id: 'ATT+3=', name: 'Brochure.pdf', contentType: 'application/pdf', size: PDF.length, inline: false, contentId: null, dataUrl: null },
      ],
    });
    expect(ofKind('addAttachment').slice(1)).toEqual([
      ['addAttachment', 'D1', { name: 'logo.png', contentType: 'image/png', contentBase64: b64(PNG2), isInline: true, contentId: 'logo@tpl' }],
      ['addAttachment', 'D1', { name: 'Brochure.pdf', contentType: 'application/pdf', contentBase64: PDF_BASE64 }],
    ]);
    expect(await row(d.id)).toMatchObject({ attachmentNames: ['mine.pdf', 'Brochure.pdf'] });
    // The template's picture survives the save sanitiser.
    await call('PATCH', `/api/mail/drafts/${d.id}`, repCookie, { bodyHtml: '<img src="cid:logo@tpl">' });
    expect(updates().at(-1)![2].html).toContain('src="cid:logo@tpl"');

    // Applying it again (other attachments kept) replaces the files applied before; the user's own file stays.
    g.calls = [];
    const again = await call('POST', `/api/mail/drafts/${d.id}/template`, repCookie, { templateId: t.id, attachmentIds: [terms.id] });
    expect(again.json().files.map((f: { name: string }) => f.name)).toEqual(['logo.png', 'Terms.pdf']);
    expect(ofKind('removeAttachment')).toEqual([['removeAttachment', 'D1', 'ATT+2='], ['removeAttachment', 'D1', 'ATT+3=']]);
    expect(await row(d.id)).toMatchObject({ attachmentNames: ['mine.pdf', 'Terms.pdf'] });

    // An attachment no longer of the template, or a file gone from disk: 409, and the draft is not touched.
    g.calls = [];
    const stale = await call('POST', `/api/mail/drafts/${d.id}/template`, repCookie, { templateId: t.id, attachmentIds: [999_999] });
    expect([stale.statusCode, stale.json()]).toEqual([409, { error: 'template_files_missing' }]);
    await removeFiles([logo.storagePath]);
    const gone = await call('POST', `/api/mail/drafts/${d.id}/template`, repCookie, { templateId: t.id, attachmentIds: [] });
    expect([gone.statusCode, gone.json()]).toEqual([409, { error: 'template_files_missing' }]);
    expect(g.calls).toEqual([]);
    expect((await call('POST', `/api/mail/drafts/${d.id}/template`, repCookie, { templateId: 999_999 })).statusCode).toBe(404);
  });

  it("another user's draft files are 403 view_only; a Sales rep gets 404", async () => {
    const { d, admin, carlos } = await setup();
    const { t } = await makeTemplate();
    for (const [cookie, status] of [[await signIn(app, admin), 403], [await signIn(app, carlos), 404]] as const) {
      const responses = [
        await call('POST', `/api/mail/drafts/${d.id}/files`, cookie, { name: 'a.pdf', data: PDF_BASE64 }),
        await call('DELETE', `/api/mail/drafts/${d.id}/files/F1`, cookie),
        await call('POST', `/api/mail/drafts/${d.id}/template`, cookie, { templateId: t.id }),
      ];
      expect(responses.map((r) => r.statusCode)).toEqual([status, status, status]);
      if (status === 403) expect(responses.map((r) => r.json())).toEqual(Array(3).fill({ error: 'view_only' }));
    }
    expect(g.calls).toEqual([]);
  });

  it('opening a draft returns inline pictures as data URLs for the editor (unreadable or not a picture: null)', async () => {
    const { d, repCookie } = await setup();
    const files = [
      { id: 'P1', name: 'chart.png', contentType: 'image/png', size: PNG.length, inline: true, contentId: PNG_CID },
      { id: 'P2', name: 'broken.png', contentType: 'image/png', size: 5, inline: true, contentId: 'b@x' },
      { id: 'P3', name: 'fake.png', contentType: 'image/png', size: 5, inline: true, contentId: 'c@x' },
      { id: 'F1', name: 'a.pdf', contentType: 'application/pdf', size: PDF.length, inline: false, contentId: null },
    ];
    await prisma.emailMessage.update({ where: { id: d.id }, data: { draftFiles: files, bodyHtml: `<img src="cid:${PNG_CID}">` } });
    g.content = async (id) => {
      if (id === 'P1') return PNG;
      if (id === 'P3') return Buffer.from('<svg onload=alert(1)>');
      throw new GraphError('graph_request_failed status=503', 503);
    };
    const res = await call('GET', `/api/mail/drafts/${d.id}`, repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toEqual([
      { ...files[0], dataUrl: pngUrl(PNG) },
      { ...files[1], dataUrl: null },
      { ...files[2], dataUrl: null },
      { ...files[3], dataUrl: null },
    ]);
    expect(ofKind('attachmentContent')).toEqual([
      ['attachmentContent', 'D1', 'P1', TEMPLATE_ATTACHMENTS_MAX_BYTES],
      ['attachmentContent', 'D1', 'P2', TEMPLATE_ATTACHMENTS_MAX_BYTES],
      ['attachmentContent', 'D1', 'P3', TEMPLATE_ATTACHMENTS_MAX_BYTES],
    ]);
  });

  it('a forward of a message with an inline picture keeps the cid: picture in the saved body and lists its attachments', async () => {
    const { rep, repBox, repCookie } = await setup();
    const original = await prisma.emailMessage.create({
      data: {
        userId: rep.id, accountId: repBox.id, folder: 'inbox', status: 'received', source: 'sync', graphId: 'g-orig', fromAddress: 'ana@acme.com',
        toAddresses: ['maya@daitpartners.com'], subject: 'Chart', bodyText: 'x', bodyHtml: '<p>x</p>', occurredAt: new Date('2026-11-20T10:00:00Z'),
      },
    });
    g.replyHtml = '<hr><div id="divRplyFwdMsg"><b>From:</b> Ana</div><p>Our chart</p><img src="cid:image001.png@01DB">';
    g.draft = (id) => draft({
      id,
      attachments: [
        att({ id: 'O1', name: 'image001.png', isInline: true, contentId: 'image001.png@01DB', size: PNG.length }),
        att({ id: 'O2', name: 'Report.pdf', contentType: 'application/pdf', size: 99 }),
      ],
    });
    g.content = async () => PNG;
    const res = await call('POST', '/api/mail/drafts', repCookie, { kind: 'forward', replyToId: original.id });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quotedHtml).toContain('src="cid:image001.png@01DB"');
    expect(updates()[0]![2].html).toContain('src="cid:image001.png@01DB"');
    expect(body.files).toEqual([
      { id: 'O1', name: 'image001.png', contentType: 'image/png', size: PNG.length, inline: true, contentId: 'image001.png@01DB', dataUrl: pngUrl(PNG) },
      { id: 'O2', name: 'Report.pdf', contentType: 'application/pdf', size: 99, inline: false, contentId: null, dataUrl: null },
    ]);
    expect(await row(body.id)).toMatchObject({ attachmentNames: ['Report.pdf'] });

    await call('PATCH', `/api/mail/drafts/${body.id}`, repCookie, { to: ['bo@acme.com'], subject: 'Fw: Chart', bodyHtml: '<p>FYI</p>' });
    expect(updates().at(-1)![2].html).toContain('src="cid:image001.png@01DB"');
    expect(ofKind('removeAttachment')).toEqual([]);
    expect((await row(body.id)).draftFiles).toHaveLength(2);
  });

  it('a draft made in Outlook with an inline picture keeps it after a save', async () => {
    const { rep, repBox, repCookie } = await setup();
    const od = await prisma.emailMessage.create({
      data: {
        userId: rep.id, accountId: repBox.id, folder: 'drafts', status: 'draft', source: 'sync', graphId: 'OD1', fromAddress: 'maya@daitpartners.com',
        toAddresses: [], subject: 'Old', bodyText: '', bodyHtml: '', occurredAt: new Date('2026-11-27T09:00:00Z'),
      },
    });
    g.draft = (id) => draft({
      id, subject: 'Pasted', html: '<p>Look</p><img src="cid:image002.png@01DB">',
      attachments: [att({ id: 'OP1', name: 'image002.png', isInline: true, contentId: 'image002.png@01DB', size: PNG.length })],
    });
    g.content = async () => PNG;
    const opened = (await call('GET', `/api/mail/drafts/${od.id}`, repCookie)).json();
    expect(opened.bodyHtml).toContain('src="cid:image002.png@01DB"');
    expect(opened.files).toEqual([
      { id: 'OP1', name: 'image002.png', contentType: 'image/png', size: PNG.length, inline: true, contentId: 'image002.png@01DB', dataUrl: pngUrl(PNG) },
    ]);
    await call('PATCH', `/api/mail/drafts/${od.id}`, repCookie, { subject: 'Pasted', bodyHtml: opened.bodyHtml });
    expect(updates().at(-1)![2].html).toContain('src="cid:image002.png@01DB"');
    expect(ofKind('removeAttachment')).toEqual([]);
    expect(await row(od.id)).toMatchObject({ draftFiles: [expect.objectContaining({ id: 'OP1', contentId: 'image002.png@01DB' })], attachmentNames: [] });
  });

  it('a file on a draft deleted in Outlook is 409 draft_gone', async () => {
    const { d, rep } = await setup();
    const gone: Partial<GraphClient> = {
      async addAttachment() {
        throw new GraphError('graph_request_failed status=404', 404);
      },
    };
    const other = await buildApp({ graph: fakeGraph({ ...graphImpl, ...gone }) });
    try {
      const res = await other.inject({
        method: 'POST', url: `/api/mail/drafts/${d.id}/files`, headers: { cookie: await signIn(other, rep) },
        payload: { name: 'a.pdf', data: PDF_BASE64 },
      });
      expect([res.statusCode, res.json()]).toEqual([409, { error: 'draft_gone' }]);
    } finally {
      await other.close();
    }
    expect(await row(d.id)).toMatchObject({ draftFiles: [] });
  });
});
