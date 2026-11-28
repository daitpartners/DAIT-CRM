import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import type { GraphMessage } from '../src/graph/client';
import { storeMessage } from '../src/jobs/handlers/syncMailbox';
import { loadLeadMailRules } from '../src/mail/leadMail';
import { mailUser } from '../src/mail/match';
import { recordOnLead } from '../src/mail/outgoing';
import { logLeadMail, teamSenders } from '../src/mail/leadTimeline';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Lead mail timeline, Task 3: every lead email goes on the lead's timeline once, by itself. */

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

async function setup(status = 'New') {
  const carlos = await makeUser({ role: 'ADMINISTRATOR', name: 'Carlos Mendez', email: CARLOS });
  const deepak = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh', email: DEEPAK });
  const box = (userId: number, address: string) =>
    prisma.emailAccount.create({ data: { userId, address, provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'), status: 'connected' } });
  const carlosBox = await box(carlos.id, CARLOS);
  const deepakBox = await box(deepak.id, DEEPAK);
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const elaine = await makeContact({ companyId: acme.id, firstName: 'Elaine', lastName: 'Reyes', businessEmail: ELAINE });
  const lead = await makeLead({ companyId: acme.id, contactId: elaine.id, status, companyName: 'Acme' });
  return { carlos, deepak, carlosBox, deepakBox, acme, elaine, lead };
}

let n = 0;
/** A stored row; by default a lead's reply in an inbox. */
async function row(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: ELAINE, fromName: 'Elaine Reyes',
      toAddresses: [CARLOS], subject: 'Proposal', bodyText: 'Hi', graphId: `t-${n}`, messageId: `<m${n}@acme.com>`,
      threadId: 'conv-1', isRead: false, occurredAt: AT,
      ...(data as object),
    },
  });
}

/** Carlos's Sent copy and Deepak's Cc'd Inbox copy of one email to Elaine. */
async function twoCopies(f: Awaited<ReturnType<typeof setup>>) {
  const common = { fromAddress: CARLOS, fromName: 'Carlos Mendez', toAddresses: [ELAINE], ccAddresses: [DEEPAK], messageId: '<c1@daitpartners.com>', leadId: f.lead.id };
  const sent = await row(f.carlos.id, f.carlosBox.id, { ...common, folder: 'sent', status: 'sent', isRead: true });
  const cc = await row(f.deepak.id, f.deepakBox.id, { ...common, folder: 'inbox', status: 'received' });
  return { sent, cc };
}

const emailLines = (leadId: number) =>
  prisma.leadActivity.findMany({ where: { leadId, activityType: 'email' }, orderBy: { id: 'asc' } });
