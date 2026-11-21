import type { FastifyInstance } from 'fastify';
import type { EmailAccount } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import type { GraphClient, MailMessage } from '../src/graph/client';
import { GraphError } from '../src/graph/client';
import { runOnce } from '../src/jobs/runner';
import { sendUserEmailHandler } from '../src/jobs/handlers/sendUserEmail';
import { todayIn } from '../src/leads/dates';
import { resetDb, seedLookups } from './helpers';
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

async function personal(userId: number, address: string, status = 'connected') {
  return prisma.emailAccount.create({
    data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status },
  });
}

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Sebastian Passalacqua' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const company = await makeCompany({ name: 'Grupo Andino' });
  const contact = await makeContact({ companyId: company.id, firstName: 'Ana', lastName: 'Torres', businessEmail: 'ana@andino.cl' });
  const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: rep.id, status: 'Contacted' });
  return { rep, admin, company, contact, lead };
}

const body = (updatedAt: Date, extra: Record<string, unknown> = {}) => ({
  to: 'ana@andino.cl', cc: ['carlos@daitpartners.com'], subject: '¿Una llamada esta semana?', body: 'Hola Ana:\n\nSaludos', updatedAt: updatedAt.toISOString(), ...extra,
});

function recordingGraph(error?: Error): GraphClient & { calls: { account: EmailAccount; msg: MailMessage }[] } {
  const calls: { account: EmailAccount; msg: MailMessage }[] = [];
  return { calls, async sendMail(account, msg) { calls.push({ account, msg }); if (error) throw error; } };
}
const run = (graph: GraphClient) => runOnce({ types: ['send_user_email'], handlers: { send_user_email: sendUserEmailHandler }, graph });

describe('sending email from a lead (release 2B-1)', () => {
  it('without a connected personal mailbox: 409 no_mailbox and nothing queued', async () => {
    const { rep, lead } = await setup();
    const res = await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_mailbox');
    expect(await prisma.emailMessage.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it('queues the message from the user\'s mailbox, logs the activity and sets the follow-up', async () => {
    const { rep, lead, contact, company } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    const res = await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt, { followUpDays: 3 }));
    expect(res.statusCode).toBe(201);
    const msg = await prisma.emailMessage.findFirstOrThrow();
    expect(msg).toMatchObject({
      userId: rep.id, accountId: box.id, leadId: lead.id, contactId: contact.id, companyId: company.id, folder: 'sent', status: 'queued',
      fromAddress: 'seba@daitpartners.com', subject: '¿Una llamada esta semana?', bodyText: 'Hola Ana:\n\nSaludos',
    });
    expect(msg.toAddresses).toEqual(['ana@andino.cl']);
    expect(msg.ccAddresses).toEqual(['carlos@daitpartners.com']);
    const job = await prisma.job.findFirstOrThrow();
    expect(job).toMatchObject({ type: 'send_user_email', status: 'queued' });
    expect(job.payload).toEqual({ emailMessageId: msg.id });
    const act = await prisma.leadActivity.findFirstOrThrow({ where: { activityType: 'email' } });
    expect(act).toMatchObject({ title: 'Email sent · ¿Una llamada esta semana?', relatedType: 'email_message', relatedId: msg.id, byUserId: rep.id });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const today = todayIn('Europe/London');
    const expected = new Date(new Date(`${today}T00:00:00Z`).getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    expect(after.nextFollowUp?.toISOString().slice(0, 10)).toBe(expected);
  });

  it('a closed lead can be emailed but gets no follow-up', async () => {
    const { rep, lead } = await setup();
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'Lost', nextFollowUp: null } });
    const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    await personal(rep.id, 'seba@daitpartners.com');
    const res = await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(fresh.updatedAt, { followUpDays: 3 }));
    expect(res.statusCode).toBe(201);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).nextFollowUp).toBeNull();
  });

  it('privacy: only the sender lists the message; others see "Email sent" without the subject', async () => {
    const { rep, admin, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const repCookie = await signIn(app, rep);
    await call('POST', `/api/leads/${lead.id}/emails`, repCookie, body(lead.updatedAt));
    const adminCookie = await signIn(app, admin);

    expect((await call('GET', `/api/leads/${lead.id}/emails`, repCookie)).json().items).toHaveLength(1);
    expect((await call('GET', `/api/leads/${lead.id}/emails`, adminCookie)).json().items).toEqual([]);

    const titles = async (cookie: string) =>
      ((await call('GET', `/api/leads/${lead.id}`, cookie)).json().activities as { activityType: string; title: string; body: string | null }[])
        .filter((a) => a.activityType === 'email');
    expect(await titles(repCookie)).toMatchObject([{ title: 'Email sent · ¿Una llamada esta semana?' }]);
    expect(await titles(adminCookie)).toEqual([expect.objectContaining({ title: 'Email sent', body: null })]);
  });

  it('the worker sends through the user\'s mailbox and marks the message sent', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    const graph = recordingGraph();
    expect(await run(graph)).toBe(true);
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]!.account.id).toBe(box.id);
    expect(graph.calls[0]!.msg).toMatchObject({ to: ['ana@andino.cl'], cc: ['carlos@daitpartners.com'], subject: '¿Una llamada esta semana?', text: 'Hola Ana:\n\nSaludos' });
    expect(graph.calls[0]!.msg.html).toContain('Hola Ana:<br><br>Saludos');
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'sent', lastError: null });
  });

  it('a temporary failure retries; the last failure marks the message failed', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    await run(recordingGraph(new GraphError('unavailable', 503)));
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'queued' });
    const job = await prisma.job.findFirstOrThrow();
    await prisma.job.update({ where: { id: job.id }, data: { attempts: job.maxAttempts - 1, runAt: new Date() } });
    await run(recordingGraph(new GraphError('unavailable', 503)));
    const failed = await prisma.emailMessage.findFirstOrThrow();
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toContain('unavailable');
  });

  it('a revoked mailbox marks the message failed at once and the mailbox in error', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    await run(recordingGraph(new GraphError('InvalidAuthenticationToken', 401)));
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed' });
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: box.id } })).status).toBe('error');
    expect((await prisma.job.findFirstOrThrow()).status).toBe('done');
  });
});
