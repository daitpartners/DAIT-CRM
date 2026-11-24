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
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeProject, makeUser, signIn } from './factory';

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
  return { ...fakeGraph(), calls, async sendMail(account, msg) { calls.push({ account, msg }); if (error) throw error; } };
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

  it('formatted message (owner, 24 Nov 2026): the HTML is sanitised again on send and goes to Graph as HTML, with its text', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const html = '<p>Hola <b>Ana</b>:</p><ul><li>Uno</li></ul><p><a href="https://dait.example/x" onclick="steal()">Web</a>'
      + ' <a href="javascript:alert(1)">bad</a> <a href="tel:+34600">call</a></p><img src=x onerror="alert(1)"><script>alert(1)</script>';
    const res = await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt, { body: 'Hola Ana: Uno Web', bodyHtml: html }));
    expect(res.statusCode).toBe(201);
    const msg = await prisma.emailMessage.findFirstOrThrow();
    expect(msg.bodyHtml).toContain('<b>Ana</b>');
    expect(msg.bodyHtml).toContain('<li>Uno</li>');
    expect(msg.bodyHtml).toContain('href="https://dait.example/x"');
    for (const bad of ['onclick', 'javascript:', 'tel:', 'onerror', '<script', 'alert(']) expect(msg.bodyHtml).not.toContain(bad);
    // The plain text is derived on the server from the sanitised HTML.
    expect(msg.bodyText).toBe('Hola Ana:\n\nUno\n\nWeb bad call');

    const graph = recordingGraph();
    expect(await run(graph)).toBe(true);
    expect(graph.calls[0]!.msg.html).toBe(msg.bodyHtml);
    expect(graph.calls[0]!.msg.text).toBe(msg.bodyText);
  });

  it('size (I2): a formatted message over the cap is refused as message_too_long, never cut; HTML needs no plain body (M5)', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const cookie = await signIn(app, rep);
    const big = '<p>' + 'x'.repeat(200_001) + '</p><p>tail</p>';
    const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(lead.updatedAt, { body: '', bodyHtml: big }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'message_too_long' });
    expect(await prisma.emailMessage.count()).toBe(0);
    const ok = await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(lead.updatedAt, { body: '', bodyHtml: '<p>Hola <b>Ana</b></p>' }));
    expect(ok.statusCode).toBe(201);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ bodyText: 'Hola Ana', bodyHtml: '<p>Hola <b>Ana</b></p>' });
  });

  it('an empty message (no text, HTML with nothing left) is a validation error on body; checks run before sanitising (M2)', async () => {
    const { rep, lead } = await setup();
    const cookie = await signIn(app, rep);
    // No mailbox: refused before any sanitising.
    expect((await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(lead.updatedAt, { bodyHtml: '<p>x</p>' }))).json()).toEqual({ error: 'no_mailbox' });
    await personal(rep.id, 'seba@daitpartners.com');
    const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(lead.updatedAt, { body: '', bodyHtml: '<script>x()</script>' }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation', issues: [{ path: ['body'] }] });
    expect((await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(lead.updatedAt, { body: '' }))).statusCode).toBe(400);
  });

  it('a plain message is unchanged: its text as simple HTML', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt, { bodyHtml: null }));
    const msg = await prisma.emailMessage.findFirstOrThrow();
    expect(msg).toMatchObject({ bodyText: 'Hola Ana:\n\nSaludos', bodyHtml: '<div>Hola Ana:<br><br>Saludos</div>' });
    const graph = recordingGraph();
    await run(graph);
    expect(graph.calls[0]!.msg).toMatchObject({ html: '<div>Hola Ana:<br><br>Saludos</div>', text: 'Hola Ana:\n\nSaludos' });
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

  it('a final failure removes the "Email sent" history line (the sender sees Failed in the Emails tab)', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    const job = await prisma.job.findFirstOrThrow();
    await prisma.job.update({ where: { id: job.id }, data: { attempts: job.maxAttempts - 1 } });
    await run(recordingGraph(new GraphError('unavailable', 503)));
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed' });
    expect(await prisma.leadActivity.count({ where: { activityType: 'email' } })).toBe(0);
  });

  it('a revoked send does not turn a since-disconnected mailbox into an error', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    const graph: GraphClient = {
      ...fakeGraph(),
      async sendMail() {
        // The user disconnects while the send is in flight; then Microsoft answers 401.
        await prisma.emailAccount.update({ where: { id: box.id }, data: { status: 'disconnected', refreshTokenEnc: '' } });
        throw new GraphError('InvalidAuthenticationToken', 401);
      },
    };
    await run(graph);
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: box.id } })).status).toBe('disconnected');
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed' });
  });

  it('an interrupted send is never handed to Microsoft twice', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    // A previous attempt claimed the message and then died before recording the result.
    await prisma.emailMessage.updateMany({ data: { status: 'sending' } });
    const graph = recordingGraph();
    await run(graph);
    expect(graph.calls).toHaveLength(0);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed', lastError: 'interrupted_may_have_sent' });
  });

  it('a queued message never goes out through a mailbox that now belongs to someone else', async () => {
    const { rep, lead } = await setup();
    const box = await personal(rep.id, 'seba@daitpartners.com');
    await call('POST', `/api/leads/${lead.id}/emails`, await signIn(app, rep), body(lead.updatedAt));
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    await prisma.emailAccount.update({ where: { id: box.id }, data: { userId: other.id } });
    const graph = recordingGraph();
    await run(graph);
    expect(graph.calls).toHaveLength(0);
    expect(await prisma.emailMessage.findFirstOrThrow()).toMatchObject({ status: 'failed', lastError: 'mailbox_not_connected' });
  });

  it('sending to a New or Not Contacted lead moves it to Contacted (prototype); later statuses are left alone', async () => {
    const { rep, lead } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const cookie = await signIn(app, rep);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'New' } });
    let fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect((await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(fresh.updatedAt))).statusCode).toBe(201);
    fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.status).toBe('Contacted');
    const change = await prisma.leadActivity.findFirstOrThrow({ where: { activityType: 'status' } });
    expect(change).toMatchObject({ statusFrom: 'New', statusTo: 'Contacted', body: 'Email sent' });

    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'Interested' } });
    fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(fresh.updatedAt));
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe('Interested');
  });
});

describe('project tag on lead page email (3B)', () => {
  it('stores the project; one you cannot see or on another company is 400 invalid_project', async () => {
    const { rep, admin, lead, company } = await setup();
    await personal(rep.id, 'seba@daitpartners.com');
    const project = await makeProject({ companyId: company.id, leadId: lead.id, managerId: rep.id });
    const other = await makeCompany({ name: 'Otra' });
    const foreign = await makeProject({ companyId: other.id, managerId: rep.id });
    const hidden = await makeProject({ companyId: other.id, leadId: (await makeLead({ companyId: other.id, assignedToId: admin.id })).id, managerId: admin.id });
    const cookie = await signIn(app, rep);
    for (const bad of [foreign.id, hidden.id]) {
      const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
      const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(fresh.updatedAt, { projectId: bad }));
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe('invalid_project');
    }
    expect(await prisma.emailMessage.count()).toBe(0);
    const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const res = await call('POST', `/api/leads/${lead.id}/emails`, cookie, body(fresh.updatedAt, { projectId: project.id }));
    expect(res.statusCode, res.body).toBe(201);
    expect((await prisma.emailMessage.findFirstOrThrow()).projectId).toBe(project.id);
  });
});
