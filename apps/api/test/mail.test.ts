import type { FastifyInstance } from 'fastify';
import type { EmailAccount, EmailMessage, Job } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { runOnce } from '../src/jobs/runner';
import { sendUserEmailHandler } from '../src/jobs/handlers/sendUserEmail';
import { mailActionHandler } from '../src/jobs/handlers/mailAction';
import { todayIn } from '../src/leads/dates';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeProject, makeUser, signIn } from './factory';

// Lets a test make the reply's lead lock fail like a database error would.
const lockFault = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../src/routes/leads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/routes/leads')>();
  return {
    ...actual,
    lockLeads: async (...args: Parameters<typeof actual.lockLeads>) => {
      if (lockFault.error) throw lockFault.error;
      return actual.lockLeads(...args);
    },
  };
});

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  lockFault.error = null;
  await resetDb();
  await seedLookups();
});

const call = (method: 'GET' | 'POST', url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function personal(userId: number, address: string) {
  return prisma.emailAccount.create({
    data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' },
  });
}

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const company = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const contact = await makeContact({ companyId: company.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@acme.com' });
  const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: rep.id, status: 'New' });
  const box = await personal(rep.id, 'maya@daitpartners.com');
  await personal(admin.id, 'deepak@daitpartners.com');
  return { rep, admin, company, contact, lead, box };
}

/** A message synced into `userId`'s mailbox. */
async function synced(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Proposal', bodyText: 'Looks good', graphId: `g-${Math.random()}`,
      threadId: 'conv-1', isRead: false, occurredAt: new Date('2026-11-20T10:00:00Z'),
      ...(data as object),
    },
  });
}

const runJobs = (graph = fakeGraph()) =>
  runOnce({ types: ['send_user_email', 'mail_action'], handlers: { send_user_email: sendUserEmailHandler, mail_action: mailActionHandler }, graph });

