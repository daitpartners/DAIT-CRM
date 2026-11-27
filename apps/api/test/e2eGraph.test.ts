import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app';
import { encrypt } from '../src/crypto/tokens';
import { createGraphClient, GraphError } from '../src/graph/client';
import { createE2eGraph, isE2eGraph } from '../src/graph/e2eFake';
import { prisma } from '../src/db';
import { resetDb } from './helpers';

afterEach(() => vi.unstubAllEnvs());

describe('e2e fake Graph (web-mail release 2)', () => {
  test('the e2e fake is used only with E2E_FAKE_GRAPH=1 and NODE_ENV test', async () => {
    const graphOf = async () => {
      const app = await buildApp();
      try {
        return isE2eGraph(app.graph);
      } finally {
        await app.close();
      }
    };
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('E2E_FAKE_GRAPH', '1');
    expect(await graphOf()).toBe(true);

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PUBLIC_URL', 'https://crm.example.com');
    expect(await graphOf()).toBe(false);

    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PUBLIC_URL', 'http://localhost:5173');
    expect(await graphOf()).toBe(false);

    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('E2E_FAKE_GRAPH', '');
    expect(await graphOf()).toBe(false);

    vi.stubEnv('E2E_FAKE_GRAPH', 'true');
    expect(await graphOf()).toBe(false);
  });

  test('a graph passed to buildApp wins over the flag', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('E2E_FAKE_GRAPH', '1');
    const real = createGraphClient({});
    const app = await buildApp({ graph: real });
    try {
      expect(app.graph).toBe(real);
      expect(isE2eGraph(app.graph)).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('the fake accepts mailbox changes and serves the e2e and parity attachments; everything else is refused', async () => {
    await resetDb();
    const account = await prisma.emailAccount.create({
      data: { address: 'maya@daitpartners.com', provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'), status: 'connected' },
    });
    const g = createE2eGraph();
    expect(isE2eGraph(g)).toBe(true);

    await expect(g.markRead(account, 'e2e-1', true)).resolves.toBeUndefined();
    await expect(g.moveTo(account, 'e2e-1', 'deleteditems')).resolves.toBeUndefined();
    await expect(g.setFlag(account, 'e2e-1', { status: 'complete' })).resolves.toBeUndefined();
    await expect(g.deleteMessage(account, 'e2e-1')).resolves.toBeUndefined();
    await expect(g.reply(account, 'e2e-1', { to: ['a@acme.com'], html: '<p>x</p>' })).resolves.toBeUndefined();
    await expect(g.replyAll(account, 'e2e-1', { to: ['a@acme.com'], html: '<p>x</p>' })).resolves.toBeUndefined();
    await expect(g.forward(account, 'e2e-1', { to: ['a@acme.com'], html: '<p>x</p>' })).resolves.toBeUndefined();

    const pdf = await g.attachmentContent(account, 'e2e-2', 'e2e-att-1', 25_000_000);
    expect(await g.listAttachments(account, 'e2e-2')).toEqual([
      { id: 'e2e-att-1', name: 'orbit-notes.pdf', contentType: 'application/pdf', size: pdf.length, isInline: false, kind: 'file' },
    ]);
    expect(await g.listAttachments(account, 'e2e-1')).toEqual([]);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);

    // Parity data (F14): an HTML message with a PDF and a spreadsheet.
    const parity = await g.listAttachments(account, 'parity-att-1');
    expect(parity.map((a) => [a.name, a.contentType, a.kind])).toEqual([
      ['proposal.pdf', 'application/pdf', 'file'],
      ['pricing.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'file'],
    ]);
    const [p, x] = parity;
    const pBytes = await g.attachmentContent(account, 'parity-att-1', p!.id, 25_000_000);
    const xBytes = await g.attachmentContent(account, 'parity-att-1', x!.id, 25_000_000);
    expect(pBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(xBytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(p!.size).toBe(pBytes.length);
    expect(x!.size).toBe(xBytes.length);

    const tooLarge = await g.attachmentContent(account, 'e2e-2', 'e2e-att-1', 10).catch((e: unknown) => e);
    expect(tooLarge).toBeInstanceOf(GraphError);
    expect((tooLarge as GraphError).status).toBe(413);
    const missing = await g.attachmentContent(account, 'e2e-1', 'nope', 25_000_000).catch((e: unknown) => e);
    expect((missing as GraphError).status).toBe(404);

    for (const refused of [
      () => g.sendMail(account, { to: ['a@acme.com'], subject: 's', html: '', text: '' }),
      () => g.deltaPage(account, 'https://graph.microsoft.com/v1.0/x'),
      () => g.messageBody(account, 'e2e-1'),
      () => g.searchPage(account, 'https://graph.microsoft.com/v1.0/x'),
      () => g.folderIds(account),
      () => g.calendarDeltaPage(account, 'https://graph.microsoft.com/v1.0/x'),
    ]) {
      await expect(refused()).rejects.toThrow('not used in e2e');
    }
  });
  test('the e2e fake keeps drafts: create, update, attach, get, delete', async () => {
    await resetDb();
    const account = await prisma.emailAccount.create({
      data: { address: 'neha@daitpartners.com', provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'), status: 'connected' },
    });
    const g = createE2eGraph();

    const created = await g.createDraft(account, { subject: 'Hello', html: '<p>Hi</p>', to: ['Ana@Acme.com'], cc: [], bcc: ['b@acme.com'] });
    expect(created).toMatchObject({ subject: 'Hello', html: '<p>Hi</p>', to: ['ana@acme.com'], cc: [], bcc: ['b@acme.com'], conversationId: null, attachments: [] });
    expect(created.id).toMatch(/^e2e-draft-\d+$/);

    await g.updateDraft(account, created.id, { subject: 'Hello again', html: '<p>Hi there</p>', to: ['ana@acme.com'], cc: ['c@acme.com'], bcc: [] });
    const att = await g.addAttachment(account, created.id, { name: 'notes.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4').toString('base64') });
    const pic = await g.addAttachment(account, created.id, { name: 'logo.png', contentType: 'image/png', contentBase64: 'iVBO', isInline: true, contentId: 'img-1@dait' });
    expect(att.id).toMatch(/^e2e-att-\d+$/);
    expect(pic.id).not.toBe(att.id);

    const read = await g.getDraft(account, created.id);
    expect(read).toMatchObject({ id: created.id, subject: 'Hello again', html: '<p>Hi there</p>', cc: ['c@acme.com'], bcc: [] });
    expect(read.attachments).toEqual([
      { id: att.id, name: 'notes.pdf', contentType: 'application/pdf', size: 8, isInline: false, kind: 'file' },
      { id: pic.id, name: 'logo.png', contentType: 'image/png', size: 3, isInline: true, kind: 'file' },
    ]);
    // A copy: changing what was returned does not change the stored draft.
    read.attachments.pop();
    expect((await g.getDraft(account, created.id)).attachments).toHaveLength(2);

    await g.removeAttachment(account, created.id, pic.id);
    expect((await g.getDraft(account, created.id)).attachments.map((a) => a.id)).toEqual([att.id]);

    // A reply to the seeded Orbit message: its conversation, the sender as recipient and Outlook's quote.
    const reply = await g.createReplyDraft(account, 'e2e-2', 'reply');
    expect(reply).toMatchObject({ conversationId: 'e2e-conv-1', subject: 'RE: Re: Orbit proposal', to: ['finance@orbit.example'], cc: [], bcc: [] });
    expect(reply.html).toContain('<div id="divRplyFwdMsg"><b>From:</b> Lena Vogel &lt;finance@orbit.example&gt;');
    expect(reply.html).toContain('Thanks Neha, can we talk on Thursday?');
    const forward = await g.createReplyDraft(account, 'e2e-2', 'forward');
    expect(forward).toMatchObject({ conversationId: 'e2e-conv-1', subject: 'FW: Re: Orbit proposal', to: [] });
    expect(forward.id).not.toBe(reply.id);
    const missingOriginal = await g.createReplyDraft(account, 'nope', 'reply').catch((e: unknown) => e);
    expect((missingOriginal as GraphError).status).toBe(404);

    await g.deleteMessage(account, created.id);
    const gone = await g.getDraft(account, created.id).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(GraphError);
    expect((gone as GraphError).status).toBe(404);
    expect(((await g.updateDraft(account, created.id, { subject: 'x', html: '', to: [], cc: [], bcc: [] }).catch((e: unknown) => e)) as GraphError).status).toBe(404);
    expect(((await g.addAttachment(account, created.id, { name: 'a.pdf', contentType: 'application/pdf', contentBase64: '' }).catch((e: unknown) => e)) as GraphError).status).toBe(404);

    // The e2e server runs no worker: sending a draft is never done there.
    await expect(g.sendDraft(account, reply.id)).rejects.toThrow('not used in e2e');
  });
});
