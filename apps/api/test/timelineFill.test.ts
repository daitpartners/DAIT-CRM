import type { EmailMessage } from '@prisma/client';
import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { logLeadMail } from '../src/mail/leadTimeline';
import { FILL_USAGE, fillLeadMailTimeline, parseFillArgs } from '../src/mail/timelineFill';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser } from './factory';

/** Lead mail timeline, Task 4: the one-time fill puts past lead mail on the timelines. */

beforeEach(async () => {
  await resetDb();
  await seedLookups();
});

const CARLOS = 'carlos@daitpartners.com';
const DEEPAK = 'deepak@daitpartners.com';
const ELAINE = 'elaine@acme.com';
const AT = new Date('2026-11-20T10:00:00Z');
const at = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

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
  const other = await makeLead({ companyId: acme.id, status: 'Not Contacted', companyName: 'Acme' });
  return { carlos, deepak, carlosBox, deepakBox, lead, other };
}

let n = 0;
/** A stored row; by default a lead's reply in an inbox. */
async function row(userId: number, accountId: number | null, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, accountId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: ELAINE, fromName: 'Elaine Reyes',
      toAddresses: [CARLOS], subject: `Subject ${n}`, bodyText: 'Hi', graphId: `f-${n}`, messageId: `<f${n}@acme.com>`,
      threadId: 'conv-1', isRead: false, occurredAt: AT,
      ...(data as object),
    },
  });
}

const sentBy = (f: Awaited<ReturnType<typeof setup>>, data: Partial<EmailMessage>) =>
  row(f.carlos.id, f.carlosBox.id, { folder: 'sent', status: 'sent', fromAddress: CARLOS, toAddresses: [ELAINE], isRead: true, ...data });

const emailLines = (leadId: number) =>
  prisma.leadActivity.findMany({ where: { leadId, activityType: 'email' }, orderBy: { id: 'asc' } });
