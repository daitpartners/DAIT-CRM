import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type GraphClient } from '../src/graph/client';
import { resetBodyFetchBackoff } from '../src/routes/mail';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Web-mail release 1, Task 8: Administrators and Managers read every user's lead mail, view only, audited. */

const bodies = vi.hoisted(() => ({ calls: [] as { accountId: number; graphId: string }[], answer: null as null | GraphClient['messageBody'] }));
let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({
    graph: fakeGraph({
      async messageBody(account, graphId) {
        bodies.calls.push({ accountId: account.id, graphId });
        if (!bodies.answer) throw new GraphError('graph_request_failed status=503', 503);
        return bodies.answer(account, graphId);
      },
    }),
  });
});
afterAll(() => app.close());
beforeEach(async () => {
  bodies.calls = [];
  bodies.answer = null;
  resetBodyFetchBackoff();
  await resetDb();
  await seedLookups();
});

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const personal = (userId: number, address: string, status = 'connected') =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status } });

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const manager = await makeUser({ role: 'MANAGER', name: 'Neha Rao' });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const beta = await makeCompany({ name: 'Beta', website: 'https://beta.io' });
  const ana = await makeContact({ companyId: acme.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@acme.com' });
  const leadA = await makeLead({ companyId: acme.id, contactId: ana.id, assignedToId: rep.id, status: 'New' });
  const leadB = await makeLead({ companyId: beta.id, assignedToId: carlos.id, status: 'New' });
  const repBox = await personal(rep.id, 'maya@daitpartners.com');
  const carlosBox = await personal(carlos.id, 'carlos@daitpartners.com');
  const adminBox = await personal(admin.id, 'deepak@daitpartners.com');
  return { rep, carlos, admin, manager, acme, beta, ana, leadA, leadB, repBox, carlosBox, adminBox };
}

/** A message synced into `userId`'s mailbox. */
let n = 0;
async function msg(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Proposal', bodyText: 'Looks good', graphId: `g-${n}`,
      threadId: `conv-${n}`, isRead: false, occurredAt: new Date('2026-11-20T10:00:00Z'),
      ...(data as object),
    },
  });
}

/** The fixture mail: lead mail, a draft, unlinked mail and deleted-lead mail in Maya's box; lead and contact mail in Carlos's. */
async function mailbox(f: Awaited<ReturnType<typeof setup>>) {
  const proposal = await msg(f.rep.id, f.repBox.id, { leadId: f.leadA.id, companyId: f.acme.id, contactId: f.ana.id, subject: 'Proposal' });
  const draft = await msg(f.rep.id, f.repBox.id, { leadId: f.leadA.id, companyId: f.acme.id, folder: 'drafts', status: 'draft', subject: 'Draft to Ana' });
  const personalMail = await msg(f.rep.id, f.repBox.id, { subject: 'Personal', fromAddress: 'mum@gmail.com' });
  const deletedLead = await msg(f.rep.id, f.repBox.id, { subject: 'Old lead', fromAddress: 'gone@old.com', leadDeletedAt: new Date('2026-11-25T10:00:00Z') });
  const beta = await msg(f.carlos.id, f.carlosBox.id, { leadId: f.leadB.id, companyId: f.beta.id, subject: 'Beta pricing', fromAddress: 'bo@beta.io', occurredAt: new Date('2026-11-20T11:00:00Z') });
  const contactOnly = await msg(f.carlos.id, f.carlosBox.id, { contactId: f.ana.id, companyId: f.acme.id, subject: 'Contact only', occurredAt: new Date('2026-11-20T09:00:00Z') });
  const own = await msg(f.admin.id, f.adminBox.id, { subject: 'Admin own', fromAddress: 'x@gmail.com', occurredAt: new Date('2026-11-20T08:00:00Z') });
  return { proposal, draft, personalMail, deletedLead, beta, contactOnly, own };
}