describe('compose and reply (2B-2)', () => {
  it('compose without a lead queues a message from your mailbox with the contact and company, but no lead', async () => {
    const { rep, company, contact, box } = await setup();
    const res = await call('POST', '/api/mail', await signIn(app, rep), { to: 'Ana@Acme.com', cc: [], subject: 'Hello', body: 'Hi Ana' });
    expect(res.statusCode).toBe(201);
    const m = await prisma.emailMessage.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(m).toMatchObject({ userId: rep.id, accountId: box.id, folder: 'sent', status: 'queued', source: 'crm', toAddresses: ['ana@acme.com'], contactId: contact.id, companyId: company.id, leadId: null });
    expect(await prisma.job.count({ where: { type: 'send_user_email' } })).toBe(1);
    expect(await prisma.leadActivity.count({ where: { activityType: 'email' } })).toBe(0);
  });

  it('compose on a lead writes the history line and moves New to Contacted', async () => {
    const { rep, lead } = await setup();
    const res = await call('POST', '/api/mail', await signIn(app, rep), { to: 'ana@acme.com', cc: [], subject: 'Hello', body: 'Hi', leadId: lead.id });
    expect(res.statusCode).toBe(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('Contacted');
    expect(await prisma.leadActivity.findFirst({ where: { leadId: lead.id, activityType: 'email' } })).toMatchObject({ title: 'Email sent · Hello' });
  });

  it('compose on a lead you cannot see is 404; without a mailbox 409 no_mailbox', async () => {
    const { lead } = await setup();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    await personal(other.id, 'other@daitpartners.com');
    const cookie = await signIn(app, other);
    expect((await call('POST', '/api/mail', cookie, { to: 'ana@acme.com', subject: 's', body: 'b', leadId: lead.id })).statusCode).toBe(404);
    const none = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const res = await call('POST', '/api/mail', await signIn(app, none), { to: 'ana@acme.com', subject: 's', body: 'b' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_mailbox');
  });

  it('reply answers the sender in the same conversation and keeps the links', async () => {
    const { rep, box, lead, company, contact } = await setup();
    const original = await synced(rep.id, box.id, { leadId: lead.id, companyId: company.id, contactId: contact.id });
    const res = await call('POST', `/api/mail/${original.id}/reply`, await signIn(app, rep), { cc: ['boss@acme.com'], body: 'Thanks Ana' });
    expect(res.statusCode).toBe(201);
    const m = await prisma.emailMessage.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(m).toMatchObject({
      replyToId: original.id, subject: 'Re: Proposal', toAddresses: ['ana@acme.com'], ccAddresses: ['boss@acme.com'], status: 'queued',
      leadId: lead.id, companyId: company.id, contactId: contact.id, threadId: 'conv-1',
    });
    expect(await prisma.leadActivity.count({ where: { leadId: lead.id, activityType: 'email', title: 'Email sent · Re: Proposal' } })).toBe(1);
  });

  it('reply surfaces a database error instead of sending without the lead', async () => {
    const { rep, box, lead, company, contact } = await setup();
    const original = await synced(rep.id, box.id, { leadId: lead.id, companyId: company.id, contactId: contact.id });
    const cookie = await signIn(app, rep);
    lockFault.error = new Error('connection lost');
    const res = await call('POST', `/api/mail/${original.id}/reply`, cookie, { cc: [], body: 'Thanks Ana' });
    expect(res.statusCode).toBe(500);
    expect(await prisma.emailMessage.count()).toBe(1);
    expect(await prisma.job.count({ where: { type: 'send_user_email' } })).toBe(0);
  });

  it("nobody can reply to another user's message, administrators included", async () => {
    const { rep, admin, box } = await setup();
    const original = await synced(rep.id, box.id);
    const res = await call('POST', `/api/mail/${original.id}/reply`, await signIn(app, admin), { cc: [], body: 'x' });
    expect(res.statusCode).toBe(404);
    expect(await prisma.emailMessage.count()).toBe(1);
  });

  it('the worker sends a reply through Graph reply on the original message (sendMail when it has no Graph id)', async () => {
    const { rep, box } = await setup();
    const original = await synced(rep.id, box.id, { graphId: 'orig-1' });
    const cookie = await signIn(app, rep);
    await call('POST', `/api/mail/${original.id}/reply`, cookie, { cc: [], body: 'Thanks' });
    const replies: { graphId: string; to: string[]; html: string }[] = [];
    const sends: string[] = [];
    const graph = fakeGraph({
      async reply(_a: EmailAccount, graphId, m) { replies.push({ graphId, to: m.to, html: m.html }); },
      async sendMail(_a, m) { sends.push(m.subject); },
    });
    await runJobs(graph);
    expect(replies).toEqual([{ graphId: 'orig-1', to: ['ana@acme.com'], html: '<div>Thanks</div>' }]);
    const crmOnly = await prisma.emailMessage.create({ data: { userId: rep.id, accountId: box.id, folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', toAddresses: ['ana@acme.com'], subject: 'First' } });
    await call('POST', `/api/mail/${crmOnly.id}/reply`, cookie, { cc: [], body: 'Again' });
    await runJobs(graph);
    expect(sends).toEqual(['Re: First']);
  });
});

describe('mail actions through Graph (2B-2)', () => {
  const action = (emailMessageId: number, a: string) => ({ id: 1, type: 'mail_action', payload: { emailMessageId, action: a }, attempts: 0, maxAttempts: 3 }) as unknown as Job;

  it('read, unread and archive call Graph on the message; one with no Graph id is left alone', async () => {
    const { rep, box } = await setup();
    const m = await synced(rep.id, box.id, { graphId: 'g-9' });
    const calls: string[] = [];
    const graph = fakeGraph({
      async markRead(_a, id, isRead) { calls.push(`read:${id}:${isRead}`); },
      async moveTo(_a, id, folder) { calls.push(`move:${id}:${folder}`); },
    });
    await mailActionHandler(action(m.id, 'read'), { graph });
    await mailActionHandler(action(m.id, 'unread'), { graph });
    await mailActionHandler(action(m.id, 'archive'), { graph });
    const local = await prisma.emailMessage.create({ data: { userId: rep.id, accountId: box.id, folder: 'sent', status: 'sent', fromAddress: 'x', subject: 's' } });
    await mailActionHandler(action(local.id, 'archive'), { graph });
    expect(calls).toEqual(['read:g-9:true', 'read:g-9:false', 'move:g-9:archive']);
  });
});

describe('reading mail on the Email screen (2B-2)', () => {
  it('each view lists only your own messages, newest first, with list fields', async () => {
    const { rep, admin, box, lead, company } = await setup();
    const a = await synced(rep.id, box.id, { subject: 'Linked', leadId: lead.id, companyId: company.id, occurredAt: new Date('2026-11-20T10:00:00Z'), bodyText: 'Line one\n\n  line   two' });
    const b = await synced(rep.id, box.id, { subject: 'Loose', occurredAt: new Date('2026-11-21T10:00:00Z'), isRead: true });
    const s = await synced(rep.id, box.id, { subject: 'Mine out', folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', toAddresses: ['ana@acme.com'], leadId: lead.id, threadId: 'conv-2' });
    await synced(rep.id, box.id, { subject: 'Draft', folder: 'drafts', status: 'draft' });
    await synced(rep.id, box.id, { subject: 'Old', folder: 'archive' });
    await synced(admin.id, null, { subject: 'Not yours' });
    const cookie = await signIn(app, rep);
    const view = async (q: string) => (await call('GET', `/api/mail?${q}`, cookie)).json().items.map((i: { subject: string }) => i.subject);
    expect(await view('view=inbox')).toEqual(['Loose', 'Linked']);
    expect(await view('view=sent')).toEqual(['Mine out']);
    expect(await view('view=drafts')).toEqual(['Draft']);
    expect(await view('view=archive')).toEqual(['Old']);
    expect(await view('view=unlinked')).toEqual(['Loose', 'Old']);
    expect(await view('view=mine')).toEqual(['Mine out', 'Linked']);
    expect(await view('view=awaiting')).toEqual(['Mine out']);
    expect(await view(`view=inbox&company=${company.id}`)).toEqual(['Linked']);
    expect(await view(`view=sent&lead=${lead.id}`)).toEqual(['Mine out']);
    expect(await view('view=inbox&s=LOOSE')).toEqual(['Loose']);
    expect(await view('view=sent&s=ana@acme')).toEqual(['Mine out']);
    const item = (await call('GET', '/api/mail?view=inbox', cookie)).json().items[1];
    expect(item).toMatchObject({ id: a.id, fromName: 'Ana Ruiz', fromAddress: 'ana@acme.com', isRead: false, leadId: lead.id, leadNumber: lead.number, preview: 'Line one line two' });
    expect(item.bodyText).toBeUndefined();
    expect((await call('GET', '/api/mail?view=inbox', await signIn(app, admin))).json().items.map((i: { subject: string }) => i.subject)).toEqual(['Not yours']);
    void b; void s;
  });

  it('a reply received after your message takes it off Awaiting reply', async () => {
    const { rep, box, lead } = await setup();
    await synced(rep.id, box.id, { folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', leadId: lead.id, threadId: 't', occurredAt: new Date('2026-11-20T10:00:00Z') });
    await synced(rep.id, box.id, { leadId: lead.id, threadId: 't', occurredAt: new Date('2026-11-21T10:00:00Z') });
    expect((await call('GET', '/api/mail?view=awaiting', await signIn(app, rep))).json().items).toEqual([]);
  });

  it('list hides the number of a lead the user can no longer see', async () => {
    const { rep, box, lead, company } = await setup();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const m = await synced(rep.id, box.id, { leadId: lead.id, companyId: company.id });
    await synced(rep.id, box.id, { subject: 'Draft', folder: 'drafts', status: 'draft', leadId: lead.id });
    await prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: other.id } });
    const cookie = await signIn(app, rep);
    const inbox = (await call('GET', '/api/mail?view=inbox', cookie)).json().items;
    expect(inbox).toEqual([expect.objectContaining({ id: m.id, leadId: null, leadNumber: null, companyId: company.id })]);
    const unlinked = (await call('GET', '/api/mail?view=unlinked', cookie)).json().items;
    expect(unlinked.map((i: { id: number }) => i.id)).toEqual([m.id]);
    expect(unlinked[0]).toMatchObject({ leadId: null, leadNumber: null });
    expect((await call('GET', '/api/mail/meta', cookie)).json().unlinked).toBe(1);
    // Someone who sees every lead keeps their linked mail off Unlinked.
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    await synced(admin.id, null, { subject: 'Admin linked', leadId: lead.id });
    const adminCookie = await signIn(app, admin);
    expect((await call('GET', '/api/mail?view=unlinked', adminCookie)).json().items).toEqual([]);
    expect((await call('GET', '/api/mail/meta', adminCookie)).json().unlinked).toBe(0);
  });

  it('awaiting reply finds an old message when filtered by company', async () => {
    const { rep, box, lead } = await setup();
    const y = await makeCompany({ name: 'Globex', website: 'https://globex.com' });
    const yLead = await makeLead({ companyId: y.id, assignedToId: rep.id });
    const old = await synced(rep.id, box.id, {
      folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', leadId: yLead.id, companyId: y.id, threadId: 'y', occurredAt: new Date('2026-10-01T10:00:00Z'),
    });
    await prisma.emailMessage.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        userId: rep.id, accountId: box.id, folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', subject: `X ${i}`,
        leadId: lead.id, companyId: lead.companyId, threadId: `x-${i}`, occurredAt: new Date(Date.UTC(2026, 10, 1, 0, i)),
      })),
    });
    const res = (await call('GET', `/api/mail?view=awaiting&company=${y.id}`, await signIn(app, rep))).json();
    expect(res.items.map((i: { id: number }) => i.id)).toEqual([old.id]);
  });

  it('pages the list: 50 newest per page by default, total after filters, ordering kept (owner, 22 Nov 2026)', async () => {
    const { rep, admin, box, lead, company } = await setup();
    await prisma.emailMessage.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        userId: rep.id, accountId: box.id, folder: 'inbox', status: 'received', fromAddress: 'ana@acme.com', subject: `M ${i}`,
        // Every third message is on the lead; two share each minute so the id breaks the tie.
        leadId: i % 3 === 0 ? lead.id : null, companyId: i % 3 === 0 ? company.id : null, occurredAt: new Date(Date.UTC(2026, 10, 1, 0, Math.floor(i / 2))),
      })),
    });
    await synced(admin.id, null, { subject: 'Not yours' });
    const cookie = await signIn(app, rep);
    const get = async (q: string) => (await call('GET', `/api/mail?${q}`, cookie)).json();
    const all = await prisma.emailMessage.findMany({ where: { userId: rep.id }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    const p1 = await get('view=inbox');
    expect(p1).toMatchObject({ total: 120, page: 1, pageSize: 50 });
    expect(p1.items.map((i: { id: number }) => i.id)).toEqual(all.slice(0, 50).map((m) => m.id));
    const p2 = await get('view=inbox&page=2');
    expect(p2.items.map((i: { id: number }) => i.id)).toEqual(all.slice(50, 100).map((m) => m.id));
    const p3 = await get('view=inbox&page=3');
    expect(p3).toMatchObject({ total: 120, page: 3, pageSize: 50 });
    expect(p3.items).toHaveLength(20);
    expect((await get('view=inbox&page=9')).items).toEqual([]);
    // Filters come first: 40 on the lead, 25 a page.
    const f2 = await get(`view=inbox&lead=${lead.id}&page=2&pageSize=25`);
    expect(f2).toMatchObject({ total: 40, page: 2, pageSize: 25 });
    expect(f2.items).toHaveLength(15);
    expect((await get(`view=inbox&company=${company.id}`)).total).toBe(40);
    expect(await get('view=inbox&s=M 11')).toMatchObject({ total: 11 }); // M 11, M 110–119
    expect((await get('view=sent')).total).toBe(0);
  });

  it('list page size is at most 100, as other lists', async () => {
    const { rep } = await setup();
    const cookie = await signIn(app, rep);
    expect((await call('GET', '/api/mail?view=inbox&pageSize=101', cookie)).statusCode).toBe(400);
    expect((await call('GET', '/api/mail?view=inbox&page=0', cookie)).statusCode).toBe(400);
    expect((await call('GET', '/api/mail?view=inbox&pageSize=100', cookie)).json()).toMatchObject({ items: [], total: 0, page: 1, pageSize: 100 });
  });

  it('meta gives the mailbox, unread and unlinked counts, and the clients and leads in your mail', async () => {
    const { rep, box, lead, company } = await setup();
    await synced(rep.id, box.id, { leadId: lead.id, companyId: company.id });
    await synced(rep.id, box.id, { isRead: true });
    await synced(rep.id, box.id, { folder: 'drafts', status: 'draft' });
    const meta = (await call('GET', '/api/mail/meta', await signIn(app, rep))).json();
    expect(meta).toMatchObject({
      mailbox: { address: 'maya@daitpartners.com', status: 'connected', lastSyncAt: null },
      unread: 1, unlinked: 1,
      companies: [{ id: company.id, name: 'Acme' }],
      leads: [{ id: lead.id, number: lead.number, companyId: company.id, companyName: lead.companyName, status: 'New' }],
    });
  });

  it('opening a message gives its links and conversation, marks it read and tells the mailbox', async () => {
    const { rep, admin, box, lead, company, contact } = await setup();
    const first = await synced(rep.id, box.id, { folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', fromName: 'Maya', toAddresses: ['ana@acme.com'], threadId: 't', occurredAt: new Date('2026-11-19T10:00:00Z'), isRead: true });
    const m = await synced(rep.id, box.id, { threadId: 't', leadId: lead.id, companyId: company.id, contactId: contact.id, graphId: 'g-open', attachmentNames: ['quote.pdf'] });
    const res = await call('GET', `/api/mail/${m.id}`, await signIn(app, rep));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: m.id, bodyText: 'Looks good', attachmentNames: ['quote.pdf'], isRead: true,
      lead: { id: lead.id, number: lead.number, status: 'New', priority: lead.priority }, contact: { id: contact.id, name: 'Ana Ruiz' }, company: { id: company.id, name: 'Acme' },
      // Newest first and the open message included (prototype "18 Nov 11:14 · reply received" / "… · sent by Arjun").
      thread: [
        { id: m.id, direction: 'in', who: 'Ana Ruiz', kind: 'reply', by: null, unmatched: false },
        { id: first.id, direction: 'out', who: 'ana@acme.com', kind: 'sent', by: 'Maya', unmatched: true },
      ],
    });
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).isRead).toBe(true);
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'mail_action' } })).payload).toEqual({ emailMessageId: m.id, action: 'read' });
    expect((await call('GET', `/api/mail/${m.id}`, await signIn(app, admin))).statusCode).toBe(404);
  });

  it("the opened message's lead gives its next follow-up as a calendar date (YYYY-MM-DD), like the lead API", async () => {
    const { rep, box, lead } = await setup();
    await prisma.lead.update({ where: { id: lead.id }, data: { nextFollowUp: new Date('2026-11-25T00:00:00Z') } });
    const m = await synced(rep.id, box.id, { leadId: lead.id });
    const cookie = await signIn(app, rep);
    expect((await call('GET', `/api/mail/${m.id}`, cookie)).json().lead.nextFollowUp).toBe('2026-11-25');
    await prisma.lead.update({ where: { id: lead.id }, data: { nextFollowUp: null } });
    expect((await call('GET', `/api/mail/${m.id}`, cookie)).json().lead.nextFollowUp).toBeNull();
  });

  it('a message alone in its conversation lists itself; other mailboxes in the same conversation stay out', async () => {
    const { rep, admin, box } = await setup();
    // Another user's copy of the same conversation (same Graph conversation id) is theirs only.
    await synced(admin.id, null, { threadId: 'solo', fromAddress: 'deepak@daitpartners.com', status: 'sent', folder: 'sent', occurredAt: new Date('2026-11-21T10:00:00Z') });
    const m = await synced(rep.id, box.id, { threadId: 'solo', subject: 'Interested in your work' });
    const noThread = await synced(rep.id, box.id, { threadId: null, folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', fromName: null });
    const cookie = await signIn(app, rep);
    expect((await call('GET', `/api/mail/${m.id}`, cookie)).json().thread).toEqual([
      { id: m.id, occurredAt: '2026-11-20T10:00:00.000Z', direction: 'in', who: 'Ana Ruiz', subject: 'Interested in your work', kind: 'received', by: null, unmatched: true },
    ]);
    // Without a conversation id: the message alone; sent by the mailbox owner (first name of the user when Graph gave no sender name).
    expect((await call('GET', `/api/mail/${noThread.id}`, cookie)).json().thread).toMatchObject([{ id: noThread.id, kind: 'sent', by: 'Maya' }]);
  });

  it('a preview (the first message shown on arrival) does not mark it read', async () => {
    const { rep, box } = await setup();
    const m = await synced(rep.id, box.id, { graphId: 'g-peek' });
    const res = await call('GET', `/api/mail/${m.id}?peek=1`, await signIn(app, rep));
    expect(res.statusCode).toBe(200);
    expect(res.json().isRead).toBe(false);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).isRead).toBe(false);
    expect(await prisma.job.count({ where: { type: 'mail_action' } })).toBe(0);
  });

  it('read and archive change your message at once and queue the mailbox change; others get 404', async () => {
    const { rep, admin, box } = await setup();
    const m = await synced(rep.id, box.id, { isRead: true });
    const cookie = await signIn(app, rep);
    expect((await call('POST', `/api/mail/${m.id}/read`, cookie, { isRead: false })).statusCode).toBe(200);
    expect((await call('POST', `/api/mail/${m.id}/archive`, cookie)).statusCode).toBe(200);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ isRead: false, folder: 'archive' });
    expect((await prisma.job.findMany({ where: { type: 'mail_action' }, orderBy: { id: 'asc' } })).map((j) => (j.payload as { action: string }).action)).toEqual(['unread', 'archive']);
    const adminCookie = await signIn(app, admin);
    for (const [url, payload] of [[`/api/mail/${m.id}/read`, { isRead: true }], [`/api/mail/${m.id}/archive`, undefined], [`/api/mail/${m.id}/log`, undefined], [`/api/mail/${m.id}/task`, undefined], [`/api/mail/${m.id}/create-lead`, undefined]] as const) {
      expect((await call('POST', url, adminCookie, payload)).statusCode).toBe(404);
    }
  });

  it('Log as activity writes "Email received" once; others see no subject; needs a lead', async () => {
    const { rep, admin, box, lead } = await setup();
    const loose = await synced(rep.id, box.id);
    const m = await synced(rep.id, box.id, { leadId: lead.id });
    const cookie = await signIn(app, rep);
    const noLead = await call('POST', `/api/mail/${loose.id}/log`, cookie);
    expect(noLead.statusCode).toBe(409);
    expect(noLead.json().error).toBe('no_lead');
    expect((await call('POST', `/api/mail/${m.id}/log`, cookie)).statusCode).toBe(201);
    const again = await call('POST', `/api/mail/${m.id}/log`, cookie);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_logged');
    expect(await prisma.leadActivity.findFirst({ where: { leadId: lead.id, activityType: 'email' } })).toMatchObject({ title: 'Email received · Proposal', relatedType: 'email_message', relatedId: m.id, byUserId: rep.id });
    const seenByAdmin = (await call('GET', `/api/leads/${lead.id}`, await signIn(app, admin))).json().activities.find((x: { activityType: string }) => x.activityType === 'email');
    expect(seenByAdmin).toMatchObject({ title: 'Email received', body: null });
  });

  it('link puts the message on a lead you can see (its contact and company); a hidden lead is 404', async () => {
    const { rep, box, lead, company, contact } = await setup();
    const hidden = await makeLead({ assignedToId: (await makeUser({ role: 'SALES_REPRESENTATIVE' })).id });
    const m = await synced(rep.id, box.id);
    const cookie = await signIn(app, rep);
    expect((await call('POST', `/api/mail/${m.id}/link`, cookie, { leadId: hidden.id })).statusCode).toBe(404);
    expect((await call('POST', `/api/mail/${m.id}/link`, cookie, { leadId: lead.id })).statusCode).toBe(200);
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ leadId: lead.id, contactId: contact.id, companyId: company.id });
  });

  it('create lead from an email links the sender’s company by domain, allocates and links the message', async () => {
    const { rep, box, company } = await setup();
    const m = await synced(rep.id, box.id, { fromAddress: 'luis@acme.com', fromName: 'Luis Vega', subject: 'Need a quote', bodyText: 'Please call' });
    const res = await call('POST', `/api/mail/${m.id}/create-lead`, await signIn(app, rep));
    expect(res.statusCode).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.json().leadId } });
    expect(lead).toMatchObject({ companyId: company.id, companyName: 'Acme', businessEmail: 'luis@acme.com', leadSource: 'Other', notes: 'Created from an email' });
    // The email's subject and text stay private: not in the lead, its history or the audit log.
    const audits = JSON.stringify(await prisma.auditLog.findMany());
    expect(audits).not.toContain('Need a quote');
    expect(audits).not.toContain('Please call');
    expect(lead.nextFollowUp).toBeInstanceOf(Date);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: m.id } })).leadId).toBe(lead.id);
  });

  it('create lead from an unknown sender names a new company from the domain', async () => {
    const { rep, box } = await setup();
    const m = await synced(rep.id, box.id, { fromAddress: 'sara@blue-river.io', fromName: 'Sara Lind' });
    const res = await call('POST', `/api/mail/${m.id}/create-lead`, await signIn(app, rep));
    expect(res.statusCode).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: res.json().leadId }, include: { company: true } });
    expect(lead.companyName).toBe('Blue River');
    expect(lead.company?.domain).toBe('blue-river.io');
  });

  it('Add follow-up task: a neutral "Reply to email" (the mail stays private), due tomorrow, yours, on the lead', async () => {
    const { rep, box, lead } = await setup();
    const m = await synced(rep.id, box.id, { leadId: lead.id });
    const res = await call('POST', `/api/mail/${m.id}/task`, await signIn(app, rep));
    expect(res.statusCode).toBe(201);
    const task = await prisma.task.findFirstOrThrow({ where: { leadId: lead.id, origin: 'manual' } });
    expect(task).toMatchObject({ title: 'Reply to email', assignedToId: rep.id });
    expect(task.dueDate.getTime() - Date.parse(`${todayIn(rep.timezone)}T00:00:00Z`)).toBe(86_400_000);
  });

  it('the sidebar count is your unread inbox; the lead Emails tab shows replies but not drafts', async () => {
    const { rep, admin, box, lead } = await setup();
    await synced(rep.id, box.id, { leadId: lead.id, subject: 'Reply' });
    await synced(rep.id, box.id, { leadId: lead.id, subject: 'Draft', folder: 'drafts', status: 'draft' });
    await synced(admin.id, null, { subject: 'Admin unread' });
    const cookie = await signIn(app, rep);
    expect((await call('GET', '/api/nav-counts', cookie)).json().mailUnread).toBe(1);
    expect((await call('GET', `/api/leads/${lead.id}/emails`, cookie)).json().items.map((i: { subject: string; status: string }) => [i.subject, i.status])).toEqual([['Reply', 'received']]);
  });
});