const statusOf = async (leadId: number) => (await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status;

const run = (apply: boolean, lines: string[] = []) => fillLeadMailTimeline(prisma, { apply, log: (l) => lines.push(l) });

describe('lead-mail-timeline fill', () => {
  test('adds the missing lines oldest first and reports counts', async () => {
    const f = await setup();
    const third = await row(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id, occurredAt: at(20) });
    const first = await row(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id, occurredAt: at(0) });
    const logged = await row(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id, occurredAt: at(10) });
    expect(await logLeadMail(prisma, logged.id)).toBe('logged');
    const lines: string[] = [];

    const counts = await run(true, lines);

    expect(counts).toEqual({ examined: 3, lines: 2, leads: 1, contacted: 0 });
    expect(lines).toEqual(['lead-mail-timeline: applied examined=3 lines=2 leads=1 contacted=0']);
    const made = await emailLines(f.lead.id);
    expect(made.map((l) => l.relatedId)).toEqual([logged.id, first.id, third.id]);
    expect(made[1]).toMatchObject({ title: `Email received · ${first.subject}`, occurredAt: at(0), byUserId: null });
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('the dry run reports lines, leads and Contacted moves without writing', async () => {
    const f = await setup();
    // One email in Carlos's Sent and Deepak's Cc'd Inbox: one line, one Contacted move.
    const common = { messageId: '<c1@daitpartners.com>', ccAddresses: [DEEPAK], leadId: f.lead.id, subject: 'Proposal' };
    await sentBy(f, common);
    await row(f.deepak.id, f.deepakBox.id, { ...common, fromAddress: CARLOS, toAddresses: [ELAINE] });
    await row(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id, occurredAt: at(30) });
    // The other lead: a sent email (Contacted) and a second one (moves once).
    await sentBy(f, { leadId: f.other.id, occurredAt: at(5) });
    await sentBy(f, { leadId: f.other.id, occurredAt: at(6) });
    const dry: string[] = [];

    const predicted = await run(false, dry);

    expect(predicted).toEqual({ examined: 5, lines: 4, leads: 2, contacted: 2 });
    expect(dry).toEqual(['lead-mail-timeline: dry run examined=5 lines=4 leads=2 contacted=2']);
    expect(await prisma.leadActivity.count()).toBe(0);
    expect(await prisma.emailMessage.count({ where: { loggedAt: { not: null } } })).toBe(0);
    expect(await statusOf(f.lead.id)).toBe('New');
    expect(await statusOf(f.other.id)).toBe('Not Contacted');

    expect(await run(true)).toEqual(predicted);
    expect(await emailLines(f.lead.id)).toHaveLength(2);
    expect(await emailLines(f.other.id)).toHaveLength(2);
    expect(await statusOf(f.lead.id)).toBe('Contacted');
    expect(await statusOf(f.other.id)).toBe('Contacted');
  });

  test('a second run adds 0', async () => {
    const f = await setup();
    await sentBy(f, { leadId: f.lead.id });
    await row(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id, occurredAt: at(10) });
    expect(await run(true)).toMatchObject({ lines: 2, leads: 1, contacted: 1 });

    expect(await run(false)).toEqual({ examined: 2, lines: 0, leads: 0, contacted: 0 });
    expect(await run(true)).toEqual({ examined: 2, lines: 0, leads: 0, contacted: 0 });
    expect(await emailLines(f.lead.id)).toHaveLength(2);
  });

  test('skips drafts and deleted-lead mail', async () => {
    const f = await setup();
    await sentBy(f, { leadId: f.lead.id, folder: 'drafts', status: 'draft' });
    await sentBy(f, { leadId: f.lead.id, source: 'crm', status: 'queued', graphId: null, messageId: null });
    await row(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id, leadDeletedAt: new Date() });
    await row(f.carlos.id, f.carlosBox.id, { leadId: null });
    const kept = await row(f.carlos.id, f.carlosBox.id, { leadId: f.lead.id });

    expect(await run(true)).toEqual({ examined: 1, lines: 1, leads: 1, contacted: 0 });
    expect((await emailLines(f.lead.id)).map((l) => l.relatedId)).toEqual([kept.id]);
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('skips a failed CRM send: no line, no Contacted move, not examined', async () => {
    const f = await setup();
    await sentBy(f, { leadId: f.lead.id, source: 'crm', status: 'failed', graphId: null, messageId: null });

    expect(await run(true)).toEqual({ examined: 0, lines: 0, leads: 0, contacted: 0 });
    expect(await emailLines(f.lead.id)).toHaveLength(0);
    expect(await statusOf(f.lead.id)).toBe('New');
  });

  test('walks past a batch of 200', async () => {
    const f = await setup();
    await prisma.emailMessage.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        userId: f.carlos.id, accountId: f.carlosBox.id, folder: 'inbox', status: 'received', source: 'sync', fromAddress: ELAINE,
        toAddresses: [CARLOS], subject: `Bulk ${i}`, graphId: `bulk-${i}`, messageId: `<bulk${i}@acme.com>`, leadId: f.lead.id, occurredAt: AT,
      })),
    });
    expect(await run(false)).toEqual({ examined: 205, lines: 205, leads: 1, contacted: 0 });
    expect(await run(true)).toEqual({ examined: 205, lines: 205, leads: 1, contacted: 0 });
    expect(await emailLines(f.lead.id)).toHaveLength(205);
  });
});

describe('parseFillArgs', () => {
  test('no flag or --dry-run is a dry run, --apply applies, anything else is an error', () => {
    expect(parseFillArgs([])).toEqual({ apply: false });
    expect(parseFillArgs(['--dry-run'])).toEqual({ apply: false });
    expect(parseFillArgs(['--apply'])).toEqual({ apply: true });
    expect(parseFillArgs(['--aply'])).toHaveProperty('error');
    expect(parseFillArgs(['--apply', '--dry-run'])).toHaveProperty('error');
    expect(FILL_USAGE).toMatch(/lead-mail-timeline/);
  });
});