type Item = { subject: string; owner: { id: number; name: string }; viewOnly: boolean };
const list = async (url: string, cookie: string) => {
  const res = await call('GET', url, cookie);
  expect(res.statusCode).toBe(200);
  return (res.json().items as Item[]).map((i) => i.subject);
};

describe('team mail (web-mail release 1)', () => {
  it('a Sales rep asking for mailOf=all or another user gets 403 forbidden; me and their own id are fine', async () => {
    const f = await setup();
    await mailbox(f);
    const repCookie = await signIn(app, f.rep);
    expect((await call('GET', '/api/mail?mailOf=all', repCookie)).json()).toEqual({ error: 'forbidden' });
    expect((await call('GET', '/api/mail?mailOf=all', repCookie)).statusCode).toBe(403);
    expect((await call('GET', `/api/mail?mailOf=${f.carlos.id}`, repCookie)).statusCode).toBe(403);
    expect((await call('GET', '/api/mail/meta?mailOf=all', repCookie)).statusCode).toBe(403);
    expect(await list('/api/mail?mailOf=me', repCookie)).toEqual(['Old lead', 'Personal', 'Proposal']);
    expect(await list(`/api/mail?mailOf=${f.rep.id}`, repCookie)).toEqual(['Old lead', 'Personal', 'Proposal']);
    expect((await call('GET', '/api/mail?mailOf=bob', repCookie)).statusCode).toBe(400);
  });

  it("Everyone (Administrator and Manager): own mail plus others' lead mail with owner and viewOnly; others' drafts, unlinked and deleted-lead mail stay out", async () => {
    const f = await setup();
    await mailbox(f);
    for (const [viewer, own] of [[f.admin, [['Admin own', 'Deepak Singh', false]]], [f.manager, []]] as const) {
      const res = await call('GET', '/api/mail?mailOf=all', await signIn(app, viewer));
      const items = res.json().items as Item[];
      expect(items.map((i) => [i.subject, i.owner.name, i.viewOnly])).toEqual([
        ['Beta pricing', 'Carlos Mendez', true],
        ['Proposal', 'Maya Pillai', true],
        ['Contact only', 'Carlos Mendez', true],
        ...own,
      ]);
      expect(res.json().total).toBe(3 + own.length);
    }
    const adminCookie = await signIn(app, f.admin);
    expect(await list('/api/mail?mailOf=all&view=drafts', adminCookie)).toEqual([]);
    // Without mailOf an Administrator sees their own mailbox, as before.
    expect(await list('/api/mail', adminCookie)).toEqual(['Admin own']);
  });

  it('Mail of <user>: only that mailbox; search, awaiting, company and lead filters stay inside the scope', async () => {
    const f = await setup();
    await mailbox(f);
    await msg(f.rep.id, f.repBox.id, { leadId: f.leadA.id, companyId: f.acme.id, folder: 'sent', status: 'sent', subject: 'Follow up', fromAddress: 'maya@daitpartners.com', toAddresses: ['ana@acme.com'] });
    await msg(f.carlos.id, f.carlosBox.id, { leadId: f.leadB.id, companyId: f.beta.id, folder: 'sent', status: 'sent', subject: 'Beta quote', fromAddress: 'carlos@daitpartners.com', toAddresses: ['bo@beta.io'], occurredAt: new Date('2026-11-21T10:00:00Z') });
    const cookie = await signIn(app, f.admin);
    const maya = `mailOf=${f.rep.id}`;
    expect(await list(`/api/mail?${maya}`, cookie)).toEqual(['Proposal']);
    expect(await list(`/api/mail?${maya}&s=Beta`, cookie)).toEqual([]);
    expect(await list(`/api/mail?${maya}&s=Personal`, cookie)).toEqual([]);
    expect(await list('/api/mail?mailOf=all&s=Beta', cookie)).toEqual(['Beta pricing']);
    expect(await list(`/api/mail?${maya}&view=awaiting`, cookie)).toEqual(['Follow up']);
    expect(await list('/api/mail?mailOf=all&view=awaiting', cookie)).toEqual(['Beta quote', 'Follow up']);
    expect(await list(`/api/mail?${maya}&company=${f.beta.id}`, cookie)).toEqual([]);
    expect(await list(`/api/mail?mailOf=${f.carlos.id}&company=${f.acme.id}`, cookie)).toEqual(['Contact only']);
    expect(await list(`/api/mail?${maya}&lead=${f.leadB.id}`, cookie)).toEqual([]);
    expect(await list(`/api/mail?mailOf=all&lead=${f.leadB.id}`, cookie)).toEqual(['Beta pricing']);
    // An Administrator's own id is their own mailbox, drafts and unlinked mail included.
    expect(await list(`/api/mail?mailOf=${f.admin.id}`, cookie)).toEqual(['Admin own']);
    const meta = (await call('GET', `/api/mail/meta?${maya}`, cookie)).json();
    expect(meta.unread).toBe(1);
    expect(meta.companies.map((c: { name: string }) => c.name)).toEqual(['Acme']);
    expect(meta.leads.map((l: { id: number }) => l.id)).toEqual([f.leadA.id]);
    const all = (await call('GET', '/api/mail/meta?mailOf=all', cookie)).json();
    expect(all.unread).toBe(4);
    expect(all.companies.map((c: { name: string }) => c.name)).toEqual(['Acme', 'Beta']);
    expect(all.mailbox).toMatchObject({ address: 'deepak@daitpartners.com' });
  });

  it("opening another user's message: 200 viewOnly, stays unread, no mail_action, one audit row without content (Review Focus 4)", async () => {
    const f = await setup();
    const { proposal: m } = await mailbox(f);
    const adminCookie = await signIn(app, f.admin);
    for (const q of ['', '?peek=1']) {
      const res = await call('GET', `/api/mail/${m.id}${q}`, adminCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: m.id, viewOnly: true, owner: { id: f.rep.id, name: 'Maya Pillai' }, isRead: false, subject: 'Proposal' });
    }
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).isRead).toBe(false);
    expect(await prisma.job.count({ where: { type: 'mail_action' } })).toBe(0);
    const audits = await prisma.auditLog.findMany({ where: { action: 'view' }, orderBy: { id: 'asc' } });
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ entityType: 'email_message', entityId: String(m.id), action: 'view', userId: f.admin.id, after: { ownerId: f.rep.id } });
    expect(JSON.stringify(audits)).not.toMatch(/Proposal|acme|Looks good/);
    // The owner opening it is not audited, and marks it read as before.
    const own = await call('GET', `/api/mail/${m.id}`, await signIn(app, f.rep));
    expect(own.json()).toMatchObject({ viewOnly: false, owner: { id: f.rep.id }, isRead: true });
    expect(await prisma.auditLog.count({ where: { action: 'view' } })).toBe(2);
  });

  it("the thread of another user's message comes from the owner's mailbox, team-readable mail only, worded with the owner's name", async () => {
    const f = await setup();
    const { proposal: m } = await mailbox(f);
    await msg(f.rep.id, f.repBox.id, { leadId: f.leadA.id, folder: 'sent', status: 'sent', subject: 'Re: Proposal', fromAddress: 'maya@daitpartners.com', fromName: null, toAddresses: ['ana@acme.com'], threadId: m.threadId, occurredAt: new Date('2026-11-20T12:00:00Z') });
    await msg(f.rep.id, f.repBox.id, { leadId: f.leadA.id, folder: 'drafts', status: 'draft', subject: 'Re: Re: Proposal', threadId: m.threadId, occurredAt: new Date('2026-11-20T13:00:00Z') });
    await msg(f.rep.id, f.repBox.id, { subject: 'Fwd: Proposal', threadId: m.threadId, occurredAt: new Date('2026-11-20T14:00:00Z') });
    await msg(f.admin.id, f.adminBox.id, { leadId: f.leadA.id, subject: 'Proposal (admin copy)', threadId: m.threadId });
    const res = (await call('GET', `/api/mail/${m.id}`, await signIn(app, f.admin))).json();
    expect(res.thread.map((t: { subject: string; by: string | null }) => [t.subject, t.by])).toEqual([['Re: Proposal', 'Maya'], ['Proposal', null]]);
  });

  it("an Administrator or Manager gets the HTML body of another user's older message, read from the owner's mailbox without marking it read", async () => {
    const f = await setup();
    const { proposal: m } = await mailbox(f);
    bodies.answer = async () => ({ contentType: 'html', content: '<p>Hello <b>team</b></p><script>x()</script>' });
    const res = (await call('GET', `/api/mail/${m.id}`, await signIn(app, f.manager))).json();
    expect(bodies.calls).toEqual([{ accountId: f.repBox.id, graphId: m.graphId }]);
    expect(res.bodyHtml).toContain('<b>team</b>');
    expect(res.bodyHtml).not.toMatch(/script/);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ isRead: false, bodyHtml: res.bodyHtml });
    expect(await prisma.job.count()).toBe(0);
  });

  it("reply, read, archive, change, link and create-lead on another user's message are 403 view_only and change nothing; bulk fails it view_only", async () => {
    const f = await setup();
    const { proposal: m, contactOnly } = await mailbox(f);
    const before = await prisma.emailMessage.findMany({ orderBy: { id: 'asc' } });
    const leads = await prisma.lead.count();
    for (const viewer of [f.admin, f.manager]) {
      const cookie = await signIn(app, viewer);
      for (const [url, payload] of [
        ['/api/mail/drafts', { kind: 'reply', replyToId: m.id }],
        [`/api/mail/${m.id}/read`, { isRead: true }],
        [`/api/mail/${m.id}/archive`, undefined],
        [`/api/mail/${m.id}/change`, { type: 'delete' }],
        [`/api/mail/${m.id}/change`, { type: 'move', folder: 'archive' }],
        [`/api/mail/${m.id}/change`, { type: 'flag', flag: 'today' }],
        [`/api/mail/${m.id}/change`, { type: 'read', isRead: true }],
        [`/api/mail/${contactOnly.id}/link`, { leadId: f.leadA.id }],
        [`/api/mail/${contactOnly.id}/create-lead`, undefined],
      ] as const) {
        const res = await call('POST', url, cookie, payload);
        expect([url, res.statusCode, res.json()]).toEqual([url, 403, { error: 'view_only' }]);
      }
      // The app's Graph fake fails any mailbox change loudly, so Outlook was never asked.
      const bulk = await call('POST', '/api/mail/bulk', cookie, { ids: [m.id, contactOnly.id], change: { type: 'delete' } });
      expect([bulk.statusCode, bulk.json()]).toEqual([200, { done: [], failed: [{ id: m.id, error: 'view_only' }, { id: contactOnly.id, error: 'view_only' }] }]);
    }
    expect(await prisma.emailMessage.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.lead.count()).toBe(leads);
    expect(await prisma.job.count()).toBe(0);
  });

  it('a message that is not team-readable (draft, unlinked, deleted lead) is 404 for an Administrator', async () => {
    const f = await setup();
    const { draft, personalMail, deletedLead } = await mailbox(f);
    const cookie = await signIn(app, f.admin);
    for (const m of [draft, personalMail, deletedLead]) {
      expect((await call('GET', `/api/mail/${m.id}`, cookie)).statusCode).toBe(404);
      expect((await call('GET', `/api/mail/${m.id}?peek=1`, cookie)).statusCode).toBe(404);
      for (const action of ['log', 'task', 'archive', 'read']) {
        expect((await call('POST', `/api/mail/${m.id}/${action}`, cookie, action === 'read' ? { isRead: true } : undefined)).statusCode).toBe(404);
      }
      expect((await call('POST', `/api/mail/${m.id}/change`, cookie, { type: 'delete' })).statusCode).toBe(404);
      expect((await call('POST', '/api/mail/bulk', cookie, { ids: [m.id], change: { type: 'delete' } })).json()).toEqual({ done: [], failed: [{ id: m.id, error: 'not_found' }] });
    }
    expect(bodies.calls).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'view' } })).toBe(0);
    // A Sales rep reaching another rep's lead mail: 404, never view only.
    const beta = await prisma.emailMessage.findFirstOrThrow({ where: { subject: 'Beta pricing' } });
    const repCookie = await signIn(app, f.rep);
    expect((await call('GET', `/api/mail/${beta.id}`, repCookie)).statusCode).toBe(404);
    expect((await call('POST', '/api/mail/drafts', repCookie, { kind: 'reply', replyToId: beta.id })).statusCode).toBe(404);
    expect((await call('POST', `/api/mail/${beta.id}/task`, repCookie)).statusCode).toBe(404);
  });

  it("Log as activity and Add follow-up task work on another user's lead mail, by and for the viewer", async () => {
    const f = await setup();
    const { proposal: m } = await mailbox(f);
    const cookie = await signIn(app, f.admin);
    expect((await call('POST', `/api/mail/${m.id}/log`, cookie)).statusCode).toBe(201);
    expect(await prisma.leadActivity.findFirst({ where: { leadId: f.leadA.id, activityType: 'email' } })).toMatchObject({ relatedId: m.id, byUserId: f.admin.id });
    const task = await call('POST', `/api/mail/${m.id}/task`, await signIn(app, f.manager));
    expect(task.statusCode).toBe(201);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.json().id } })).toMatchObject({ leadId: f.leadA.id, assignedToId: f.manager.id, title: 'Reply to email' });
    // The message itself is unchanged apart from being logged; nothing is queued for Maya's mailbox.
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ isRead: false, folder: 'inbox' });
    expect(await prisma.job.count({ where: { type: 'mail_action' } })).toBe(0);
  });

  it('meta: mailUsers for Administrators and Managers (id, name, active, with a mailbox, not you); [] for a Sales rep', async () => {
    const f = await setup();
    const gone = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Aaron Gone', isActive: false });
    await personal(gone.id, 'aaron@daitpartners.com');
    const off = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Bea Off' });
    await personal(off.id, 'bea@daitpartners.com', 'disconnected');
    expect((await call('GET', '/api/mail/meta', await signIn(app, f.admin))).json().mailUsers).toEqual([
      { id: off.id, name: 'Bea Off' }, { id: f.carlos.id, name: 'Carlos Mendez' }, { id: f.rep.id, name: 'Maya Pillai' },
    ]);
    expect((await call('GET', '/api/mail/meta', await signIn(app, f.manager))).json().mailUsers).toEqual([
      { id: off.id, name: 'Bea Off' }, { id: f.carlos.id, name: 'Carlos Mendez' }, { id: f.admin.id, name: 'Deepak Singh' }, { id: f.rep.id, name: 'Maya Pillai' },
    ]);
    expect((await call('GET', '/api/mail/meta', await signIn(app, f.rep))).json().mailUsers).toEqual([]);
  });

  it('?view=deleted lists Deleted items', async () => {
    const f = await setup();
    await msg(f.rep.id, f.repBox.id, { subject: 'Binned', folder: 'deleted', leadId: f.leadA.id });
    await msg(f.rep.id, f.repBox.id, { subject: 'Kept' });
    const cookie = await signIn(app, f.rep);
    expect(await list('/api/mail?view=deleted', cookie)).toEqual(['Binned']);
    expect(await list('/api/mail', cookie)).toEqual(['Kept']);
    expect(await list(`/api/mail?mailOf=${f.rep.id}&view=deleted`, await signIn(app, f.admin))).toEqual(['Binned']);
  });
});
