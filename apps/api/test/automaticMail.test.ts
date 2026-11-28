import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import type { GraphMessage } from '../src/graph/client';
import { storeMessage } from '../src/jobs/handlers/syncMailbox';
import { isAutomaticMail } from '../src/mail/automatic';
import { TIMELINE_AUTOMATIC_USAGE, cleanTimelineAutomatic, parseTimelineAutomaticArgs } from '../src/mail/automaticCleanup';
import { loadLeadMailRules } from '../src/mail/leadMail';
import { logLeadMail } from '../src/mail/leadTimeline';
import { mailUser } from '../src/mail/match';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Bounces and automatic replies stay off the lead timeline (owner, 28 Nov 2026). */

let app: FastifyInstance;
beforeAll(async () => {
  process.env.TEST_LOGIN = '1';
  app = await buildApp({ graph: fakeGraph() });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDb();
  await seedLookups();
});

const CARLOS = 'carlos@daitpartners.com';
const DEEPAK = 'deepak@daitpartners.com';
const ELAINE = 'elaine@acme.com';
const AT = new Date('2026-11-20T10:00:00Z');

async function setup() {
  const carlos = await makeUser({ role: 'ADMINISTRATOR', name: 'Carlos Mendez', email: CARLOS });
  const deepak = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh', email: DEEPAK });
  const box = (userId: number, address: string) =>
    prisma.emailAccount.create({ data: { userId, address, provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'), status: 'connected' } });
  const carlosBox = await box(carlos.id, CARLOS);
  const deepakBox = await box(deepak.id, DEEPAK);
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const elaine = await makeContact({ companyId: acme.id, firstName: 'Elaine', lastName: 'Reyes', businessEmail: ELAINE });
  const lead = await makeLead({ companyId: acme.id, contactId: elaine.id, status: 'New', companyName: 'Acme' });
  return { carlos, deepak, carlosBox, deepakBox, lead };
}

let n = 0;
/** A stored row; by default a lead's reply in an inbox. */
async function row(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: ELAINE, fromName: 'Elaine Reyes',
      toAddresses: [CARLOS], subject: 'Proposal', bodyText: 'Hi', graphId: `a-${n}`, messageId: `<a${n}@acme.com>`,
      threadId: 'conv-1', isRead: false, occurredAt: AT,
      ...(data as object),
    },
  });
}

const emailLines = (leadId: number) =>
  prisma.leadActivity.findMany({ where: { leadId, activityType: 'email' }, orderBy: { id: 'asc' } });
const statusOf = async (leadId: number) => (await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status;
const loggedAt = async (id: number) => (await prisma.emailMessage.findUniqueOrThrow({ where: { id } })).loggedAt;

describe('isAutomaticMail', () => {
  test('bounces and automatic replies are automatic', () => {
    expect(isAutomaticMail({ fromAddress: 'mailer-daemon@x.com', subject: 'Undeliverable: Hi' })).toBe(true);
    expect(isAutomaticMail({ fromAddress: 'postmaster@kpmg.com', subject: 'No se puede entregar: Hi' })).toBe(true);
    expect(isAutomaticMail({ fromAddress: 'marsha@kpmg.ca', subject: 'Automatic reply: Hi' })).toBe(true);
    expect(isAutomaticMail({ fromAddress: 'marsha@kpmg.ca', subject: 'RESPUESTA AUTOMÁTICA: x' })).toBe(true);
    expect(isAutomaticMail({ fromAddress: 'marsha@kpmg.ca', subject: '  Out of Office: back Monday' })).toBe(true);
    expect(isAutomaticMail({ fromAddress: 'marsha@kpmg.ca', subject: 'Delivery Status Notification (Failure)' })).toBe(true);
    expect(isAutomaticMail({ fromAddress: 'No-Reply@Service.com', subject: 'Your invoice' })).toBe(true);
  });

  test('a person\'s ordinary email is not', () => {
    expect(isAutomaticMail({ fromAddress: 'marsha@kpmg.ca', subject: 'Re: Automatic reply settings' })).toBe(false);
    expect(isAutomaticMail({ fromAddress: 'marsha@kpmg.ca', subject: 'Autumn plans' })).toBe(false);
    expect(isAutomaticMail({ fromAddress: 'marsha@kpmg.ca', subject: 'Re: Proposal' })).toBe(false);
    expect(isAutomaticMail({ fromAddress: 'noreply.fan@kpmg.ca', subject: 'Re: Proposal' })).toBe(false);
  });
});

describe('the lead timeline', () => {
  test('a bounce stored by sync gets no timeline line and leaves the stage', async () => {
    const f = await setup();
    const user = (await mailUser(prisma, f.carlos.id))!;
    const m: GraphMessage = {
      id: 'g-bounce-1', subject: 'Undeliverable: Proposal', from: { name: 'Mail Delivery System', address: 'postmaster@acme.com' }, to: [CARLOS], cc: [], bcc: [],
      receivedAt: '2026-11-20T10:00:00.000Z', sentAt: '2026-11-20T09:59:00.000Z', isRead: false, isDraft: false,
      conversationId: 'conv-b', internetMessageId: '<bounce1@acme.com>', hasAttachments: false,
      body: { contentType: 'text', content: 'Away' }, flag: { status: 'notFlagged', due: null },
    };
    expect(await storeMessage(f.carlosBox, user, 'inbox', m, { graph: fakeGraph() }, await loadLeadMailRules(prisma))).toBe('stored');
    const stored = await prisma.emailMessage.findFirstOrThrow({ where: { graphId: 'g-bounce-1' } });
    expect(stored.leadId).toBe(f.lead.id);
    expect(stored.loggedAt).toBeNull();
    expect(await emailLines(f.lead.id)).toHaveLength(0);
    expect(await statusOf(f.lead.id)).toBe('New');

    // The lead's own automatic reply is skipped too.
    const away = await row(f.carlos.id, f.carlosBox.id, { subject: 'Automatic reply: Proposal', leadId: f.lead.id });
    expect(await logLeadMail(prisma, away.id)).toBe('skipped');
    expect(await loggedAt(away.id)).toBeNull();
    expect(await emailLines(f.lead.id)).toHaveLength(0);
  });

  test('a team member\'s sent email with an "Auto:" subject is still logged', async () => {
    const f = await setup();
    const sent = await row(f.carlos.id, f.carlosBox.id, {
      folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], subject: 'Auto: renewal terms', leadId: f.lead.id, isRead: true,
    });
    expect(await logLeadMail(prisma, sent.id)).toBe('logged');
    expect(await emailLines(f.lead.id)).toMatchObject([{ title: 'Email sent · Auto: renewal terms', byUserId: f.carlos.id }]);
    expect(await statusOf(f.lead.id)).toBe('Contacted');
  });

  test('Log as activity still logs an automatic email by hand', async () => {
    const f = await setup();
    const bounce = await row(f.deepak.id, f.deepakBox.id, {
      fromAddress: 'mailer-daemon@acme.com', toAddresses: [DEEPAK], subject: 'Undeliverable: Proposal', leadId: f.lead.id,
    });
    expect(await logLeadMail(prisma, bounce.id)).toBe('skipped');
    const res = await app.inject({ method: 'POST', url: `/api/mail/${bounce.id}/log`, headers: { cookie: await signIn(app, f.deepak) } });
    expect(res.statusCode).toBe(201);
    expect(await emailLines(f.lead.id)).toMatchObject([
      { title: 'Email received · Undeliverable: Proposal', byUserId: f.deepak.id, relatedId: bounce.id },
    ]);
    expect(await loggedAt(bounce.id)).not.toBeNull();
  });
});

