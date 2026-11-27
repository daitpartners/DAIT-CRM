import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type DraftFields, type GraphClient, type GraphDraft } from '../src/graph/client';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Web-mail release 3, Task 6: drafts in the user's own Outlook — create, open, save, discard; recipients. */

const g = vi.hoisted(() => ({
  calls: [] as unknown[][],
  replyHtml: '',
  updateError: null as Error | null,
  deleteError: null as Error | null,
  getDraft: null as null | ((id: string) => Promise<unknown>),
}));

const draft = (over: Partial<GraphDraft> = {}): GraphDraft => ({
  id: 'D1', conversationId: null, subject: '', html: '', to: [], cc: [], bcc: [], lastModified: '2026-11-27T10:00:00Z', attachments: [], ...over,
});

const graphImpl: Partial<GraphClient> = {
  async createDraft(_account, d) {
    g.calls.push(['createDraft', d]);
    return draft({ subject: d.subject, html: d.html, to: d.to, cc: d.cc });
  },
  async createReplyDraft(_account, graphId, kind) {
    g.calls.push(['createReplyDraft', graphId, kind]);
    return draft({ conversationId: 'conv-1', subject: 'RE: Proposal', html: g.replyHtml });
  },
  async updateDraft(_account, id, d) {
    g.calls.push(['updateDraft', id, d]);
    if (g.updateError) throw g.updateError;
  },
  async getDraft(_account, id) {
    g.calls.push(['getDraft', id]);
    return (await g.getDraft!(id)) as GraphDraft;
  },
  async deleteMessage(_account, id) {
    g.calls.push(['deleteMessage', id]);
    if (g.deleteError) throw g.deleteError;
  },
};

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({ graph: fakeGraph(graphImpl) });
});
afterAll(() => app.close());
beforeEach(async () => {
  g.calls = [];
  g.replyHtml = '<p></p><hr><div id="divRplyFwdMsg"><b>From:</b> Ana Ruiz</div><div>Looks good</div><script>x()</script>';
  g.updateError = null;
  g.deleteError = null;
  g.getDraft = null;
  await resetDb();
  await seedLookups();
});

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown, a: FastifyInstance = app) =>
  a.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

const personal = (userId: number, address: string) =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' } });

const SIG = '<p><br></p><div class="dait-sig"><b>Maya</b></div>';

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  await prisma.user.update({ where: { id: rep.id }, data: { signatureHtml: '<b>Maya</b>', signatureAuto: true } });
  const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com', country: 'United States' });
  await prisma.company.update({ where: { id: acme.id }, data: { timezone: 'America/Chicago' } });
  const ana = await makeContact({ companyId: acme.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@acme.com' });
  await makeContact({ companyId: acme.id, firstName: 'Jo', lastName: 'Underscore', businessEmail: 'jo_e@acme.com' });
  const lead = await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: rep.id, status: 'New', businessEmail: 'ana@acme.com' });
  const zeta = await makeCompany({ name: 'Zeta', website: 'https://zeta.com' });
  const zed = await makeContact({ companyId: zeta.id, firstName: 'Zed', lastName: 'Ana', businessEmail: 'zed@zeta.com' });
  const hidden = await makeLead({ companyId: zeta.id, contactId: zed.id, assignedToId: carlos.id, status: 'New', businessEmail: 'zed@zeta.com' });
  const repBox = await personal(rep.id, 'maya@daitpartners.com');
  const carlosBox = await personal(carlos.id, 'carlos@daitpartners.com');
  const adminBox = await personal(admin.id, 'deepak@daitpartners.com');
  const repCookie = await signIn(app, rep);
  return { rep, carlos, admin, acme, ana, lead, hidden, repBox, carlosBox, adminBox, repCookie };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

let n = 0;
async function msg(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Proposal', bodyText: 'Looks good', bodyHtml: '<div>Looks good</div>', graphId: `g-${n}`,
      threadId: `conv-${n}`, occurredAt: new Date('2026-11-20T10:00:00Z'),
      ...(data as object),
    },
  });
}

/** A CRM draft of Maya's, as POST /mail/drafts makes it (a reply, with its quote). */
const crmDraft = (f: Fixture, data: Partial<EmailMessage> = {}) => msg(f.rep.id, f.repBox.id, {
  folder: 'drafts', status: 'draft', source: 'crm', fromAddress: 'maya@daitpartners.com', fromName: null, toAddresses: [], subject: 'Re: Proposal',
  bodyText: '', bodyHtml: '', graphId: 'D9', quotedHtml: '<div id="divRplyFwdMsg">Quoted</div>', leadId: f.lead.id, ...data,
});

