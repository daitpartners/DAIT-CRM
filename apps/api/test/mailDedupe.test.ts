import { beforeEach, describe, expect, test } from 'vitest';
import type { EmailMessage, Prisma, User } from '@prisma/client';
import { prisma } from '../src/db';
import { DEDUPE_USAGE, dedupeMail, parseDedupeArgs } from '../src/mail/dedupe';
import { mailSide } from '../src/mail/direction';
import { resetDb } from './helpers';
import { makeCompany, makeContact, makeLead, makeProject, makeUser } from './factory';

let rep: User;

beforeEach(async () => {
  await resetDb();
  rep = await makeUser({ name: 'Maya Rep' });
});

/** One stored received message of `user` (default: the rep). */
function mail(data: Partial<Prisma.EmailMessageUncheckedCreateInput> = {}, user: User = rep): Promise<EmailMessage> {
  return prisma.emailMessage.create({
    data: {
      userId: user.id, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com',
      toAddresses: [user.email], subject: 'Proposal for Acme', messageId: '<m1@acme.com>', ...data,
    },
  });
}

const DELTA = 'AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A' + 'x'.repeat(32);
const SEARCH = 'AAMkAGI2THVSAAA' + 'y'.repeat(137);

const run = (apply = true, lines: string[] = []) => dedupeMail(prisma, { apply, log: (l) => lines.push(l) });

