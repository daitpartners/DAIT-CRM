import { beforeEach, describe, expect, test } from 'vitest';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import {
  OWN_MAIL_DOMAINS, inLeadConversation, isExcludedDomain, isLeadMail, loadLeadMailRules, normaliseAddress, participantsOf,
} from '../src/mail/leadMail';
import { resetDb } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser } from './factory';

beforeEach(resetDb);

async function mailbox(userId: number, address: string, sendAs: string | null = null) {
  await prisma.emailAccount.create({
    data: { address, sendAs, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' },
  });
}

describe('lead-mail rules (web-mail release 1)', () => {
  test('an address on a lead or a contact counts, whatever its case or spaces (Review Focus 2)', async () => {
    await makeLead({ businessEmail: '  Ana@ACME.com ' });
    const solo = await makeCompany({ name: 'Solo' });
    await makeContact({ companyId: solo.id, businessEmail: ' Bo@Solo.IO' });
    const rules = await loadLeadMailRules(prisma);
    expect(isLeadMail(rules, participantsOf({ from: 'ana@acme.com', to: [], cc: [], bcc: [] }))).toBe(true);
    expect(isLeadMail(rules, participantsOf({ from: null, to: [], cc: [' BO@solo.io '], bcc: [] }))).toBe(true);
    expect(isLeadMail(rules, ['bo@solo.io'])).toBe(true);
  });

  test("a lead company's own domain counts (website, or its lead/contact addresses), archived and closed leads included", async () => {
    const acme = await makeCompany({ website: 'https://www.acme.com/about' });
    await makeLead({ companyId: acme.id });
    const noSite = await makeCompany({ name: 'No Site' });
    await makeLead({ companyId: noSite.id, businessEmail: 'j@nosite.co' });
    const archived = await makeCompany({ website: 'archived-co.com' });
    await makeLead({ companyId: archived.id, archivedAt: new Date(), status: 'Lost' });
    const closed = await makeCompany({ name: 'Closed' });
    await makeLead({ companyId: closed.id, status: 'Won' });
    await makeContact({ companyId: closed.id, businessEmail: 'kim@closed-co.org' });
    const rules = await loadLeadMailRules(prisma);
    expect(isLeadMail(rules, ['colleague@acme.com'])).toBe(true); // via website
    expect(isLeadMail(rules, ['x@nosite.co'])).toBe(true); // company without website, lead address j@nosite.co
    expect(isLeadMail(rules, ['y@archived-co.com'])).toBe(true);
    expect(isLeadMail(rules, ['z@closed-co.org'])).toBe(true); // via a contact of a closed lead's company
    expect(isLeadMail(rules, ['x@unknown.com'])).toBe(false);
  });

  test('a company with no lead lends no domain; its contacts count only by exact address', async () => {
    const solo = await makeCompany({ website: 'https://solo.io' });
    await makeContact({ companyId: solo.id, businessEmail: 'bo@solo.io' });
    const rules = await loadLeadMailRules(prisma);
    expect(isLeadMail(rules, ['bo@solo.io'])).toBe(true);
    expect(isLeadMail(rules, ['other@solo.io'])).toBe(false);
  });

  test("free mail, shared hosts, daitpartners.com and connected mailboxes' domains never count (Review Focus 1)", async () => {
    const acme = await makeCompany({ website: 'https://acme.com' });
    await makeLead({ companyId: acme.id, businessEmail: 'Lead.Person@gmail.com' });
    await makeContact({ companyId: acme.id, businessEmail: 'pat@acme.com' });
    const wix = await makeCompany({ website: 'https://acme.wixsite.com/x' });
    await makeLead({ companyId: wix.id, businessEmail: 'owner@wixsite.com' });
    const fb = await makeCompany({ website: 'https://facebook.com/acmepage' });
    await makeLead({ companyId: fb.id });
    // A test lead holding colleagues' addresses must not pull in internal mail (F18).
    await makeLead({ companyId: null, businessEmail: 'deepak@daitpartners.com' });
    await makeLead({ companyId: null, businessEmail: 'ops@dait.example' });
    const maya = await makeUser();
    await mailbox(maya.id, 'maya@daitpartners.com', 'info@dait.example');
    const rules = await loadLeadMailRules(prisma);
    expect(isLeadMail(rules, ['someone@gmail.com'])).toBe(false);
    expect(isLeadMail(rules, ['lead.person@gmail.com'])).toBe(true); // the exact free-mail address of a lead
    expect(isLeadMail(rules, ['someone@wixsite.com'])).toBe(false);
    expect(isLeadMail(rules, ['someone@acme.wixsite.com'])).toBe(false);
    expect(isLeadMail(rules, ['someone@facebook.com'])).toBe(false);
    expect(isLeadMail(rules, ['deepak@daitpartners.com'])).toBe(false);
    expect(isLeadMail(rules, ['ops@dait.example'])).toBe(false);
    expect(isLeadMail(rules, ['someone@gmail.com', 'pat@acme.com'])).toBe(true); // any participant
    expect(isLeadMail(rules, [])).toBe(false);
    for (const d of rules.domains) expect(isExcludedDomain(d, ['dait.example'])).toBe(false);
  });

  test("inLeadConversation: only the same user's lead-linked row in that conversation", async () => {
    const rep = await makeUser();
    const other = await makeUser();
    const lead = await makeLead({ assignedToId: rep.id });
    const base = { folder: 'inbox', status: 'received', fromAddress: 'x@y.com', subject: 's' };
    await prisma.emailMessage.create({ data: { ...base, userId: rep.id, threadId: 'conv-1', leadId: lead.id } });
    await prisma.emailMessage.create({ data: { ...base, userId: other.id, threadId: 'conv-1' } });
    await prisma.emailMessage.create({ data: { ...base, userId: rep.id, threadId: 'conv-2', companyId: lead.companyId } });
    expect(await inLeadConversation(prisma, rep.id, 'conv-1')).toBe(true);
    expect(await inLeadConversation(prisma, other.id, 'conv-1')).toBe(false);
    expect(await inLeadConversation(prisma, rep.id, 'conv-2')).toBe(false); // linked to a company only
    expect(await inLeadConversation(prisma, rep.id, null)).toBe(false);
  });
});

describe('address helpers', () => {
  test('participantsOf trims, lower-cases, de-duplicates and drops empty addresses', () => {
    expect(participantsOf({ from: ' Ana@ACME.com', to: ['ana@acme.com', ' '], cc: ['Bo@x.io'], bcc: ['c@y.org', ''] }))
      .toEqual(['ana@acme.com', 'bo@x.io', 'c@y.org']);
    expect(participantsOf({ from: null, to: [], cc: [], bcc: [] })).toEqual([]);
  });

  test('normaliseAddress and isExcludedDomain', () => {
    expect(normaliseAddress('  Ana@ACME.com ')).toBe('ana@acme.com');
    expect(normaliseAddress(null)).toBe('');
    expect(OWN_MAIL_DOMAINS).toEqual(['daitpartners.com']);
    expect(isExcludedDomain('hotmail.es', [])).toBe(true);
    expect(isExcludedDomain('shop.myshopify.com', [])).toBe(true);
    expect(isExcludedDomain('DaitPartners.com', [])).toBe(true);
    expect(isExcludedDomain('dait.example', ['dait.example'])).toBe(true);
    expect(isExcludedDomain('acme.com', ['dait.example'])).toBe(false);
  });
});
