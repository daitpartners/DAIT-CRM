import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Job } from '@prisma/client';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { GraphError, type MailMessage } from '../src/graph/client';
import { campaignStepHandler } from '../src/jobs/handlers/campaignStep';
import { scheduleCampaigns } from '../src/mailer/schedule';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser } from './factory';

beforeEach(async () => {
  await resetDb();
  await seedLookups();
});
afterEach(() => vi.useRealTimers());

/** Wednesday 25 Nov 2026, 15:00 UTC = 12:00 Santiago (working hours there). */
const WED_NOON_SANTIAGO = new Date('2026-11-25T15:00:00Z');
const at = (d: Date) => vi.useFakeTimers({ now: d, toFake: ['Date'] });

async function campaign(opts: { leads?: number; workingHoursOnly?: boolean; status?: string; interval?: number; tz?: string[] } = {}) {
  const sender = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Sebastian Passalacqua' });
  await prisma.user.update({ where: { id: sender.id }, data: { timezone: 'America/Santiago' } });
  const account = await prisma.emailAccount.create({ data: { address: 'seba@daitpartners.com', provider: 'microsoft', kind: 'personal', userId: sender.id, refreshTokenEnc: encrypt('rt'), status: 'connected' } });
  const company = await makeCompany({ name: 'Andino', country: 'Chile' });
  const recipients = [];
  for (let i = 0; i < (opts.leads ?? 2); i++) {
    const contact = await makeContact({ companyId: company.id, firstName: `Ana${i}`, lastName: 'Torres', businessEmail: `ana${i}@andino.cl` });
    const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: sender.id, companyName: 'Andino', status: 'New' });
    recipients.push({ leadId: lead.id, contactId: contact.id, toAddress: `ana${i}@andino.cl`, name: `Ana${i} Torres`, company: 'Andino', timezones: opts.tz ?? ['America/Santiago'], timezoneSource: 'country', status: 'Queued', position: i });
  }
  const c = await prisma.emailCampaign.create({
    data: {
      name: 'Chile', templateName: 'Intro', subject: 'Hola {first_name}', body: 'Hola {first_name} de {company}.\n{me} · {lead_id}', senderId: sender.id, accountId: account.id,
      senderAddress: account.address, cc: ['cc@daitpartners.com'], bcc: ['deepak@daitpartners.com'], intervalMinutes: opts.interval ?? 3, workingHoursOnly: opts.workingHoursOnly ?? false,
      unsubscribeLine: true, lawfulBasis: 'Consent (they asked to be contacted)', status: opts.status ?? 'Sending', nextSendAt: new Date(0),
      createdAt: new Date(Date.now() - 3600_000), recipients: { create: recipients },
    },
    include: { recipients: { orderBy: { position: 'asc' } } },
  });
  return { sender, account, c };
}

function recording(error?: Error) {
  const sent: MailMessage[] = [];
  return { sent, graph: fakeGraph({ async sendMail(_a, m) { if (error) throw error; sent.push(m); } }) };
}
const job = (campaignId: number) => ({ id: 1, type: 'campaign_step', payload: { campaignId }, attempts: 0, maxAttempts: 1 }) as unknown as Job;
const recipients = (campaignId: number) => prisma.emailCampaignRecipient.findMany({ where: { campaignId }, orderBy: { position: 'asc' } });

