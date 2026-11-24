import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
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

async function setup() {
  const seba = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Sebastian Passalacqua' });
  const deepak = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  const neha = await makeUser({ role: 'MANAGER', name: 'Neha Kapoor' });
  const box = await prisma.emailAccount.create({ data: { address: 'seba@daitpartners.com', provider: 'microsoft', kind: 'personal', userId: seba.id, refreshTokenEnc: encrypt('rt'), status: 'connected' } });
  const company = await makeCompany({ name: 'Andino', country: 'Chile' });
  const ana = await makeContact({ companyId: company.id, firstName: 'Ana', lastName: 'Torres', businessEmail: 'ana@andino.cl' });
  const good = await makeLead({ companyId: company.id, contactId: ana.id, assignedToId: seba.id, companyName: 'Andino' });
  const skip = await makeLead({ companyId: null, contactId: null, assignedToId: seba.id, businessEmail: null });
  const tpl = await prisma.emailTemplate.create({ data: { name: 'Intro ES', language: 'es', subject: 'Hola {first_name}', body: 'Hola {first_name} de {company}.\n{me}', sourceType: 'manual' } });
  return { seba, deepak, neha, box, company, ana, good, skip, tpl };
}

const create = (tplId: number, leadIds: number[], extra: Record<string, unknown> = {}) => ({
  leadIds, name: 'Chile · Nov', templateId: tplId, cc: [], bcc: ['deepak@daitpartners.com'], startAt: null, intervalMinutes: 3,
  workingHoursOnly: true, unsubscribeLine: true, lawfulBasis: 'Legitimate interest (B2B outreach relevant to their role)', ...extra,
});