const updates = () => g.calls.filter((c) => c[0] === 'updateDraft') as [string, string, DraftFields][];

describe('drafts API (web-mail release 3)', () => {
  it('New: creates an Outlook draft and a CRM draft row on the lead, with the signature when Add automatically is on', async () => {
    const f = await setup();
    const res = await call('POST', '/api/mail/drafts', f.repCookie, { kind: 'new', leadId: f.lead.id });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      replyToId: null, leadId: f.lead.id, bodyHtml: SIG, quotedHtml: null, from: 'maya@daitpartners.com', to: [], subject: '', status: 'draft',
      files: [], scheduledAt: null, recipientZone: { zone: 'America/Chicago', label: 'Chicago' },
      lead: { company: { name: 'Acme' }, contact: { name: 'Ana Ruiz' } },
    });
    expect(g.calls).toEqual([['createDraft', { subject: '', html: SIG, to: [], cc: [], bcc: [], from: null }]]);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: res.json().id } })).toMatchObject({
      source: 'crm', status: 'draft', folder: 'drafts', graphId: 'D1', userId: f.rep.id, accountId: f.repBox.id,
      leadId: f.lead.id, companyId: f.acme.id, contactId: f.ana.id, fromAddress: 'maya@daitpartners.com',
    });
  });

  it('New on a lead the user cannot see is 404 and Outlook is not called; a project of another company is 400 invalid_project', async () => {
    const f = await setup();
    expect((await call('POST', '/api/mail/drafts', f.repCookie, { kind: 'new', leadId: f.hidden.id })).statusCode).toBe(404);
    const other = await prisma.project.create({
      data: { number: 'PRJ-9', companyId: f.hidden.companyId!, name: 'Z', startDate: new Date('2026-11-01T00:00:00Z'), currency: 'INR', managerId: f.admin.id, createdById: f.admin.id },
    });
    const res = await call('POST', '/api/mail/drafts', await signIn(app, f.admin), { kind: 'new', leadId: f.lead.id, projectId: other.id });
    expect(res.json()).toEqual({ error: 'invalid_project' });
    expect(g.calls).toEqual([]);
  });

  it('Reply all: createReplyAll on the original, To = sender + other To without mine, Cc = original Cc without mine, subject Re:, quote kept, same thread', async () => {
    const f = await setup();
    const original = await msg(f.rep.id, f.repBox.id, {
      leadId: f.lead.id, companyId: f.acme.id, contactId: f.ana.id, graphId: 'g-orig', threadId: 'conv-1',
      toAddresses: ['maya@daitpartners.com', 'bo@acme.com'], ccAddresses: ['cy@acme.com', 'Maya@daitpartners.com'],
    });
    const res = await call('POST', '/api/mail/drafts', f.repCookie, { kind: 'replyAll', replyToId: original.id });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(g.calls).toEqual([
      ['createReplyDraft', original.graphId, 'replyAll'],
      ['updateDraft', 'D1', expect.objectContaining({ to: ['ana@acme.com', 'bo@acme.com'], cc: ['cy@acme.com'], subject: 'Re: Proposal' })],
    ]);
    expect(body).toMatchObject({
      quotedHtml: expect.stringContaining('divRplyFwdMsg'), replyToId: original.id, leadId: f.lead.id, subject: 'Re: Proposal', bodyHtml: SIG,
      to: [{ address: 'ana@acme.com', name: 'Ana Ruiz', leadNumber: f.lead.number }, { address: 'bo@acme.com', name: null, leadNumber: null }],
      cc: [{ address: 'cy@acme.com', name: null, leadNumber: null }],
    });
    expect(body.quotedHtml).not.toContain('script');
    // Outlook holds the user part and the sanitised quote, exactly as the CRM shows them.
    expect(updates()[0]![2].html).toBe(SIG + body.quotedHtml);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: body.id } })).toMatchObject({
      threadId: 'conv-1', replyToId: original.id, folder: 'drafts', status: 'draft', source: 'crm', graphId: 'D1', companyId: f.acme.id, contactId: f.ana.id,
    });
  });

  it('Forward of a CRM-only original builds the quote from the stored message (From, Sent in the sender zone, To, Subject)', async () => {
    const f = await setup();
    await prisma.user.update({ where: { id: f.rep.id }, data: { timezone: 'America/Chicago', signatureAuto: false } });
    const original = await msg(f.rep.id, f.repBox.id, {
      folder: 'sent', status: 'sent', source: 'crm', graphId: null, threadId: null, fromAddress: 'maya@daitpartners.com', fromName: null,
      toAddresses: ['ana@acme.com'], subject: 'Proposal', bodyHtml: '<p>Our offer</p>', bodyText: 'Our offer', leadId: f.lead.id,
    });
    const res = await call('POST', '/api/mail/drafts', f.repCookie, { kind: 'forward', replyToId: original.id });
    expect(res.statusCode).toBe(201);
    expect(g.calls).toEqual([['createDraft', expect.objectContaining({ to: [], cc: [], subject: 'Fw: Proposal' })]]);
    const quote: string = res.json().quotedHtml;
    for (const part of ['From: maya@daitpartners.com', 'Sent: 20 Nov 2026, 04:00', 'To: ana@acme.com', 'Subject: Proposal', '<p>Our offer</p>']) {
      expect(quote).toContain(part);
    }
    expect(res.json()).toMatchObject({ bodyHtml: '', to: [], subject: 'Fw: Proposal' });
    expect((g.calls[0]![1] as DraftFields).html).toBe(quote);
  });

  it('a reply to a draft is 409 draft; a reply with no replyToId is 400', async () => {
    const f = await setup();
    const d = await crmDraft(f);
    expect((await call('POST', '/api/mail/drafts', f.repCookie, { kind: 'reply', replyToId: d.id })).json()).toEqual({ error: 'draft' });
    expect((await call('POST', '/api/mail/drafts', f.repCookie, { kind: 'reply' })).statusCode).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("a reply draft on another user's message is 403 view_only and Graph is not called (team view)", async () => {
    const f = await setup();
    const original = await msg(f.rep.id, f.repBox.id, { leadId: f.lead.id, companyId: f.acme.id });
    const res = await call('POST', '/api/mail/drafts', await signIn(app, f.admin), { kind: 'reply', replyToId: original.id });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'view_only' });
    const carlosRes = await call('POST', '/api/mail/drafts', await signIn(app, f.carlos), { kind: 'reply', replyToId: original.id });
    expect(carlosRes.statusCode).toBe(404);
    expect(g.calls).toEqual([]);
  });

  it("opening, saving or discarding another user's draft is 403 view_only; a Sales rep gets 404", async () => {
    const f = await setup();
    const d = await crmDraft(f);
    const save = { to: ['ana@acme.com'], subject: 'S', bodyHtml: '<p>x</p>' };
    for (const [cookie, status] of [[await signIn(app, f.admin), 403], [await signIn(app, f.carlos), 404]] as const) {
      const responses = [
        await call('GET', `/api/mail/drafts/${d.id}`, cookie),
        await call('PATCH', `/api/mail/drafts/${d.id}`, cookie, save),
        await call('DELETE', `/api/mail/drafts/${d.id}`, cookie),
      ];
      expect(responses.map((r) => r.statusCode)).toEqual([status, status, status]);
      if (status === 403) expect(responses.map((r) => r.json())).toEqual(Array(3).fill({ error: 'view_only' }));
    }
    expect(g.calls).toEqual([]);
    expect(await prisma.emailMessage.count({ where: { id: d.id } })).toBe(1);
  });

  it('a message that is not a draft (or is being sent) is 409 not_draft on the drafts routes', async () => {
    const f = await setup();
    const received = await msg(f.rep.id, f.repBox.id);
    const queued = await crmDraft(f, { status: 'queued' });
    for (const id of [received.id, queued.id]) {
      expect((await call('GET', `/api/mail/drafts/${id}`, f.repCookie)).json()).toEqual({ error: 'not_draft' });
      expect((await call('PATCH', `/api/mail/drafts/${id}`, f.repCookie, { bodyHtml: '<p>x</p>' })).json()).toEqual({ error: 'not_draft' });
    }
    expect(g.calls).toEqual([]);
  });

  it('opens a CRM draft from its row', async () => {
    const f = await setup();
    const d = await crmDraft(f, { toAddresses: ['ana@acme.com'], bccAddresses: ['b@acme.com'], bodyHtml: '<p>Hi</p>' });
    const res = await call('GET', `/api/mail/drafts/${d.id}`, f.repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: d.id, subject: 'Re: Proposal', bodyHtml: '<p>Hi</p>', quotedHtml: '<div id="divRplyFwdMsg">Quoted</div>',
      to: [{ address: 'ana@acme.com', name: 'Ana Ruiz', leadNumber: f.lead.number }], bcc: [{ address: 'b@acme.com', name: null, leadNumber: null }],
      savedAt: d.updatedAt.toISOString(),
    });
    expect(g.calls).toEqual([]);
  });

  it('save: the user part is sanitised (no script), Outlook gets user part + quote, the row keeps To/Cc/Bcc/subject', async () => {
    const f = await setup();
    const quote = '<div id="divRplyFwdMsg">Quoted</div>';
    const d = await crmDraft(f, { quotedHtml: quote, status: 'failed', lastError: 'x' });
    const res = await call('PATCH', `/api/mail/drafts/${d.id}`, f.repCookie, {
      to: ['ana@acme.com'], cc: ['cy@acme.com'], bcc: ['b@acme.com'], subject: 'S', bodyHtml: '<p>Hi</p><script>x()</script>',
    });
    expect(res.statusCode).toBe(200);
    expect(updates().at(-1)![1]).toBe('D9');
    expect(updates().at(-1)![2]).toMatchObject({ html: '<p>Hi</p>' + quote, to: ['ana@acme.com'], cc: ['cy@acme.com'], bcc: ['b@acme.com'], subject: 'S' });
    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({
      toAddresses: ['ana@acme.com'], ccAddresses: ['cy@acme.com'], bccAddresses: ['b@acme.com'], subject: 'S', bodyHtml: '<p>Hi</p>', bodyText: 'Hi',
      quotedHtml: quote, status: 'draft', lastError: null, leadId: f.lead.id,
    });
    expect(res.json()).toEqual({ savedAt: row.updatedAt.toISOString() });
  });

  it('save: an empty body is kept as an empty draft; the lead can be cleared; another lead must be visible', async () => {
    const f = await setup();
    const d = await crmDraft(f, { quotedHtml: null });
    expect((await call('PATCH', `/api/mail/drafts/${d.id}`, f.repCookie, { bodyHtml: '', leadId: null })).statusCode).toBe(200);
    expect(updates().at(-1)![2]).toMatchObject({ html: '', to: [], subject: '' });
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ bodyHtml: '', leadId: null });
    expect((await call('PATCH', `/api/mail/drafts/${d.id}`, f.repCookie, { bodyHtml: '<p>x</p>', leadId: f.hidden.id })).statusCode).toBe(404);
  });

  it('save after the draft was deleted in Outlook is 409 draft_gone (Review Focus 3)', async () => {
    const f = await setup();
    const d = await crmDraft(f);
    g.updateError = new GraphError('graph_request_failed status=404', 404);
    const res = await call('PATCH', `/api/mail/drafts/${d.id}`, f.repCookie, { to: ['ana@acme.com'], subject: 'Changed', bodyHtml: '<p>Hi</p>' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'draft_gone' });
    // Nothing is saved over the row when Outlook no longer has the draft.
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ subject: 'Re: Proposal', bodyHtml: '' });
  });

  it('a draft made in Outlook opens fresh from Graph, whole body editable', async () => {
    const f = await setup();
    const d = await msg(f.rep.id, f.repBox.id, { folder: 'drafts', status: 'draft', source: 'sync', graphId: 'OD1', fromAddress: 'maya@daitpartners.com', toAddresses: [], subject: 'Old' });
    g.getDraft = async () => draft({ id: 'OD1', conversationId: 'conv-od', subject: 'Outlook made', html: '<p>From Outlook</p><script>x()</script>', to: ['ana@acme.com'] });
    const res = await call('GET', `/api/mail/drafts/${d.id}`, f.repCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      subject: 'Outlook made', bodyHtml: '<p>From Outlook</p>', quotedHtml: null, to: [{ address: 'ana@acme.com', name: 'Ana Ruiz', leadNumber: f.lead.number }],
    });
    expect(g.calls).toEqual([['getDraft', 'OD1']]);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      subject: 'Outlook made', toAddresses: ['ana@acme.com'], bodyHtml: '<p>From Outlook</p>', threadId: 'conv-od', quotedHtml: null,
    });
  });

  it('a draft made in Outlook and since deleted or sent there opens as 409 draft_gone', async () => {
    const f = await setup();
    const d = await msg(f.rep.id, f.repBox.id, { folder: 'drafts', status: 'draft', source: 'sync', graphId: 'OD1' });
    for (const err of [new GraphError('graph_request_failed status=404', 404), new GraphError('not_a_draft', 409)]) {
      g.getDraft = async () => {
        throw err;
      };
      expect((await call('GET', `/api/mail/drafts/${d.id}`, f.repCookie)).json()).toEqual({ error: 'draft_gone' });
    }
  });

  it('discard deletes the Outlook draft (404 tolerated) and the row', async () => {
    const f = await setup();
    const a = await crmDraft(f, { graphId: 'DA' });
    const b = await crmDraft(f, { graphId: 'DB' });
    expect((await call('DELETE', `/api/mail/drafts/${a.id}`, f.repCookie)).statusCode).toBe(204);
    g.deleteError = new GraphError('graph_request_failed status=404', 404);
    expect((await call('DELETE', `/api/mail/drafts/${b.id}`, f.repCookie)).statusCode).toBe(204);
    expect(g.calls).toEqual([['deleteMessage', 'DA'], ['deleteMessage', 'DB']]);
    expect(await prisma.emailMessage.count({ where: { id: { in: [a.id, b.id] } } })).toBe(0);
  });

  it('discard: another Outlook refusal keeps the row (503 outlook_busy)', async () => {
    const f = await setup();
    const d = await crmDraft(f);
    g.deleteError = new GraphError('graph_request_failed status=503', 503);
    expect((await call('DELETE', `/api/mail/drafts/${d.id}`, f.repCookie)).json()).toEqual({ error: 'outlook_busy' });
    expect(await prisma.emailMessage.count({ where: { id: d.id } })).toBe(1);
  });

  it('recipients: suggestions from visible contacts and leads with lead numbers; resolve names known addresses', async () => {
    const f = await setup();
    const res = await call('GET', '/api/mail/recipients?q=ana', f.repCookie);
    expect(res.statusCode).toBe(200);
    // Zed Ana (zed@zeta.com) is on Carlos's lead, at a company Maya cannot see.
    expect(res.json()).toEqual({ items: [{ address: 'ana@acme.com', name: 'Ana Ruiz', leadNumber: f.lead.number }] });
    expect((await call('GET', '/api/mail/recipients?q=ACME.c', f.repCookie)).json().items).toHaveLength(2);
    // ILIKE wildcards are matched literally.
    expect((await call('GET', '/api/mail/recipients?q=%25', f.repCookie)).json()).toEqual({ items: [] });
    const underscore = (await call('GET', '/api/mail/recipients?q=o_', f.repCookie)).json();
    expect(underscore).toEqual({ items: [{ address: 'jo_e@acme.com', name: 'Jo Underscore', leadNumber: null }] });
    expect((await call('GET', '/api/mail/recipients', f.repCookie)).statusCode).toBe(400);
    const admin = await call('GET', '/api/mail/recipients?q=ana', await signIn(app, f.admin));
    expect(admin.json().items.map((r: { address: string }) => r.address)).toEqual(['ana@acme.com', 'zed@zeta.com']);

    const resolved = await call('POST', '/api/mail/recipients/resolve', f.repCookie, { addresses: ['ANA@acme.com', 'x@y.com', 'zed@zeta.com'] });
    expect(resolved.json()).toEqual({
      items: [
        { address: 'ana@acme.com', name: 'Ana Ruiz', leadNumber: f.lead.number },
        { address: 'x@y.com', name: null, leadNumber: null },
        { address: 'zed@zeta.com', name: null, leadNumber: null },
      ],
    });
  });

  it('no connected mailbox: 409 no_mailbox', async () => {
    const f = await setup();
    await prisma.emailAccount.update({ where: { id: f.repBox.id }, data: { status: 'error' } });
    const res = await call('POST', '/api/mail/drafts', f.repCookie, { kind: 'new' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'no_mailbox' });
    const d = await crmDraft(f);
    expect((await call('PATCH', `/api/mail/drafts/${d.id}`, f.repCookie, { bodyHtml: '<p>x</p>' })).json()).toEqual({ error: 'no_mailbox' });
    expect(g.calls).toEqual([]);
  });

  it('nothing about the mail is logged on a Graph refusal', async () => {
    const f = await setup();
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const logged = await buildApp({ graph: fakeGraph(graphImpl), logger: true });
    try {
      const d = await crmDraft(f);
      g.updateError = new GraphError('graph_request_failed status=400 code=ErrorInvalidRecipients', 400);
      const res = await call('PATCH', `/api/mail/drafts/${d.id}`, await signIn(logged, f.rep), {
        to: ['secret.person@acme.com'], subject: 'Secret subject', bodyHtml: '<p>Secret body</p>',
      }, logged);
      expect(res.json()).toEqual({ error: 'outlook_refused' });
    } finally {
      spy.mockRestore();
      await logged.close();
    }
    const out = lines.join('');
    expect(out).toContain('mailbox change refused');
    for (const secret of ['secret.person', 'Secret subject', 'Secret body', 'ErrorInvalidRecipients']) expect(out).not.toContain(secret);
  });
});
