import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type GraphAttachment } from '../src/graph/client';
import { ATTACHMENT_PROXY_MAX_BYTES } from '../src/mail/attachments';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeLead, makeUser, signIn } from './factory';

/** Web-mail release 2, Task 9: received attachments listed, previewed and downloaded from Outlook on demand. */

const PDF = Buffer.from('%PDF-1.4\n%');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const g = vi.hoisted(() => ({
  attachments: [] as GraphAttachment[],
  /** What attachmentContent returns, by attachment id. */
  content: {} as Record<string, Buffer>,
  /** Thrown by the next Graph call (then cleared). */
  fail: null as unknown,
  listCalls: [] as { accountId: number; graphId: string }[],
  contentCalls: [] as { accountId: number; graphId: string; attachmentId: string; maxBytes: number }[],
}));

const takeFail = () => {
  const err = g.fail;
  g.fail = null;
  if (err) throw err;
};

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({
    graph: fakeGraph({
      listAttachments: async (account, graphId) => {
        g.listCalls.push({ accountId: account.id, graphId });
        takeFail();
        return g.attachments;
      },
      attachmentContent: async (account, graphId, attachmentId, maxBytes) => {
        g.contentCalls.push({ accountId: account.id, graphId, attachmentId, maxBytes });
        takeFail();
        const data = g.content[attachmentId];
        if (!data) throw new GraphError('not found', 404);
        return data;
      },
    }),
  });
});
afterAll(() => app.close());
beforeEach(async () => {
  Object.assign(g, {
    attachments: [
      { id: 'A1', name: 'RFP.pdf', contentType: 'application/pdf', size: 9, isInline: false, kind: 'file' },
      { id: 'A2', name: 'Pricing.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4, isInline: false, kind: 'file' },
      { id: 'IMG', name: 'logo.png', contentType: 'image/png', size: 3, isInline: true, kind: 'file' },
    ],
    content: { A1: PDF },
    fail: null,
    listCalls: [],
    contentCalls: [],
  });
  await resetDb();
  await seedLookups();
});

const get = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });

const personal = (userId: number, address: string, status = 'connected') =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status } });

let n = 0;
async function msg(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Secret proposal', bodyText: 'Looks good', graphId: `g-${n}`,
      threadId: `conv-${n}`, isRead: true, occurredAt: new Date('2026-11-20T10:00:00Z'), attachmentNames: ['RFP.pdf', 'Pricing.xlsx'],
      ...(data as object),
    },
  });
}

/** Rep Maya with a connected mailbox and a message on her lead; admin Deepak with his own mailbox and message. */
async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const lead = await makeLead({ companyId: acme.id, assignedToId: rep.id, status: 'New' });
  const repBox = await personal(rep.id, 'maya@daitpartners.com');
  const adminBox = await personal(admin.id, 'deepak@daitpartners.com');
  const m = await msg(rep.id, repBox.id, { leadId: lead.id, companyId: acme.id });
  const adminMsg = await msg(admin.id, adminBox.id, { leadId: lead.id, companyId: acme.id });
  return { rep, admin, repBox, adminBox, m, adminMsg, repCookie: await signIn(app, rep), adminCookie: await signIn(app, admin) };
}

const file = (id: number, att: string, inline = false) => `/api/mail/${id}/attachment?att=${encodeURIComponent(att)}${inline ? '&inline=1' : ''}`;
const viewAudits = () => prisma.auditLog.findMany({ where: { entityType: 'email_message', action: 'view' } });

