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

describe('matching synced mail to CRM records (2B-2)', () => {
  test('a message in a conversation the user already linked takes its links', async () => {
    const user = await rep();
    const lead = await makeLead({ assignedToId: user.id });
    await prisma.emailMessage.create({
      data: { userId: user.id, folder: 'sent', status: 'sent', fromAddress: own, subject: 's', threadId: 'conv-1', leadId: lead.id, companyId: lead.companyId },
    });
    expect(await matchMail(prisma, user, { threadId: 'conv-1', counterparts: ['someone@gmail.com'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: null, companyId: lead.companyId });
  });

  test("a contact's email links the contact, company and their open lead, the user's own first", async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
    await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: null, status: 'Won' });
    await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: null });
    const mine = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: user.id });
    await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: other.id });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['ANA@Acme.com'], ownAddress: own }))
      .toEqual({ leadId: mine.id, contactId: contact.id, companyId: company.id });
  });

  test("a contact with no open lead of their own falls back to the company's open lead", async () => {
    const user = await rep();
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
    const lead = await makeLead({ companyId: company.id, contactId: null, assignedToId: user.id });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['ana@acme.com'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: contact.id, companyId: company.id });
  });

  test('a company domain links the company and its open lead only when there is exactly one', async () => {
    const user = await rep();
    const company = await makeCompany({ website: 'https://www.globex.com' });
    const lead = await makeLead({ companyId: company.id, assignedToId: user.id });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['new.person@globex.com'], ownAddress: own }))
      .toEqual({ leadId: lead.id, contactId: null, companyId: company.id });
    await makeLead({ companyId: company.id, assignedToId: user.id });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['new.person@globex.com'], ownAddress: own }))
      .toEqual({ leadId: null, contactId: null, companyId: company.id });
  });

  test('free mail and the mailbox’s own domain never match a company', async () => {
    const user = await rep();
    await makeCompany({ website: 'https://gmail.com' });
    await makeCompany({ website: 'https://daitpartners.com' });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['x@gmail.com', 'deepak@daitpartners.com'], ownAddress: own }))
      .toEqual({ leadId: null, contactId: null, companyId: null });
  });

  test("a lead the user cannot see is never linked (the contact and company still are)", async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
    await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: other.id });
    expect(await matchMail(prisma, user, { threadId: null, counterparts: ['ana@acme.com'], ownAddress: own }))
      .toEqual({ leadId: null, contactId: contact.id, companyId: company.id });
  });

  test('thread link to a lead the user cannot see keeps company and contact but no lead', async () => {
    const user = await rep();
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany({ website: 'https://acme.com' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'ana@acme.com' });
    const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: user.id });
    await prisma.emailMessage.create({
      data: { userId: user.id, folder: 'sent', status: 'sent', fromAddress: own, subject: 's', threadId: 'conv-3', leadId: lead.id, contactId: contact.id, companyId: company.id },
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: other.id } });
    expect(await matchMail(prisma, user, { threadId: 'conv-3', counterparts: [], ownAddress: own }))
      .toEqual({ leadId: null, contactId: contact.id, companyId: company.id });
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
