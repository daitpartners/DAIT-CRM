import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '../src/db';
import { mailUser, matchMail } from '../src/mail/match';
import { resetDb } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser } from './factory';

beforeEach(resetDb);

const own = 'maya@daitpartners.com';

async function rep() {
  const u = await makeUser({ role: 'SALES_REPRESENTATIVE' });
  return (await mailUser(prisma, u.id))!;
}

/** Sets a lead's updatedAt (Prisma's @updatedAt would overwrite it through the client). */
async function touch(leadId: number, at: string) {
  await prisma.$executeRaw`UPDATE leads SET updated_at = ${new Date(at)} WHERE id = ${leadId}`;
}

describe('matching synced mail to CRM records (web-mail release 1: lead visibility ignored)', () => {
  test('a message in a conversation the user already linked takes its links', async () => {
    const user = await rep();
    const lead = await makeLead({ assignedToId: user.id });
    await prisma.emailMessage.create({
      data: { userId: user.id, folder: 'sent', status: 'sent', fromAddress: own, subject: 's', threadId: 'conv-1', leadId: lead.id, companyId: lead.companyId },
    });
    expect(await matchMail(prisma, user, { threadId: 'conv-1', counterparts: ['someone@gmail.com'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: null, companyId: lead.companyId });
  });

  test("a lead's own email links that lead even when the user cannot see it", async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'someone.else@acme.com' });
    const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: other.id, businessEmail: 'Ana@Acme.com' });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['ana@acme.com'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: contact.id, companyId: company.id });
  });

  test('a stored or incoming address with spaces still matches (trimmed, any case)', async () => {
    const user = await rep();
    const lead = await makeLead({ companyId: null, businessEmail: '  Ana@Gmail.com ' });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: [' ANA@gmail.com  '], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: null, companyId: null });
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: ' Bo@Acme.com  ' });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['bo@acme.com'], ownAddress: own }))
      .toEqual({ leadId: null, contactId: contact.id, companyId: company.id });
  });

  test('several leads match: an open one before a closed or archived one, then the most recently updated', async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: 'https://acme.com' });
    const openOlder = await makeLead({ companyId: company.id, assignedToId: user.id });
    const openNewer = await makeLead({ companyId: company.id, assignedToId: other.id });
    const closed = await makeLead({ companyId: company.id, assignedToId: user.id, status: 'Won' });
    const archived = await makeLead({ companyId: company.id, assignedToId: user.id, archivedAt: new Date() });
    await touch(openOlder.id, '2026-01-01T00:00:00Z');
    await touch(openNewer.id, '2026-03-01T00:00:00Z');
    await touch(closed.id, '2026-06-01T00:00:00Z');
    await touch(archived.id, '2026-06-02T00:00:00Z');
    const links = await matchMail(prisma, user, { threadId: null, counterparts: ['new.person@acme.com'], ownAddress: own });
    expect(links.leadId).toBe(openNewer.id);
  });

  test('only closed or archived leads: the most recently updated is still linked', async () => {
    const user = await rep();
    const company = await makeCompany({ website: 'https://acme.com' });
    const closed = await makeLead({ companyId: company.id, status: 'Lost' });
    const archived = await makeLead({ companyId: company.id, archivedAt: new Date() });
    await touch(closed.id, '2026-05-01T00:00:00Z');
    await touch(archived.id, '2026-02-01T00:00:00Z');
    const links = await matchMail(prisma, user, { threadId: null, counterparts: ['x@acme.com'], ownAddress: own });
    expect(links.leadId).toBe(closed.id);
  });

  test("a contact's email links the contact, the company and the contact's lead, else the company's", async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
    const companyLead = await makeLead({ companyId: company.id, contactId: null, assignedToId: other.id });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['ANA@Acme.com'], ownAddress: own }))
      .toEqual({ leadId: companyLead.id, contactId: contact.id, companyId: company.id });
    const contactLead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: other.id, status: 'Lost' });
    await touch(companyLead.id, '2026-09-01T00:00:00Z');
    await touch(contactLead.id, '2026-01-01T00:00:00Z');
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['ana@acme.com'], ownAddress: own }))
      .toEqual({ leadId: contactLead.id, contactId: contact.id, companyId: company.id });
  });

  test('a company domain links the company and its lead (several: open, then most recent)', async () => {
    const user = await rep();
    const company = await makeCompany({ website: 'https://www.globex.com' });
    const first = await makeLead({ companyId: company.id, assignedToId: null });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['new.person@globex.com'], ownAddress: own }))
      .toEqual({ leadId: first.id, contactId: null, companyId: company.id });
    const second = await makeLead({ companyId: company.id, assignedToId: null });
    await touch(first.id, '2026-01-01T00:00:00Z');
    await touch(second.id, '2026-02-01T00:00:00Z');
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['new.person@globex.com'], ownAddress: own }))
      .toEqual({ leadId: second.id, contactId: null, companyId: company.id });
  });

  test('a domain known only from a lead address (company without website) links that company and lead', async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: null });
    const lead = await makeLead({ companyId: company.id, assignedToId: other.id, businessEmail: 'boss@initech.com' });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['colleague@initech.com'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: null, companyId: company.id });
  });

  test('a domain known only from the address of a lead without a company links that lead', async () => {
    const user = await rep();
    const lead = await makeLead({ companyId: null, businessEmail: 'boss@hooli.io', assignedToId: null });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['colleague@hooli.io'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: null, companyId: null });
  });

  test("a domain known only from a contact's address links that contact's company and its lead", async () => {
    const user = await rep();
    const company = await makeCompany({ website: null });
    await makeContact({ companyId: company.id, businessEmail: 'ana@umbrella.co' });
    const lead = await makeLead({ companyId: company.id, assignedToId: null });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['colleague@umbrella.co'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: null, companyId: company.id });
  });

  test('free mail, shared hosts, daitpartners.com and the mailbox domain never match a company', async () => {
    const user = await rep();
    await makeCompany({ website: 'https://gmail.com' });
    await makeCompany({ website: 'https://daitpartners.com' });
    await makeCompany({ website: 'https://mybox.example' });
    await makeLead({ companyId: null, businessEmail: 'someone@outlook.com' });
    await makeLead({ companyId: null, businessEmail: 'site@wixsite.com' });
    expect(await matchMail(prisma, user, {
      threadId: null,
      counterparts: ['x@gmail.com', 'other@outlook.com', 'y@wixsite.com', 'deepak@daitpartners.com', 'z@mybox.example'],
      ownAddress: 'me@mybox.example',
    })).toEqual({ leadId: null, contactId: null, companyId: null });
  });

  test("a lead's or contact's address at our own or the mailbox's domain never links (a test lead with a colleague's address)", async () => {
    const user = await rep();
    await makeLead({ companyId: null, businessEmail: 'deepak@daitpartners.com' });
    await makeLead({ companyId: null, businessEmail: ' Colleague@Mail.DaitPartners.com ' });
    const company = await makeCompany({ website: null });
    await makeContact({ companyId: company.id, businessEmail: 'boss@mybox.example' });
    await makeLead({ companyId: company.id });
    expect(await matchMail(prisma, user, {
      threadId: null,
      counterparts: ['deepak@daitpartners.com', 'colleague@mail.daitpartners.com', 'boss@mybox.example'],
      ownAddress: 'me@mybox.example',
    })).toEqual({ leadId: null, contactId: null, companyId: null });
  });

  test('a conversation the user already linked keeps its lead after the lead moved to someone else', async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
    const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: user.id });
    await prisma.emailMessage.create({
      data: { userId: user.id, folder: 'sent', status: 'sent', fromAddress: own, subject: 's', threadId: 'conv-3', leadId: lead.id, contactId: contact.id, companyId: company.id },
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: other.id } });
    const links = await matchMail(prisma, user, { threadId: 'conv-3', counterparts: [], ownAddress: own });
    expect(links).toEqual({ leadId: lead.id, contactId: contact.id, companyId: company.id });
  });

  test('another user’s linked conversation is not used', async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const lead = await makeLead({ assignedToId: null });
    await prisma.emailMessage.create({
      data: { userId: other.id, folder: 'sent', status: 'sent', fromAddress: 'x@daitpartners.com', subject: 's', threadId: 'conv-9', leadId: lead.id },
    });
    expect(await matchMail(prisma, user, { threadId: 'conv-9', counterparts: [], ownAddress: own }))
      .toEqual({ leadId: null, contactId: null, companyId: null });
  });
});