describe('timeline-automatic clean-up', () => {
  /** A timeline line pointing at `m`, as the lead mail timeline wrote it before this change. */
  const line = (leadId: number, m: EmailMessage, title: string, byUserId: number | null = null) =>
    prisma.leadActivity.create({
      data: { leadId, activityType: 'email', title, relatedType: 'email_message', relatedId: m.id, byUserId, occurredAt: m.occurredAt },
    });
  const run = (apply: boolean, out: string[] = []) => cleanTimelineAutomatic(prisma, { apply, log: (l) => out.push(l) });

  test('the clean-up removes automatic received lines only, dry run writes nothing, a second run removes 0', async () => {
    const f = await setup();
    const logged = { loggedAt: new Date('2026-11-28T09:00:00Z'), leadId: f.lead.id };
    const bounce = await row(f.carlos.id, f.carlosBox.id, { ...logged, fromAddress: 'postmaster@acme.com', subject: 'No se puede entregar: Proposal' });
    const away = await row(f.carlos.id, f.carlosBox.id, { ...logged, subject: 'Automatic reply: Proposal' });
    const reply = await row(f.carlos.id, f.carlosBox.id, { ...logged, subject: 'Re: Proposal' });
    const sent = await row(f.carlos.id, f.carlosBox.id, {
      ...logged, folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], subject: 'Auto: renewal terms',
    });
    await line(f.lead.id, bounce, 'Email received · No se puede entregar: Proposal');
    await line(f.lead.id, away, 'Email received · Automatic reply: Proposal');
    // Someone also logged the automatic reply by hand: that line stays, and so does the row's logged_at.
    const byHand = await line(f.lead.id, away, 'Email received · Automatic reply: Proposal', f.deepak.id);
    const keptReply = await line(f.lead.id, reply, 'Email received · Re: Proposal');
    const keptSent = await line(f.lead.id, sent, 'Email sent · Auto: renewal terms', f.carlos.id);
    const before = await emailLines(f.lead.id);

    const dry: string[] = [];
    expect(await run(false, dry)).toEqual({ lines: 2 });
    expect(dry).toEqual(['timeline-automatic: dry run lines=2']);
    expect(await emailLines(f.lead.id)).toEqual(before);
    expect(await loggedAt(bounce.id)).not.toBeNull();

    const applied: string[] = [];
    expect(await run(true, applied)).toEqual({ lines: 2 });
    expect(applied).toEqual(['timeline-automatic: applied lines=2']);
    expect((await emailLines(f.lead.id)).map((l) => l.id)).toEqual([byHand.id, keptReply.id, keptSent.id]);
    expect(await loggedAt(bounce.id)).toBeNull();
    expect(await loggedAt(away.id)).not.toBeNull();
    expect(await loggedAt(reply.id)).not.toBeNull();
    expect(await loggedAt(sent.id)).not.toBeNull();

    const again: string[] = [];
    expect(await run(true, again)).toEqual({ lines: 0 });
    expect(again).toEqual(['timeline-automatic: applied lines=0']);
  });

  test('parseTimelineAutomaticArgs: dry run by default, --apply to write, anything else is an error', () => {
    expect(parseTimelineAutomaticArgs([])).toEqual({ apply: false });
    expect(parseTimelineAutomaticArgs(['--dry-run'])).toEqual({ apply: false });
    expect(parseTimelineAutomaticArgs(['--apply'])).toEqual({ apply: true });
    expect(parseTimelineAutomaticArgs(['--aply'])).toHaveProperty('error');
    expect(parseTimelineAutomaticArgs(['--apply', '--dry-run'])).toHaveProperty('error');
    expect(TIMELINE_AUTOMATIC_USAGE).toMatch(/timeline-automatic/);
  });
});