describe('Mailer campaigns (release 2C)', () => {
  it('check lists who will be emailed, their local time zone, and the sender mailbox', async () => {
    const { seba, good, skip } = await setup();
    const res = await call('POST', '/api/mailer/check', await signIn(app, seba), { leadIds: [good.id, skip.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mailbox: { address: 'seba@daitpartners.com' },
      rows: [{ leadId: good.id, to: 'ana@andino.cl', block: null, zones: ['America/Santiago'], source: 'country' }, { leadId: skip.id, block: 'No email address' }],
    });
  });

  it('queues a campaign: the template as it was, recipients Queued or Skipped, a notification', async () => {
    const { seba, good, skip, tpl, box } = await setup();
    const res = await call('POST', '/api/mailer', await signIn(app, seba), create(tpl.id, [good.id, skip.id]));
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({
      number: 'MC-001', name: 'Chile · Nov', status: 'Sending', templateName: 'Intro ES', subject: 'Hola {first_name}', senderAddress: box.address,
      bcc: ['deepak@daitpartners.com'], intervalMinutes: 3, workingHoursOnly: true, stats: { total: 2, queued: 1, skipped: 1, sent: 0 },
    });
    expect(c.recipients.map((r: { status: string; error: string | null }) => [r.status, r.error])).toEqual([['Queued', null], ['Skipped', 'No email address']]);
    const row = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.nextSendAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // The template's language stays with the campaign (for the opt-out line), even if the template is deleted.
    expect(row.language).toBe('es');
    expect(await prisma.notification.findFirst({ where: { userId: seba.id } })).toMatchObject({ text: 'Mailer queued · Chile · Nov', detail: '1 email · sending now', link: `/mailer/${c.id}` });
  });

  it('a formatted template: the campaign keeps its HTML as queued (plain templates keep none)', async () => {
    const { seba, good, tpl } = await setup();
    const cookie = await signIn(app, seba);
    const plain = await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id]));
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: plain.json().id } })).bodyHtml).toBeNull();
    await prisma.emailTemplate.update({ where: { id: tpl.id }, data: { bodyHtml: '<p>Hola <b>{first_name}</b></p>' } });
    const res = await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id]));
    expect(res.statusCode).toBe(201);
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: res.json().id } })).bodyHtml).toBe('<p>Hola <b>{first_name}</b></p>');
  });

  it('a later start is Scheduled; the rules are checked', async () => {
    const { seba, good, skip, tpl } = await setup();
    const cookie = await signIn(app, seba);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id], { startAt: later }))).json().status).toBe('Scheduled');
    const none = await call('POST', '/api/mailer', cookie, create(tpl.id, [skip.id]));
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('nothing_to_send');
    expect((await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id], { lawfulBasis: '' }))).statusCode).toBe(400);
    expect((await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id], { cc: ['nope'] }))).statusCode).toBe(400);
    expect((await call('POST', '/api/mailer', cookie, create(999999, [good.id]))).statusCode).toBe(404);
  });

  it('without a connected mailbox: 409 no_mailbox', async () => {
    const { neha, good, tpl } = await setup();
    const res = await call('POST', '/api/mailer', await signIn(app, neha), create(tpl.id, [good.id]));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_mailbox');
  });

  it('each user sees their own campaigns; administrators see everyone’s (list, progress, recipients) but cannot act on them', async () => {
    const { seba, deepak, neha, good, tpl } = await setup();
    const id = (await call('POST', '/api/mailer', await signIn(app, seba), create(tpl.id, [good.id]))).json().id;
    const list = async (u: { email: string }) => (await call('GET', '/api/mailer', await signIn(app, u))).json().items.map((c: { id: number }) => c.id);
    expect(await list(seba)).toEqual([id]);
    expect(await list(deepak)).toEqual([id]);
    expect(await list(neha)).toEqual([]);
    const adminCookie = await signIn(app, deepak);
    expect((await call('GET', `/api/mailer/${id}`, adminCookie)).json().recipients).toHaveLength(1);
    expect((await call('GET', `/api/mailer/${id}`, await signIn(app, neha))).statusCode).toBe(404);
    expect((await call('POST', `/api/mailer/${id}/pause`, adminCookie)).statusCode).toBe(403);
    expect((await call('POST', `/api/mailer/${id}/pause`, await signIn(app, neha))).statusCode).toBe(404);
  });

  it('pause, resume (needs the mailbox), start now and cancel remaining', async () => {
    const { seba, good, tpl, box } = await setup();
    const cookie = await signIn(app, seba);
    const id = (await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id], { startAt: new Date(Date.now() + 86_400_000).toISOString() }))).json().id;
    expect((await call('POST', `/api/mailer/${id}/start`, cookie)).json().status).toBe('Sending');
    const paused = (await call('POST', `/api/mailer/${id}/pause`, cookie)).json();
    expect(paused).toMatchObject({ status: 'Paused', pauseReason: 'Paused by Sebastian Passalacqua' });
    await prisma.emailAccount.update({ where: { id: box.id }, data: { status: 'disconnected' } });
    const refused = await call('POST', `/api/mailer/${id}/resume`, cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('no_mailbox');
    await prisma.emailAccount.update({ where: { id: box.id }, data: { status: 'connected' } });
    expect((await call('POST', `/api/mailer/${id}/resume`, cookie)).json()).toMatchObject({ status: 'Sending', pauseReason: null });
    const cancelled = (await call('POST', `/api/mailer/${id}/cancel`, cookie)).json();
    expect(cancelled.status).toBe('Cancelled');
    expect(cancelled.recipients[0]).toMatchObject({ status: 'Skipped', error: 'Campaign cancelled' });
    expect((await call('POST', `/api/mailer/${id}/resume`, cookie)).statusCode).toBe(409);
  });

  it('list returns the same stats without loading recipients', async () => {
    const { seba, deepak, company, good, skip, tpl } = await setup();
    const cookie = await signIn(app, seba);
    const lead = async (first: string, email: string) => {
      const c = await makeContact({ companyId: company.id, firstName: first, lastName: 'X', businessEmail: email });
      return makeLead({ companyId: company.id, contactId: c.id, assignedToId: seba.id, companyName: 'Andino' });
    };
    const [late, early, failed, queued] = [good, await lead('Bea', 'bea@andino.cl'), await lead('Cris', 'cris@andino.cl'), await lead('Dani', 'dani@andino.cl')];
    const id = (await call('POST', '/api/mailer', cookie, create(tpl.id, [late.id, early.id, failed.id, skip.id, queued.id]))).json().id;
    // A second campaign so per-campaign counts cannot bleed into each other.
    const other = (await call('POST', '/api/mailer', cookie, create(tpl.id, [queued.id]))).json().id;
    const sentAt = new Date(Date.now() - 3600_000);
    const set = (leadId: number, data: Record<string, unknown>) => prisma.emailCampaignRecipient.updateMany({ where: { campaignId: id, leadId }, data });
    await set(late.id, { status: 'Sent', sentAt });
    await set(early.id, { status: 'Sent', sentAt });
    await set(failed.id, { status: 'Failed', error: 'Graph 500' });
    const msg = (userId: number, leadId: number, occurredAt: Date) =>
      prisma.emailMessage.create({ data: { userId, leadId, folder: 'inbox', status: 'received', fromAddress: 'x@andino.cl', subject: 'Re', occurredAt } });
    await msg(seba.id, late.id, new Date()); // replied after the email: counts
    await msg(seba.id, early.id, new Date(sentAt.getTime() - 60_000)); // before the email: does not
    await msg(deepak.id, early.id, new Date()); // in someone else's mail: does not
    const items = (await call('GET', '/api/mailer', cookie)).json().items as { id: number; stats: unknown; next: string | null }[];
    const detail = (await call('GET', `/api/mailer/${id}`, cookie)).json();
    const item = items.find((c) => c.id === id)!;
    expect(detail.stats).toEqual({ total: 5, queued: 1, sending: 0, sent: 2, failed: 1, skipped: 1, toSend: 4, replied: 1 });
    expect(item.stats).toEqual(detail.stats);
    expect(item.next).toBe(detail.next);
    expect(item.next).toBe(detail.recipients.find((r: { status: string }) => r.status === 'Queued').name);
    expect(item.next).toMatch(/^Dani/);
    const second = items.find((c) => c.id === other)!;
    expect(second.stats).toEqual({ total: 1, queued: 1, sending: 0, sent: 0, failed: 0, skipped: 0, toSend: 1, replied: 0 });
  });

  it('detail shows the message id once synced', async () => {
    const { seba, company, good, tpl } = await setup();
    const cookie = await signIn(app, seba);
    const c2 = await makeContact({ companyId: company.id, firstName: 'Bea', lastName: 'X', businessEmail: 'bea@andino.cl' });
    const second = await makeLead({ companyId: company.id, contactId: c2.id, assignedToId: seba.id, companyName: 'Andino' });
    const id = (await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id, second.id]))).json().id;
    const m = await prisma.emailMessage.create({ data: { userId: seba.id, leadId: good.id, folder: 'sent', status: 'sent', fromAddress: 'seba@daitpartners.com', subject: 'Hola', messageId: '<abc@x>', campaignId: id } });
    await prisma.emailCampaignRecipient.updateMany({ where: { campaignId: id, leadId: good.id }, data: { status: 'Sent', sentAt: new Date(), emailMessageId: m.id } });
    const recipients = (await call('GET', `/api/mailer/${id}`, cookie)).json().recipients;
    expect(recipients.map((r: { status: string; messageId: string | null }) => [r.status, r.messageId])).toEqual([['Sent', '<abc@x>'], ['Queued', null]]);
  });

  it('the sidebar shows your live campaigns', async () => {
    const { seba, good, tpl } = await setup();
    const cookie = await signIn(app, seba);
    await call('POST', '/api/mailer', cookie, create(tpl.id, [good.id]));
    expect((await call('GET', '/api/nav-counts', cookie)).json().mailerLive).toBe(1);
  });
});