describe('mail attachments (web-mail release 2)', () => {
  it('lists the non-inline file attachments with preview flags', async () => {
    const { m, repBox, repCookie } = await setup();
    const res = await get(`/api/mail/${m.id}/attachments`, repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: true,
      items: [
        { id: 'A1', name: 'RFP.pdf', contentType: 'application/pdf', size: 9, preview: true, kind: 'file' },
        { id: 'A2', name: 'Pricing.xlsx', contentType: expect.any(String), size: 4, preview: false, kind: 'file' },
      ],
    });
    expect(g.listCalls).toEqual([{ accountId: repBox.id, graphId: m.graphId }]);
  });

  it('lists an attached message (download only) and a cloud link (no download, kind reference); never previews them', async () => {
    const { m, repCookie } = await setup();
    g.attachments = [
      { id: 'IT', name: 'Re: kickoff.pdf', contentType: 'message/rfc822', size: 50, isInline: false, kind: 'item' },
      { id: 'RF', name: 'Deck.png', contentType: 'application/octet-stream', size: 0, isInline: false, kind: 'reference' },
    ];
    const res = await get(`/api/mail/${m.id}/attachments`, repCookie);
    expect(res.json().items).toEqual([
      { id: 'IT', name: 'Re: kickoff.pdf', contentType: 'message/rfc822', size: 50, preview: false, kind: 'item' },
      { id: 'RF', name: 'Deck.png', contentType: 'application/octet-stream', size: 0, preview: false, kind: 'reference' },
    ]);
  });

  it('Preview of a real PDF is inline application/pdf with nosniff and no-store', async () => {
    const { m, repBox, repCookie } = await setup();
    const res = await get(file(m.id, 'A1', true), repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`inline; filename="RFP.pdf"; filename*=UTF-8''RFP.pdf`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect(g.contentCalls).toEqual([{ accountId: repBox.id, graphId: m.graphId, attachmentId: 'A1', maxBytes: ATTACHMENT_PROXY_MAX_BYTES }]);
    // Your own download is not audited (only team view is).
    expect(await viewAudits()).toEqual([]);
  });

  it('Preview of a real image is inline with an image-only sandbox CSP', async () => {
    const { m, repCookie } = await setup();
    g.attachments = [{ id: 'P1', name: 'photo.png', contentType: 'image/png', size: 12, isInline: false, kind: 'file' }];
    g.content = { P1: PNG };
    const res = await get(`/api/mail/${m.id}/attachment?att=P1&inline=1`, repCookie);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; img-src 'self'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('a file named .pdf whose bytes are HTML is never inline: octet-stream attachment with a sandbox CSP (Review Focus 2)', async () => {
    const { m, repCookie } = await setup();
    g.attachments = [{ id: 'A1', name: 'invoice.pdf', contentType: 'application/pdf', size: 40, isInline: false, kind: 'file' }];
    g.content = { A1: Buffer.from('<html><script>alert(1)</script></html>') };
    const res = await get(file(m.id, 'A1', true), repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('without inline=1 even a real PDF downloads; the name is RFC 5987-encoded with an ASCII fallback', async () => {
    const { m, repCookie } = await setup();
    g.content = { A9: PDF };
    // The download name is the listed one, cleaned (the bytes route asks Graph for the list too).
    g.attachments = [{ id: 'A9', name: 'Propuesta "año".pdf', contentType: 'application/pdf', size: 9, isInline: false, kind: 'file' }];
    const res = await get(file(m.id, 'A9'), repCookie);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Propuesta _a_o_.pdf"; filename*=UTF-8''Propuesta%20%22a%C3%B1o%22.pdf`);
  });

  it('a real Graph id (base64 with + / =) reaches Graph unchanged when the screen encodes it (F13)', async () => {
    const { m, repCookie } = await setup();
    const id = 'AAMk+a/b==';
    g.attachments = [{ id, name: 'RFP.pdf', contentType: 'application/pdf', size: 9, isInline: false, kind: 'file' }];
    g.content = { [id]: PDF };
    const res = await get(file(m.id, id, true), repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(g.contentCalls.map((c) => c.attachmentId)).toEqual([id]);
  });

  it('a CRM-only message lists nothing (available false); a malformed att id is 404', async () => {
    const { rep, repBox, m, repCookie } = await setup();
    const crmOnly = await msg(rep.id, null, { graphId: null, status: 'sent', source: 'crm', folder: 'sent' });
    expect((await get(`/api/mail/${crmOnly.id}/attachments`, repCookie)).json()).toEqual({ available: false, items: [] });
    // A mailbox no longer connected: nothing listed either, and Graph is never asked.
    await prisma.emailAccount.update({ where: { id: repBox.id }, data: { status: 'error' } });
    expect((await get(`/api/mail/${m.id}/attachments`, repCookie)).json()).toEqual({ available: false, items: [] });
    await prisma.emailAccount.update({ where: { id: repBox.id }, data: { status: 'connected' } });
    expect(g.listCalls).toEqual([]);
    for (const bad of ['', 'a+b', 'a%2Eb', 'x'.repeat(1025), 'a;b']) {
      const res = await get(`/api/mail/${m.id}/attachment?att=${bad}`, repCookie);
      expect(res.statusCode, bad).toBe(404);
    }
    expect((await get(`/api/mail/${m.id}/attachment`, repCookie)).statusCode).toBe(404);
    // A CRM-only message has no attachment to fetch.
    expect((await get(`/api/mail/${crmOnly.id}/attachment?att=A1`, repCookie)).statusCode).toBe(404);
    expect(g.contentCalls).toEqual([]);
  });

  it('a cloud-link attachment, or an id the message does not have, is 404 and its bytes are never asked for', async () => {
    const { m, repCookie } = await setup();
    g.attachments = [{ id: 'RF', name: 'Deck.pptx', contentType: 'application/octet-stream', size: 0, isInline: false, kind: 'reference' }];
    expect((await get(file(m.id, 'RF'), repCookie)).statusCode).toBe(404);
    expect((await get(file(m.id, 'NOPE'), repCookie)).statusCode).toBe(404);
    expect(g.contentCalls).toEqual([]);
  });

  it('over 25 MB is 413 attachment_too_large', async () => {
    const { m, repCookie } = await setup();
    g.contentCalls = [];
    const original = g.content;
    g.content = new Proxy(original, {
      get: (t, k) => {
        if (k === 'A1') throw new GraphError('attachment_too_large', 413);
        return Reflect.get(t, k);
      },
    });
    const res = await get(file(m.id, 'A1'), repCookie);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'attachment_too_large' });
    expect(ATTACHMENT_PROXY_MAX_BYTES).toBe(25_000_000);
  });

  it('other Graph failures: 502 outlook_refused, 503 outlook_busy, 409 mailbox_not_connected (mailbox put in error)', async () => {
    const { m, repBox, repCookie } = await setup();
    g.fail = new GraphError('bad request', 400);
    expect((await get(`/api/mail/${m.id}/attachments`, repCookie)).json()).toEqual({ error: 'outlook_refused' });
    g.fail = new GraphError('throttled', 429);
    const busy = await get(`/api/mail/${m.id}/attachments`, repCookie);
    expect([busy.statusCode, busy.json()]).toEqual([503, { error: 'outlook_busy' }]);
    // The bytes call fails after the list succeeded.
    g.content = new Proxy({}, { get: () => { throw new GraphError('boom', 500); } }) as Record<string, Buffer>;
    const down = await get(file(m.id, 'A1'), repCookie);
    expect([down.statusCode, down.json()]).toEqual([503, { error: 'outlook_busy' }]);
    g.fail = new GraphError('unauthorized', 401);
    const revoked = await get(`/api/mail/${m.id}/attachments`, repCookie);
    expect([revoked.statusCode, revoked.json()]).toEqual([409, { error: 'mailbox_not_connected' }]);
    expect((await prisma.emailAccount.findUnique({ where: { id: repBox.id } }))!.status).toBe('error');
  });

  it("an Administrator downloads another user's attachment (view only) and one audit row is written without the file name", async () => {
    const { rep, admin, repBox, m, adminCookie } = await setup();
    const list = await get(`/api/mail/${m.id}/attachments`, adminCookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().available).toBe(true);
    const res = await get(file(m.id, 'A1', true), adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    // Fetched with the owner's mailbox, server-side.
    expect(g.contentCalls).toEqual([{ accountId: repBox.id, graphId: m.graphId, attachmentId: 'A1', maxBytes: ATTACHMENT_PROXY_MAX_BYTES }]);
    const audits = await viewAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: String(m.id), userId: admin.id, after: { ownerId: rep.id, attachment: true } });
    expect(JSON.stringify(audits)).not.toContain('RFP');
  });

  it("a Sales rep asking for another user's attachment gets 404", async () => {
    const { adminMsg, repCookie } = await setup();
    expect((await get(`/api/mail/${adminMsg.id}/attachments`, repCookie)).statusCode).toBe(404);
    expect((await get(file(adminMsg.id, 'A1', true), repCookie)).statusCode).toBe(404);
    expect(g.listCalls).toEqual([]);
    expect(g.contentCalls).toEqual([]);
  });
});