describe('project-tagged email (3B)', () => {
  it('compose with a project stores the tag; the list carries it and ?project= narrows to it', async () => {
    const { rep, box, lead, company } = await setup();
    const project = await makeProject({ companyId: company.id, leadId: lead.id, managerId: rep.id, name: 'Website' });
    const cookie = await signIn(app, rep);
    const res = await call('POST', '/api/mail', cookie, { to: 'ana@acme.com', subject: 'Kick-off', body: 'Hi', leadId: lead.id, projectId: project.id });
    expect(res.statusCode, res.body).toBe(201);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: res.json().id } })).projectId).toBe(project.id);
    // Without a lead, for the client.
    const res2 = await call('POST', '/api/mail', cookie, { to: 'ana@acme.com', subject: 'Plan', body: 'Hi', companyId: company.id, projectId: project.id });
    expect(res2.statusCode, res2.body).toBe(201);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: res2.json().id } })).projectId).toBe(project.id);
    await synced(rep.id, box.id, { folder: 'sent', status: 'sent', subject: 'Untagged' });
    const all = (await call('GET', '/api/mail?view=sent', cookie)).json();
    expect(all.total).toBe(3);
    const tagged = (await call('GET', `/api/mail?view=sent&project=${project.id}`, cookie)).json();
    expect(tagged.items.map((i: { subject: string }) => i.subject).sort()).toEqual(['Kick-off', 'Plan']);
    expect(tagged.items[0]).toMatchObject({ projectId: project.id, projectNumber: project.number });
    expect((await call('GET', `/api/mail/${res.json().id}`, cookie)).json()).toMatchObject({ projectId: project.id, projectNumber: project.number });
    expect(tagged.total).toBe(2);
  });

  it('a project you cannot see, or on another company, is 400 invalid_project and nothing is queued', async () => {
    const { rep, admin, lead, company } = await setup();
    const other = await makeCompany({ name: 'Other Co' });
    const otherLead = await makeLead({ companyId: other.id, assignedToId: admin.id });
    const hidden = await makeProject({ companyId: other.id, leadId: otherLead.id, managerId: admin.id });
    const mine = await makeProject({ companyId: company.id, leadId: lead.id, managerId: rep.id });
    const foreign = await makeProject({ companyId: other.id, managerId: rep.id }); // visible (manager), but another client
    const cookie = await signIn(app, rep);
    const send = (extra: Record<string, unknown>) => call('POST', '/api/mail', cookie, { to: 'ana@acme.com', subject: 's', body: 'b', ...extra });
    for (const res of [
      await send({ leadId: lead.id, projectId: hidden.id }),
      await send({ leadId: lead.id, projectId: foreign.id }),
      await send({ companyId: company.id, projectId: foreign.id }),
      await send({ projectId: mine.id }), // no lead and no client given
      await send({ leadId: lead.id, projectId: 999999 }),
    ]) {
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe('invalid_project');
    }
    expect(await prisma.emailMessage.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it('Review Focus 5: ?project= lists only your own mail even when someone else emailed the same project', async () => {
    const { rep, admin, box, lead, company } = await setup();
    const project = await makeProject({ companyId: company.id, leadId: lead.id, managerId: rep.id });
    const adminBox = await prisma.emailAccount.findFirstOrThrow({ where: { userId: admin.id } });
    await synced(admin.id, adminBox.id, { folder: 'sent', status: 'sent', subject: 'Admin on the project', projectId: project.id, companyId: company.id });
    await synced(rep.id, box.id, { folder: 'sent', status: 'sent', subject: 'Rep on the project', projectId: project.id, companyId: company.id });
    const repList = (await call('GET', `/api/mail?view=sent&project=${project.id}`, await signIn(app, rep))).json();
    expect(repList.items.map((i: { subject: string }) => i.subject)).toEqual(['Rep on the project']);
    expect(repList.total).toBe(1);
    const adminList = (await call('GET', `/api/mail?view=sent&project=${project.id}`, await signIn(app, admin))).json();
    expect(adminList.items.map((i: { subject: string }) => i.subject)).toEqual(['Admin on the project']);
    // A stranger who cannot see the project gets nothing, not someone else's tagged mail.
    const stranger = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    expect((await call('GET', `/api/mail?view=sent&project=${project.id}`, await signIn(app, stranger))).json()).toMatchObject({ items: [], total: 0 });
  });

  it('a tag on a project you can no longer see shows no project id or number', async () => {
    const { rep, box, company } = await setup();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const otherLead = await makeLead({ companyId: company.id, assignedToId: other.id });
    const project = await makeProject({ companyId: company.id, leadId: otherLead.id, managerId: other.id });
    const m = await synced(rep.id, box.id, { projectId: project.id });
    const cookie = await signIn(app, rep);
    const item = (await call('GET', '/api/mail?view=inbox', cookie)).json().items[0];
    expect(item).toMatchObject({ projectId: null, projectNumber: null });
    expect((await call('GET', `/api/mail/${m.id}`, cookie)).json()).toMatchObject({ projectId: null, projectNumber: null });
  });

  it('reply carries over the replied-to message’s project', async () => {
    const { rep, box, lead, company } = await setup();
    const project = await makeProject({ companyId: company.id, leadId: lead.id, managerId: rep.id });
    const original = await synced(rep.id, box.id, { leadId: lead.id, companyId: company.id, projectId: project.id });
    const res = await call('POST', `/api/mail/${original.id}/reply`, await signIn(app, rep), { cc: [], body: 'Thanks' });
    expect(res.statusCode).toBe(201);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: res.json().id } })).projectId).toBe(project.id);
  });

  it('meta lists the projects you can see (id, number, name, client)', async () => {
    const { rep, admin, lead, company } = await setup();
    const other = await makeCompany({ name: 'Other Co' });
    const otherLead = await makeLead({ companyId: other.id, assignedToId: admin.id });
    const mine = await makeProject({ companyId: company.id, leadId: lead.id, managerId: admin.id, name: 'Website' });
    await makeProject({ companyId: other.id, leadId: otherLead.id, managerId: admin.id, name: 'Hidden' });
    const managed = await makeProject({ companyId: other.id, managerId: rep.id, name: 'Managed' });
    const meta = (await call('GET', '/api/mail/meta', await signIn(app, rep))).json();
    expect(meta.projects).toEqual([
      { id: managed.id, number: managed.number, name: 'Managed', companyId: other.id },
      { id: mine.id, number: mine.number, name: 'Website', companyId: company.id },
    ]);
  });
});