describe('mail-dedupe (lead mail timeline)', () => {
  test('keeps the delta row (AAkALg id) and removes the search row', async () => {
    const search = await mail({ graphId: SEARCH });
    const delta = await mail({ graphId: DELTA });
    const lines: string[] = [];

    const counts = await run(true, lines);

    expect(counts).toEqual({ groups: 1, removed: 1, linksCarried: 0, referencesMoved: 0 });
    const left = await prisma.emailMessage.findMany({ where: { userId: rep.id } });
    expect(left.map((m) => m.id)).toEqual([delta.id]);
    expect(await prisma.emailMessage.findUnique({ where: { id: search.id } })).toBeNull();
    expect(lines).toEqual(['mail-dedupe: applied groups=1 removed=1 links_carried=0 references_moved=0']);
  });

  test('keeps the lowest id when neither or both Graph ids are delta ids', async () => {
    const a = await mail({ graphId: 'AAMk-1', messageId: '<a@x>' });
    await mail({ graphId: 'AAMk-2', messageId: '<a@x>' });
    const b = await mail({ graphId: `${DELTA}1`, messageId: '<b@x>' });
    await mail({ graphId: `${DELTA}2`, messageId: '<b@x>' });
    const c = await mail({ graphId: null, messageId: '<c@x>' });
    await mail({ graphId: 'AAMk-3', messageId: '<c@x>' });

    const counts = await run();

    expect(counts).toMatchObject({ groups: 3, removed: 3 });
    const left = await prisma.emailMessage.findMany({ orderBy: { id: 'asc' } });
    expect(left.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  test('keeps the CRM-sent row over the delta row and gives it the delta id and the campaign', async () => {
    const lead = await makeLead();
    const campaign = await prisma.emailCampaign.create({
      data: {
        name: 'Nov', templateName: 'T', subject: 'S', body: 'B', senderId: rep.id, senderAddress: rep.email, intervalMinutes: 5,
        lawfulBasis: 'Legitimate interest', status: 'Completed',
      },
    });
    const sent = { folder: 'sent', status: 'sent', fromAddress: rep.email };
    const crm = await mail({ ...sent, source: 'crm', graphId: null, leadId: lead.id });
    const delta = await mail({ ...sent, graphId: DELTA, campaignId: campaign.id });
    // A second group: the CRM row has a search id and its own campaign; it keeps its campaign and takes the delta id.
    const own = await prisma.emailCampaign.create({
      data: {
        name: 'Dec', templateName: 'T', subject: 'S', body: 'B', senderId: rep.id, senderAddress: rep.email, intervalMinutes: 5,
        lawfulBasis: 'Legitimate interest', status: 'Completed',
      },
    });
    const crm2 = await mail({ ...sent, source: 'crm', graphId: SEARCH, messageId: '<m2@x>', campaignId: own.id });
    await mail({ ...sent, graphId: `${DELTA}2`, messageId: '<m2@x>', campaignId: campaign.id });

    expect(await run()).toMatchObject({ groups: 2, removed: 2 });

    const left = await prisma.emailMessage.findMany({ orderBy: { id: 'asc' } });
    expect(left.map((m) => m.id)).toEqual([crm.id, crm2.id]);
    expect(await prisma.emailMessage.findUnique({ where: { id: delta.id } })).toBeNull();
    expect(left[0]).toMatchObject({ source: 'crm', graphId: DELTA, campaignId: campaign.id, leadId: lead.id });
    expect(left[1]).toMatchObject({ source: 'crm', graphId: `${DELTA}2`, campaignId: own.id });
  });

  test('a CRM row kept over a search row keeps its own Graph id', async () => {
    const crm = await mail({ folder: 'sent', status: 'sent', fromAddress: rep.email, source: 'crm', graphId: null });
    await mail({ folder: 'sent', status: 'sent', fromAddress: rep.email, graphId: SEARCH });

    expect(await run()).toMatchObject({ groups: 1, removed: 1 });
    expect(await prisma.emailMessage.findMany()).toMatchObject([{ id: crm.id, graphId: null }]);
  });

  test('carries lead, contact, company, project and logged_at from the removed row when the kept row has none', async () => {
    const company = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
    const lead = await makeLead({ companyId: company.id });
    const contact = await makeContact({ companyId: company.id });
    const project = await makeProject({ companyId: company.id, managerId: rep.id });
    const loggedAt = new Date('2026-11-20T10:00:00Z');
    await mail({ graphId: SEARCH, leadId: lead.id, contactId: contact.id, companyId: company.id, projectId: project.id, loggedAt });
    const kept = await mail({ graphId: DELTA });

    // A second group where the kept row already has a lead: its own value wins, the rest is carried.
    const otherLead = await makeLead({ companyId: company.id });
    await mail({ graphId: `${SEARCH}2`, messageId: '<m2@acme.com>', leadId: otherLead.id, contactId: contact.id });
    const kept2 = await mail({ graphId: `${DELTA}2`, messageId: '<m2@acme.com>', leadId: lead.id });

    // A third group where the removed row adds nothing.
    await mail({ graphId: `${SEARCH}3`, messageId: '<m3@acme.com>' });
    await mail({ graphId: `${DELTA}3`, messageId: '<m3@acme.com>', leadId: lead.id });

    const counts = await run();

    expect(counts).toMatchObject({ groups: 3, removed: 3, linksCarried: 2 });
    expect(await prisma.emailMessage.findUnique({ where: { id: kept.id } })).toMatchObject({
      leadId: lead.id, contactId: contact.id, companyId: company.id, projectId: project.id, loggedAt,
    });
    expect(await prisma.emailMessage.findUnique({ where: { id: kept2.id } })).toMatchObject({
      leadId: lead.id, contactId: contact.id, companyId: null,
    });
  });

  test('moves timeline lines, replies and Mailer recipients to the kept row', async () => {
    const lead = await makeLead();
    const removed = await mail({ graphId: SEARCH, leadId: lead.id });
    const kept = await mail({ graphId: DELTA });
    const line = await prisma.leadActivity.create({
      data: { leadId: lead.id, activityType: 'email', title: 'Email received · Proposal for Acme', relatedType: 'email_message', relatedId: removed.id },
    });
    const reply = await mail({ folder: 'sent', status: 'sent', fromAddress: rep.email, messageId: '<r1@x>', replyToId: removed.id });
    const campaign = await prisma.emailCampaign.create({
      data: {
        name: 'Nov', templateName: 'T', subject: 'S', body: 'B', senderId: rep.id, senderAddress: rep.email, intervalMinutes: 5,
        lawfulBasis: 'Legitimate interest', status: 'Completed',
      },
    });
    const recipient = await prisma.emailCampaignRecipient.create({
      data: { campaignId: campaign.id, toAddress: 'ana@acme.com', timezoneSource: 'company', status: 'Sent', position: 1, emailMessageId: removed.id },
    });

    const counts = await run();

    expect(counts).toEqual({ groups: 1, removed: 1, linksCarried: 1, referencesMoved: 3 });
    expect((await prisma.leadActivity.findUnique({ where: { id: line.id } }))!.relatedId).toBe(kept.id);
    expect((await prisma.emailMessage.findUnique({ where: { id: reply.id } }))!.replyToId).toBe(kept.id);
    expect((await prisma.emailCampaignRecipient.findUnique({ where: { id: recipient.id } }))!.emailMessageId).toBe(kept.id);
  });

  test('a dry run changes nothing and reports the same counts', async () => {
    const lead = await makeLead();
    const removed = await mail({ graphId: SEARCH, leadId: lead.id });
    await mail({ graphId: DELTA });
    await prisma.leadActivity.create({
      data: { leadId: lead.id, activityType: 'email', title: 'Email received · Proposal for Acme', relatedType: 'email_message', relatedId: removed.id },
    });
    const before = await prisma.emailMessage.findMany({ orderBy: { id: 'asc' } });
    const lines: string[] = [];

    const dry = await run(false, lines);

    expect(dry).toEqual({ groups: 1, removed: 1, linksCarried: 1, referencesMoved: 1 });
    expect(lines).toEqual(['mail-dedupe: dry run groups=1 removed=1 links_carried=1 references_moved=1']);
    expect(await prisma.emailMessage.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect((await prisma.leadActivity.findFirst())!.relatedId).toBe(removed.id);

    expect(await run(true)).toEqual(dry);
  });

  test('a second run finds 0 groups', async () => {
    await mail({ graphId: SEARCH });
    await mail({ graphId: DELTA });
    await run();

    expect(await run()).toEqual({ groups: 0, removed: 0, linksCarried: 0, referencesMoved: 0 });
  });

  test('the same message id in Sent and Inbox is not a group', async () => {
    // An email to yourself: from an own address, so its Inbox copy is stored as sent too.
    await mail({ graphId: DELTA, folder: 'sent', status: 'sent', fromAddress: rep.email });
    await mail({ graphId: `${DELTA}2`, folder: 'inbox', status: 'sent', fromAddress: rep.email });
    // A received copy and a sent copy of one message id stay apart as well.
    await mail({ graphId: `${DELTA}3`, messageId: '<m2@x>', folder: 'inbox', status: 'received' });
    await mail({ graphId: `${DELTA}4`, messageId: '<m2@x>', folder: 'sent', status: 'sent', fromAddress: rep.email });

    expect(await run()).toEqual({ groups: 0, removed: 0, linksCarried: 0, referencesMoved: 0 });
    expect(await prisma.emailMessage.count()).toBe(4);
  });

  test('rows of different users, or without a message id, are not grouped', async () => {
    const other = await makeUser();
    await mail({ graphId: SEARCH });
    await mail({ graphId: DELTA }, other);
    await mail({ graphId: 'AAMk-a', messageId: null });
    await mail({ graphId: 'AAMk-b', messageId: null });

    expect(await run()).toMatchObject({ groups: 0, removed: 0 });
    expect(await prisma.emailMessage.count()).toBe(4);
  });

  test('the side of a stored row: received, outbound in Sent, outbound elsewhere', () => {
    expect(mailSide({ status: 'received', folder: 'inbox' })).toBe('received');
    expect(mailSide({ status: 'sent', folder: 'sent' })).toBe('sent');
    expect(mailSide({ status: 'sent', folder: 'inbox' })).toBe('other');
    expect(mailSide({ status: 'draft', folder: 'drafts' })).toBe('other');
  });
});

describe('parseDedupeArgs', () => {
  test('no flag or --dry-run is a dry run, --apply applies, anything else is an error', () => {
    expect(parseDedupeArgs([])).toEqual({ apply: false });
    expect(parseDedupeArgs(['--dry-run'])).toEqual({ apply: false });
    expect(parseDedupeArgs(['--apply'])).toEqual({ apply: true });
    expect(parseDedupeArgs(['--aply'])).toHaveProperty('error');
    expect(parseDedupeArgs(['--apply', '--dry-run'])).toHaveProperty('error');
    expect(DEDUPE_USAGE).toMatch(/mail-dedupe/);
  });
});