const statusOf = async (leadId: number) => (await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status;

describe('logLeadMail', () => {
  test('a lead email in Carlos\'s Sent adds "Email sent · <subject>" by Carlos, dated at the email', async () => {
    const f = await setup();
    const { sent } = await twoCopies(f);
    expect(await logLeadMail(prisma, sent.id)).toBe('logged');
    const lines = await emailLines(f.lead.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      title: 'Email sent · Proposal', byUserId: f.carlos.id, occurredAt: AT, relatedType: 'email_message', relatedId: sent.id,
    });
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: sent.id } })).loggedAt).not.toBeNull();
  });

  test('a lead\'s reply in Deepak\'s Inbox adds "Email received · <subject>" with no author', async () => {
    const f = await setup();
    const reply = await row(f.deepak.id, f.deepakBox.id, { subject: 'Re: Proposal', leadId: f.lead.id, toAddresses: [DEEPAK] });
    expect(await logLeadMail(prisma, reply.id)).toBe('logged');
    expect(await emailLines(f.lead.id)).toMatchObject([{ title: 'Email received · Re: Proposal', byUserId: null, relatedId: reply.id, occurredAt: AT }]);
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('Carlos\'s Sent copy and Deepak\'s Cc copy give one line, whichever is logged first', async () => {
    for (const order of ['sent first', 'cc first'] as const) {
      await resetDb();
      await seedLookups();
      const f = await setup();
      const { sent, cc } = await twoCopies(f);
      const [a, b] = order === 'sent first' ? [sent, cc] : [cc, sent];
      expect(await logLeadMail(prisma, a.id)).toBe('logged');
      expect(await logLeadMail(prisma, b.id)).toBe('already');
      const lines = await emailLines(f.lead.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ title: 'Email sent · Proposal', byUserId: f.carlos.id });
    }
  });

  test('a CRM-sent email (recordOnLead line, no message id yet) and a colleague\'s Cc copy give one line', async () => {
    const f = await setup();
    const crm = await row(f.carlos.id, f.carlosBox.id, {
      source: 'crm', folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], ccAddresses: [DEEPAK],
      graphId: null, messageId: null, leadId: f.lead.id, isRead: true,
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    await prisma.$transaction((tx) => recordOnLead(tx, { id: f.carlos.id, timezone: 'Europe/London' }, lead, crm, 'Proposal'));
    const cc = await row(f.deepak.id, f.deepakBox.id, {
      fromAddress: CARLOS, subject: 'Re: Proposal', toAddresses: [ELAINE], ccAddresses: [DEEPAK], leadId: f.lead.id,
      occurredAt: new Date(AT.getTime() + 5 * 60_000),
    });
    expect(await logLeadMail(prisma, cc.id)).toBe('already');
    expect(await emailLines(f.lead.id)).toMatchObject([{ relatedId: crm.id }]);
    // Outside the claim window it is another email.
    const later = await row(f.deepak.id, f.deepakBox.id, { fromAddress: CARLOS, leadId: f.lead.id, occurredAt: new Date(AT.getTime() + 60 * 60_000) });
    expect(await logLeadMail(prisma, later.id)).toBe('logged');
  });

  test('a CRM-sent email from a mailbox with send-as and the colleague\'s copy from the send-as address give one line', async () => {
    const f = await setup();
    await prisma.emailAccount.update({ where: { id: f.carlosBox.id }, data: { sendAs: 'Ventas@DaitPartners.com' } });
    const crm = await row(f.carlos.id, f.carlosBox.id, {
      source: 'crm', folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], ccAddresses: [DEEPAK],
      graphId: null, messageId: null, leadId: f.lead.id, isRead: true,
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    await prisma.$transaction((tx) => recordOnLead(tx, { id: f.carlos.id, timezone: 'Europe/London' }, lead, crm, 'Proposal'));
    const cc = await row(f.deepak.id, f.deepakBox.id, {
      fromAddress: 'ventas@daitpartners.com', toAddresses: [ELAINE], ccAddresses: [DEEPAK], leadId: f.lead.id,
      occurredAt: new Date(AT.getTime() + 2 * 60_000),
    });
    expect(await logLeadMail(prisma, cc.id)).toBe('already');
    expect(await emailLines(f.lead.id)).toMatchObject([{ relatedId: crm.id }]);
    // Another team member's email with the same subject at the same time is another email.
    const other = await row(f.deepak.id, f.deepakBox.id, { fromAddress: DEEPAK, folder: 'sent', status: 'sent', leadId: f.lead.id, occurredAt: cc.occurredAt });
    expect(await logLeadMail(prisma, other.id)).toBe('logged');
  });

  test('a quotation\'s sending email and a colleague\'s copy of it add no line and leave the stage', async () => {
    const f = await setup();
    const quote = await row(f.carlos.id, f.carlosBox.id, {
      source: 'crm', folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], ccAddresses: [DEEPAK],
      subject: 'Quotation QT-2026-001 · Website', graphId: null, messageId: null, leadId: f.lead.id, isRead: true,
    });
    // Queued by the quotation send (its audit row); the pointer on the quotation is cleared once the send succeeded.
    await prisma.auditLog.create({ data: { entityType: 'quotation', entityId: '1', action: 'update', userId: f.carlos.id, after: { sendingMessageId: quote.id } } });
    const cc = await row(f.deepak.id, f.deepakBox.id, {
      fromAddress: CARLOS, subject: 'Quotation QT-2026-001 · Website', toAddresses: [ELAINE], ccAddresses: [DEEPAK], leadId: f.lead.id,
      occurredAt: new Date(AT.getTime() + 60_000),
    });
    expect(await logLeadMail(prisma, cc.id)).toBe('skipped');
    expect(await logLeadMail(prisma, quote.id)).toBe('skipped');
    // Once the sender's sync claims the CRM row it carries the message id; a copy with that id is skipped too.
    await prisma.emailMessage.update({ where: { id: quote.id }, data: { messageId: '<q1@daitpartners.com>', graphId: 'g-q1' } });
    const later = await row(f.deepak.id, f.deepakBox.id, { fromAddress: CARLOS, messageId: '<q1@daitpartners.com>', leadId: f.lead.id, occurredAt: new Date(AT.getTime() + 3_600_000) });
    expect(await logLeadMail(prisma, later.id)).toBe('skipped');
    expect(await emailLines(f.lead.id)).toHaveLength(0);
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('an email to yourself gives one line', async () => {
    const f = await setup();
    const common = { fromAddress: CARLOS, toAddresses: [CARLOS], ccAddresses: [ELAINE], messageId: '<self@daitpartners.com>', leadId: f.lead.id, status: 'sent', isRead: true };
    const sent = await row(f.carlos.id, f.carlosBox.id, { ...common, folder: 'sent' });
    const inbox = await row(f.carlos.id, f.carlosBox.id, { ...common, folder: 'inbox' });
    expect(await logLeadMail(prisma, inbox.id)).toBe('logged');
    expect(await logLeadMail(prisma, sent.id)).toBe('already');
    expect(await emailLines(f.lead.id)).toMatchObject([{ title: 'Email sent · Proposal', byUserId: f.carlos.id }]);
  });

  test('a draft, a row without a lead, and a row whose lead was deleted are skipped', async () => {
    const f = await setup();
    const draft = await row(f.carlos.id, f.carlosBox.id, { folder: 'drafts', status: 'draft', fromAddress: CARLOS, leadId: f.lead.id });
    const queued = await row(f.carlos.id, f.carlosBox.id, { source: 'crm', folder: 'sent', status: 'queued', fromAddress: CARLOS, leadId: f.lead.id });
    const loose = await row(f.deepak.id, f.deepakBox.id);
    const gone = await row(f.deepak.id, f.deepakBox.id, { leadDeletedAt: new Date() });
    const goneButLinked = await row(f.deepak.id, f.deepakBox.id, { leadId: f.lead.id, leadDeletedAt: new Date() });
    for (const r of [draft, queued, loose, gone, goneButLinked]) expect(await logLeadMail(prisma, r.id)).toBe('skipped');
    expect(await logLeadMail(prisma, 999_999)).toBe('skipped');
    expect(await emailLines(f.lead.id)).toHaveLength(0);
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('a sent line moves New and Not Contacted to Contacted; a received line and a Qualified lead do not', async () => {
    const f = await setup('New');
    const sent = await row(f.carlos.id, f.carlosBox.id, { folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], leadId: f.lead.id });
    await logLeadMail(prisma, sent.id);
    expect(await statusOf(f.lead.id)).toBe('Contacted');
    expect(await prisma.leadActivity.findFirst({ where: { leadId: f.lead.id, activityType: 'status' } }))
      .toMatchObject({ statusFrom: 'New', statusTo: 'Contacted', body: 'Email sent', byUserId: f.carlos.id });

    const notContacted = await makeLead({ companyId: f.acme.id, status: 'Not Contacted' });
    const second = await row(f.carlos.id, f.carlosBox.id, { folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], leadId: notContacted.id });
    await logLeadMail(prisma, second.id);
    expect(await statusOf(notContacted.id)).toBe('Contacted');

    const received = await makeLead({ companyId: f.acme.id, status: 'New' });
    await logLeadMail(prisma, (await row(f.deepak.id, f.deepakBox.id, { leadId: received.id })).id);
    expect(await statusOf(received.id)).toBe('New');

    const qualified = await makeLead({ companyId: f.acme.id, status: 'Qualified' });
    await logLeadMail(prisma, (await row(f.carlos.id, f.carlosBox.id, { folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], leadId: qualified.id })).id);
    expect(await statusOf(qualified.id)).toBe('Qualified');

    // contacted: false writes the line and leaves the stage.
    const kept = await makeLead({ companyId: f.acme.id, status: 'New' });
    const third = await row(f.carlos.id, f.carlosBox.id, { folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], leadId: kept.id });
    expect(await logLeadMail(prisma, third.id, { contacted: false })).toBe('logged');
    expect(await statusOf(kept.id)).toBe('New');
  });

  test('an internal-only email on a lead thread (a forward to a colleague) is logged but leaves the stage', async () => {
    const f = await setup('New');
    // Carlos forwards Elaine's inquiry to Deepak; Outlook keeps the conversation, so the forward is on the lead.
    const fw = await row(f.carlos.id, f.carlosBox.id, {
      folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: ['Deepak@DaitPartners.com'], ccAddresses: [CARLOS], subject: 'FW: Proposal', leadId: f.lead.id,
    });
    expect(await logLeadMail(prisma, fw.id)).toBe('logged');
    expect(await emailLines(f.lead.id)).toMatchObject([{ title: 'Email sent · FW: Proposal', byUserId: f.carlos.id }]);
    expect(await statusOf(f.lead.id)).toBe('New');

    // One recipient outside the team (here in Bcc) is an email to the lead: Contacted.
    const out = await row(f.carlos.id, f.carlosBox.id, {
      folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [DEEPAK], bccAddresses: [ELAINE], subject: 'Proposal', leadId: f.lead.id,
    });
    expect(await logLeadMail(prisma, out.id)).toBe('logged');
    expect(await statusOf(f.lead.id)).toBe('Contacted');
  });

  test('a failed CRM send gets no line and no Contacted move', async () => {
    const f = await setup('New');
    const failed = await row(f.carlos.id, f.carlosBox.id, {
      source: 'crm', folder: 'sent', status: 'failed', fromAddress: CARLOS, toAddresses: [ELAINE], graphId: null, messageId: null, leadId: f.lead.id,
    });
    expect(await logLeadMail(prisma, failed.id)).toBe('skipped');
    expect(await emailLines(f.lead.id)).toHaveLength(0);
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('a sent line made from a colleague\'s copy relates to the sender\'s own copy when it is stored', async () => {
    const f = await setup();
    const { sent, cc } = await twoCopies(f);
    expect(await logLeadMail(prisma, cc.id)).toBe('logged');
    expect(await emailLines(f.lead.id)).toMatchObject([{ relatedId: sent.id, byUserId: f.carlos.id }]);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: sent.id } })).loggedAt).not.toBeNull();
    expect(await logLeadMail(prisma, sent.id)).toBe('already');
  });

  test('two concurrent logLeadMail calls for two copies of one email add one line', async () => {
    const f = await setup();
    const { sent, cc } = await twoCopies(f);
    const results = await Promise.all([logLeadMail(prisma, sent.id), logLeadMail(prisma, cc.id)]);
    expect(results.sort()).toEqual(['already', 'logged']);
    expect(await emailLines(f.lead.id)).toHaveLength(1);
    expect(await prisma.leadActivity.count({ where: { leadId: f.lead.id, activityType: 'status' } })).toBe(1);
  });

  test('inside a caller\'s transaction it writes with it, and rolls back with it', async () => {
    const f = await setup();
    const { sent } = await twoCopies(f);
    await expect(prisma.$transaction(async (tx) => {
      expect(await logLeadMail(tx, sent.id)).toBe('logged');
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect(await emailLines(f.lead.id)).toHaveLength(0);
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('teamSenders maps users, personal mailboxes and their send-as to the user', async () => {
    const f = await setup();
    await prisma.emailAccount.update({ where: { id: f.carlosBox.id }, data: { sendAs: 'Ventas@DaitPartners.com' } });
    const senders = await teamSenders(prisma);
    expect(senders.get(CARLOS)).toBe(f.carlos.id);
    expect(senders.get('ventas@daitpartners.com')).toBe(f.carlos.id);
    expect(senders.get(DEEPAK)).toBe(f.deepak.id);
    expect(senders.has(ELAINE)).toBe(false);
  });
});

describe('callers', () => {
  test('sync stores a lead email from Outlook and its line appears', async () => {
    const f = await setup();
    const user = (await mailUser(prisma, f.carlos.id))!;
    const m: GraphMessage = {
      id: 'g-out-1', subject: 'Proposal', from: { name: 'Carlos Mendez', address: CARLOS }, to: [ELAINE], cc: [DEEPAK], bcc: [],
      receivedAt: '2026-11-20T10:00:00.000Z', sentAt: '2026-11-20T09:59:00.000Z', isRead: true, isDraft: false,
      conversationId: 'conv-x', internetMessageId: '<out1@daitpartners.com>', hasAttachments: false,
      body: { contentType: 'text', content: 'Hi Elaine' }, flag: { status: 'notFlagged', due: null },
    };
    const ctx = { graph: fakeGraph() };
    expect(await storeMessage(f.carlosBox, user, 'sent', m, ctx, await loadLeadMailRules(prisma))).toBe('stored');
    const stored = await prisma.emailMessage.findFirstOrThrow({ where: { graphId: 'g-out-1' } });
    expect(stored.leadId).toBe(f.lead.id);
    expect(await emailLines(f.lead.id)).toMatchObject([
      { title: 'Email sent · Proposal', byUserId: f.carlos.id, relatedId: stored.id, occurredAt: new Date('2026-11-20T09:59:00.000Z') },
    ]);
    expect(await statusOf(f.lead.id)).toBe('Contacted');

    // Deepak's Cc'd copy, synced from his mailbox, adds no second line.
    const deepakUser = (await mailUser(prisma, f.deepak.id))!;
    expect(await storeMessage(f.deepakBox, deepakUser, 'inbox', { ...m, id: 'g-in-1', isRead: false }, ctx, await loadLeadMailRules(prisma))).toBe('stored');
    expect(await emailLines(f.lead.id)).toHaveLength(1);
  });

  test('a lead draft sent from Outlook goes on the timeline when sync sees it sent', async () => {
    const f = await setup();
    const user = (await mailUser(prisma, f.carlos.id))!;
    const draft = await row(f.carlos.id, f.carlosBox.id, {
      folder: 'drafts', status: 'draft', fromAddress: CARLOS, toAddresses: [ELAINE], graphId: 'g-draft-1', messageId: '<d1@daitpartners.com>', leadId: f.lead.id,
    });
    const m: GraphMessage = {
      id: 'g-draft-1', subject: 'Proposal', from: { name: 'Carlos Mendez', address: CARLOS }, to: [ELAINE], cc: [], bcc: [],
      receivedAt: '2026-11-21T10:00:00.000Z', sentAt: '2026-11-21T10:00:00.000Z', isRead: true, isDraft: false,
      conversationId: 'conv-d', internetMessageId: '<d1@daitpartners.com>', hasAttachments: false,
      body: { contentType: 'text', content: 'Hi Elaine' }, flag: { status: 'notFlagged', due: null },
    };
    expect(await storeMessage(f.carlosBox, user, 'sent', m, { graph: fakeGraph() }, await loadLeadMailRules(prisma))).toBe('updated');
    expect(await emailLines(f.lead.id)).toMatchObject([{ title: 'Email sent · Proposal', relatedId: draft.id, byUserId: f.carlos.id }]);
    // A later sync of the same message adds nothing.
    expect(await storeMessage(f.carlosBox, user, 'sent', m, { graph: fakeGraph() }, await loadLeadMailRules(prisma))).toBe('updated');
    expect(await emailLines(f.lead.id)).toHaveLength(1);
  });

  test('Link to lead adds the line for the message and for the conversation it links', async () => {
    const f = await setup();
    const reply = await row(f.deepak.id, f.deepakBox.id, { threadId: 'conv-l', toAddresses: [DEEPAK], fromAddress: 'x@unknown.io', occurredAt: AT });
    const answer = await row(f.deepak.id, f.deepakBox.id, {
      threadId: 'conv-l', folder: 'sent', status: 'sent', fromAddress: DEEPAK, toAddresses: ['x@unknown.io'], subject: 'Re: Proposal',
      occurredAt: new Date(AT.getTime() + 3_600_000), isRead: true,
    });
    const res = await app.inject({ method: 'POST', url: `/api/mail/${reply.id}/link`, headers: { cookie: await signIn(app, f.deepak) }, payload: { leadId: f.lead.id } });
    expect(res.statusCode).toBe(200);
    const lines = await emailLines(f.lead.id);
    expect(lines.map((l) => [l.relatedId, l.title, l.byUserId])).toEqual(expect.arrayContaining([
      [reply.id, 'Email received · Proposal', null],
      [answer.id, 'Email sent · Re: Proposal', f.deepak.id],
    ]));
    expect(lines).toHaveLength(2);
    expect(await statusOf(f.lead.id)).toBe('Contacted');
  });

  test('Log as activity on an auto-logged message answers 409 already_logged', async () => {
    const f = await setup();
    const { sent, cc } = await twoCopies(f);
    await logLeadMail(prisma, sent.id);
    const cookie = await signIn(app, f.deepak);
    // Deepak's copy was never logged itself, but Carlos's copy of the same email was.
    const res = await app.inject({ method: 'POST', url: `/api/mail/${cc.id}/log`, headers: { cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_logged');
    expect(await emailLines(f.lead.id)).toHaveLength(1);
  });

  test('a Sales rep sees the subject of her own email when the line was made from a colleague\'s copy', async () => {
    const f = await setup();
    const lakshita = await makeUser({ name: 'Lakshita Rao', email: 'lakshita@daitpartners.com' });
    const ravi = await makeUser({ name: 'Ravi Rep', email: 'ravi@daitpartners.com' });
    await prisma.lead.update({ where: { id: f.lead.id }, data: { assignedToId: lakshita.id } });
    const common = { fromAddress: 'lakshita@daitpartners.com', toAddresses: [ELAINE], ccAddresses: [DEEPAK], messageId: '<l1@daitpartners.com>', leadId: f.lead.id };
    // Deepak's Cc copy is logged first (his mailbox synced first); Lakshita's Sent copy is not stored yet.
    const cc = await row(f.deepak.id, f.deepakBox.id, common);
    expect(await logLeadMail(prisma, cc.id)).toBe('logged');
    await row(lakshita.id, null, { ...common, folder: 'sent', status: 'sent', isRead: true });
    expect(await emailLines(f.lead.id)).toMatchObject([{ relatedId: cc.id }]);
    const timeline = async (cookie: string) =>
      ((await app.inject({ method: 'GET', url: `/api/leads/${f.lead.id}`, headers: { cookie } })).json().activities as { activityType: string; title: string }[])
        .filter((a) => a.activityType === 'email').map((a) => a.title);
    expect(await timeline(await signIn(app, lakshita))).toEqual(['Email sent · Proposal']);
    // A rep who owns no copy still sees only "Email sent".
    await prisma.lead.update({ where: { id: f.lead.id }, data: { assignedToId: ravi.id } });
    expect(await timeline(await signIn(app, ravi))).toEqual(['Email sent']);
  });
});
