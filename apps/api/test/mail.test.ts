import type { FastifyInstance } from 'fastify';
import type { EmailAccount, EmailMessage, Job } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { runOnce } from '../src/jobs/runner';
import { sendUserEmailHandler } from '../src/jobs/handlers/sendUserEmail';
import { mailActionHandler } from '../src/jobs/handlers/mailAction';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp();
});
afterAll(() => app.close());
beforeEach(async () => {
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