describe('Mailer step: one email per step from the sender’s mailbox (release 2C)', () => {
  test('sends the next recipient, personalised, with Cc/Bcc and the unsubscribe line; files it on the lead', async () => {
    at(WED_NOON_SANTIAGO);
    const { sender, c } = await campaign();
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(1);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: c.recipients[0]!.leadId! } });
    expect(sent[0]).toMatchObject({ to: ['ana0@andino.cl'], cc: ['cc@daitpartners.com'], bcc: ['deepak@daitpartners.com'], subject: 'Hola Ana0' });
    expect(sent[0]!.text).toBe(`Hola Ana0 de Andino.\nSebastian Passalacqua · ${lead.number}\n\n—\nIf you would prefer not to receive emails from DAIT Partners, reply with "unsubscribe" and we will not contact you again.`);
    const rs = await recipients(c.id);
    expect(rs.map((r) => r.status)).toEqual(['Sent', 'Queued']);
    const msg = await prisma.emailMessage.findUniqueOrThrow({ where: { id: rs[0]!.emailMessageId! } });
    expect(msg).toMatchObject({ userId: sender.id, campaignId: c.id, folder: 'sent', status: 'sent', source: 'crm', bccAddresses: ['deepak@daitpartners.com'], leadId: lead.id });
    expect(lead.status).toBe('Contacted');
    expect(await prisma.leadActivity.findFirst({ where: { leadId: lead.id, activityType: 'email' } })).toMatchObject({ title: 'Email sent · Hola Ana0', relatedType: 'email_message', byUserId: sender.id });
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.nextSendAt!.getTime()).toBe(WED_NOON_SANTIAGO.getTime() + 3 * 60_000);
    // The next step is queued for then.
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'campaign_step', status: 'queued' } })).runAt.getTime()).toBe(after.nextSendAt!.getTime());
  });

  test('run as a real job, it queues its own next step (its running job does not block that)', async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign();
    const running = await prisma.job.create({ data: { type: 'campaign_step', payload: { campaignId: c.id }, status: 'running', lockedAt: new Date(), runAt: new Date() } });
    const { graph } = recording();
    await campaignStepHandler(running, { graph });
    expect(await prisma.job.count({ where: { type: 'campaign_step', status: 'queued' } })).toBe(1);
  });

  test('not yet due, or not Sending: nothing happens', async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign();
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { nextSendAt: new Date(WED_NOON_SANTIAGO.getTime() + 60_000) } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { nextSendAt: new Date(0), status: 'Paused' } });
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(0);
  });

  test('a lead that became unmailable or replied is skipped without spending the interval', async () => {
    at(WED_NOON_SANTIAGO);
    const { sender, c } = await campaign({ leads: 3 });
    await prisma.lead.update({ where: { id: c.recipients[0]!.leadId! }, data: { doNotEmail: true } });
    await prisma.emailMessage.create({ data: { userId: sender.id, leadId: c.recipients[1]!.leadId, folder: 'inbox', status: 'received', fromAddress: 'ana1@andino.cl', subject: 'Re', occurredAt: new Date() } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent.map((m) => m.to[0])).toEqual(['ana2@andino.cl']);
    expect((await recipients(c.id)).map((r) => [r.status, r.error])).toEqual([
      ['Skipped', 'Marked do not email'], ['Skipped', 'Replied before this email was due'], ['Sent', null],
    ]);
  });

  test("outside the client's working hours it waits; a recipient inside their hours goes first", async () => {
    // 15:00 UTC Wednesday: 12:00 Santiago (open), 00:00 Tokyo next day (closed).
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign({ workingHoursOnly: true });
    await prisma.emailCampaignRecipient.update({ where: { id: c.recipients[0]!.id }, data: { timezones: ['Asia/Tokyo'] } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent.map((m) => m.to[0])).toEqual(['ana1@andino.cl']);
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { nextSendAt: new Date(0) } });
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(1);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ status: 'Sending', waitReason: 'working_hours' });
    // It looks again when Tokyo opens: Thursday 09:00 JST = Thursday 00:00 UTC.
    expect(after.nextSendAt!.toISOString()).toBe('2026-11-26T00:00:00.000Z');
  });

  test('the daily limit of 200 per mailbox makes the campaign wait until the sender’s next day', async () => {
    at(WED_NOON_SANTIAGO);
    const { sender, c } = await campaign();
    const other = await prisma.emailCampaign.create({ data: { name: 'Other', templateName: 'x', subject: 's', body: 'b', senderId: sender.id, senderAddress: 'seba@daitpartners.com', intervalMinutes: 1, lawfulBasis: 'x', status: 'Completed' } });
    await prisma.emailMessage.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({ userId: sender.id, campaignId: other.id, folder: 'sent', status: 'sent', fromAddress: 'seba@daitpartners.com', subject: `m${i}`, occurredAt: new Date(WED_NOON_SANTIAGO.getTime() - 3600_000) })),
    });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(0);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.waitReason).toBe('daily_limit');
    // Next midnight in Santiago (UTC-3 in November) = 26 Nov 03:00 UTC.
    expect(after.nextSendAt!.toISOString()).toBe('2026-11-26T03:00:00.000Z');
  });

  test("a lead whose contact changed since queueing is skipped, not emailed at the old address; an unsubscribed queued contact too", async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign({ leads: 3 });
    const lead0 = await prisma.lead.findUniqueOrThrow({ where: { id: c.recipients[0]!.leadId! } });
    const maria = await makeContact({ companyId: lead0.companyId!, firstName: 'Maria', businessEmail: 'maria@andino.cl' });
    await prisma.lead.update({ where: { id: lead0.id }, data: { contactId: maria.id } });
    await prisma.contact.update({ where: { id: c.recipients[1]!.contactId! }, data: { unsubscribedAt: new Date() } });
    await prisma.lead.update({ where: { id: c.recipients[1]!.leadId! }, data: { contactId: null, businessEmail: 'ana1@andino.cl' } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent.map((m) => m.to[0])).toEqual(['ana2@andino.cl']);
    expect((await recipients(c.id)).map((r) => [r.status, r.error])).toEqual([
      ['Skipped', 'Email address changed since the campaign was queued'], ['Skipped', 'Unsubscribed'], ['Sent', null],
    ]);
  });

  test('a campaign cancelled while its email was in flight stays cancelled when the mailbox turns out revoked', async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign({ leads: 1 });
    const graph = fakeGraph({
      async sendMail() {
        await prisma.emailCampaign.update({ where: { id: c.id }, data: { status: 'Cancelled', completedAt: new Date() } });
        throw new GraphError('graph_send_failed status=401', 401);
      },
    });
    await campaignStepHandler(job(c.id), { graph });
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('Cancelled');
    expect((await recipients(c.id))[0]).toMatchObject({ status: 'Skipped', error: 'Campaign cancelled' });
  });

  test('a revoked mailbox pauses the campaign and puts the mailbox in error; the recipient stays queued', async () => {
    at(WED_NOON_SANTIAGO);
    const { sender, account, c } = await campaign();
    const { graph } = recording(new GraphError('graph_send_failed status=401', 401));
    await campaignStepHandler(job(c.id), { graph });
    expect(await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'Paused', pauseReason: 'Mailbox needs reconnecting' });
    expect((await prisma.emailAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe('error');
    expect((await recipients(c.id))[0]!.status).toBe('Queued');
    expect(await prisma.notification.findFirst({ where: { userId: sender.id, text: 'Mailer paused · Chile' } })).not.toBeNull();
  });

  test('a disconnected mailbox pauses it before sending', async () => {
    at(WED_NOON_SANTIAGO);
    const { account, c } = await campaign();
    await prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'disconnected' } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(0);
    expect(await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'Paused', pauseReason: 'Mailbox disconnected' });
  });

  test('any other failure fails that recipient with the reason and moves on', async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign();
    const { graph } = recording(new GraphError('graph_send_failed status=400 code=ErrorInvalidRecipients', 400));
    await campaignStepHandler(job(c.id), { graph });
    expect((await recipients(c.id)).map((r) => [r.status, r.error])).toEqual([['Failed', 'graph_send_failed status=400 code=ErrorInvalidRecipients'], ['Queued', null]]);
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('Sending');
  });

  test('a recipient left Sending by an interrupted step is failed, never sent twice', async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign({ leads: 1 });
    await prisma.emailCampaignRecipient.update({ where: { id: c.recipients[0]!.id }, data: { status: 'Sending' } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(0);
    expect((await recipients(c.id))[0]).toMatchObject({ status: 'Failed', error: 'Interrupted — it may have been sent' });
  });

  test('the last send completes the campaign and tells the sender', async () => {
    at(WED_NOON_SANTIAGO);
    const { sender, c } = await campaign({ leads: 1 });
    const { graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('Completed');
    expect(await prisma.notification.findFirst({ where: { userId: sender.id, text: 'Mailer finished · Chile' } })).toMatchObject({ detail: '1 sent · 0 skipped · 0 failed' });
  });

  test('over a weekend the next step waits for Monday', async () => {
    // Saturday 28 Nov 2026 12:00 UTC: Chicago and Kolkata both closed; Kolkata opens first, Monday 09:00 IST = 03:30 UTC.
    const SAT_NOON = new Date('2026-11-28T12:00:00Z');
    at(SAT_NOON);
    const { c } = await campaign({ workingHoursOnly: true });
    await prisma.emailCampaignRecipient.update({ where: { id: c.recipients[0]!.id }, data: { timezones: ['America/Chicago'] } });
    await prisma.emailCampaignRecipient.update({ where: { id: c.recipients[1]!.id }, data: { timezones: ['Asia/Kolkata'] } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(0);
    const after = await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.waitReason).toBe('working_hours');
    expect(after.nextSendAt!.toISOString()).toBe('2026-11-30T03:30:00.000Z');
    expect(after.nextSendAt!.getTime()).toBeGreaterThan(SAT_NOON.getTime());
    expect((await prisma.job.findFirstOrThrow({ where: { type: 'campaign_step', status: 'queued' } })).runAt.toISOString()).toBe('2026-11-30T03:30:00.000Z');
  });

  test("deleted template keeps the campaign's language for the opt-out line", async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign({ leads: 1 });
    const tpl = await prisma.emailTemplate.create({ data: { name: 'Intro ES', language: 'es', subject: 'Hola', body: 'Hola', sourceType: 'manual' } });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { templateId: tpl.id, language: 'es' } });
    await prisma.emailTemplate.delete({ where: { id: tpl.id } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.endsWith('Si prefiere no recibir correos de DAIT Partners, responda con «baja» y no volveremos a contactarle.')).toBe(true);
  });

  test('a mailbox put in error by sync pauses with "needs reconnecting"', async () => {
    at(WED_NOON_SANTIAGO);
    const { sender, account, c } = await campaign();
    await prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'error', lastError: 'invalid_grant' } });
    const { sent, graph } = recording();
    await campaignStepHandler(job(c.id), { graph });
    expect(sent).toHaveLength(0);
    expect(await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'Paused', pauseReason: 'Mailbox needs reconnecting' });
    expect(await prisma.notification.findFirst({ where: { userId: sender.id, text: 'Mailer paused · Chile' } })).toMatchObject({ detail: 'Your Microsoft 365 mailbox needs reconnecting in Settings.' });

    // No account at all: disconnected.
    await prisma.emailAccount.delete({ where: { id: account.id } });
    const other = await campaign();
    await prisma.emailAccount.delete({ where: { id: other.account.id } });
    await campaignStepHandler(job(other.c.id), { graph });
    expect(await prisma.emailCampaign.findUniqueOrThrow({ where: { id: other.c.id } })).toMatchObject({ status: 'Paused', pauseReason: 'Mailbox disconnected' });
  });

  test('two steps at once send one email', async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign({ leads: 2 });
    const a = await prisma.job.create({ data: { type: 'campaign_step', payload: { campaignId: c.id }, status: 'queued', runAt: new Date() } });
    const b = await prisma.job.create({ data: { type: 'campaign_step', payload: { campaignId: c.id }, status: 'queued', runAt: new Date() } });
    const { sent, graph } = recording();
    await Promise.all([campaignStepHandler(a, { graph }), campaignStepHandler(b, { graph })]);
    expect(sent).toHaveLength(1);
    expect((await recipients(c.id)).map((r) => r.status)).toEqual(['Sent', 'Queued']);
  });
});

describe('Mailer scheduling', () => {
  test('a scheduled campaign starts at its time; one step job per due campaign, never two', async () => {
    at(WED_NOON_SANTIAGO);
    const { c } = await campaign({ status: 'Scheduled' });
    await prisma.emailCampaign.update({ where: { id: c.id }, data: { startAt: new Date(WED_NOON_SANTIAGO.getTime() - 60_000) } });
    expect(await scheduleCampaigns(prisma)).toBe(1);
    expect(await scheduleCampaigns(prisma)).toBe(0);
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('Sending');
    expect(await prisma.job.count({ where: { type: 'campaign_step' } })).toBe(1);
  });
});
