import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { mailUser } from '../src/mail/match';
import { checkRecipients, fillCompanyTimezones, sendBlock } from '../src/mailer/rules';
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

async function rep() {
  const u = await makeUser({ role: 'SALES_REPRESENTATIVE' });
  return (await mailUser(prisma, u.id))!;
}

describe('who the Mailer may email (release 2C, prototype mailBlock / mailerCheck)', () => {
  it('gives each lead its address, local time zone and the reason it is skipped', async () => {
    const user = await rep();
    const us = await makeCompany({ name: 'Lone Star', country: 'United States' });
    await prisma.company.update({ where: { id: us.id }, data: { state: 'Texas' } });
    const ok = await makeContact({ companyId: us.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@lonestar.com' });
    const good = await makeLead({ companyId: us.id, contactId: ok.id, assignedToId: user.id, companyName: 'Lone Star' });
    const noMail = await makeLead({ companyId: null, contactId: null, assignedToId: user.id, country: 'Chile', businessEmail: null });
    const bad = await makeLead({ companyId: null, contactId: null, assignedToId: user.id, businessEmail: 'not-an-email' });
    const dne = await makeLead({ companyId: null, contactId: null, assignedToId: user.id, businessEmail: 'x@y.com', doNotEmail: true });
    const archived = await makeLead({ companyId: null, contactId: null, assignedToId: user.id, businessEmail: 'a@y.com', archivedAt: new Date() });
    const won = await makeLead({ companyId: null, contactId: null, assignedToId: user.id, businessEmail: 'w@y.com', status: 'Won' });
    const twin = await makeLead({ companyId: us.id, contactId: ok.id, assignedToId: user.id });
    const unsub = await makeContact({ companyId: us.id, businessEmail: 'u@lonestar.com' });
    await prisma.contact.update({ where: { id: unsub.id }, data: { unsubscribedAt: new Date() } });
    const unsubLead = await makeLead({ companyId: us.id, contactId: unsub.id, assignedToId: user.id });
    const hidden = await makeLead({ assignedToId: (await makeUser({ role: 'SALES_REPRESENTATIVE' })).id, businessEmail: 'h@y.com' });

    const rows = await checkRecipients(prisma, user, [good.id, noMail.id, bad.id, dne.id, archived.id, won.id, twin.id, unsubLead.id, hidden.id, 999999]);
    expect(rows[0]).toMatchObject({ leadId: good.id, leadNumber: good.number, contactId: ok.id, to: 'ana@lonestar.com', name: 'Ana Ruiz', company: 'Lone Star', block: null, zones: ['America/Chicago'], source: 'address' });
    expect(rows.slice(1).map((r) => r.block)).toEqual([
      'No email address', 'Invalid email address', 'Marked do not email', 'Lead is archived', 'Lead is closed (Won)',
      'Same address as another selected lead', 'Unsubscribed', 'Lead not available', 'Lead not available',
    ]);
    expect(rows[1]).toMatchObject({ zones: ['America/Santiago'], source: 'country' });
  });

  it('at send time a lead that replied after the campaign was created is skipped', async () => {
    const user = await rep();
    const lead = await makeLead({ companyId: null, contactId: null, assignedToId: user.id, businessEmail: 'r@y.com' });
    const since = new Date(Date.now() - 3600_000);
    expect(await sendBlock(prisma, user, lead.id, since)).toBeNull();
    await prisma.emailMessage.create({ data: { userId: user.id, leadId: lead.id, folder: 'inbox', status: 'received', fromAddress: 'r@y.com', subject: 'Re', occurredAt: new Date() } });
    expect(await sendBlock(prisma, user, lead.id, since)).toBe('Replied before this email was due');
    await prisma.lead.update({ where: { id: lead.id }, data: { status: 'Lost' } });
    expect(await sendBlock(prisma, user, lead.id, since)).toBe('Lead is closed (Lost)');
  });

  it('fills empty company time zones that resolve to exactly one zone, and nothing else', async () => {
    const chile = await makeCompany({ country: 'Chile' });
    const usNoState = await makeCompany({ country: 'United States' });
    const tx = await makeCompany({ country: 'United States' });
    await prisma.company.update({ where: { id: tx.id }, data: { state: 'TX' } });
    const set = await makeCompany({ country: 'Chile' });
    await prisma.company.update({ where: { id: set.id }, data: { timezone: 'Europe/Madrid' } });
    const unknown = await makeCompany({ country: 'Atlantis' });
    expect(await fillCompanyTimezones(prisma)).toBe(2);
    const tz = async (id: number) => (await prisma.company.findUniqueOrThrow({ where: { id } })).timezone;
    expect([await tz(chile.id), await tz(usNoState.id), await tz(tx.id), await tz(set.id), await tz(unknown.id)])
      .toEqual(['America/Santiago', null, 'America/Chicago', 'Europe/Madrid', null]);
  });
});

describe('Do not email on a lead (prototype Edit profile check box)', () => {
  it('marks the lead and its contact, notes it on the history, and can be undone', async () => {
    const u = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const company = await makeCompany();
    const contact = await makeContact({ companyId: company.id, businessEmail: 'c@x.com' });
    const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: u.id });
    const cookie = await signIn(app, u);
    const res = await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/do-not-email`, headers: { cookie }, payload: { doNotEmail: true, updatedAt: lead.updatedAt.toISOString() } });
    expect(res.statusCode).toBe(200);
    expect(res.json().doNotEmail).toBe(true);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).unsubscribedAt).toBeInstanceOf(Date);
    expect(await prisma.leadActivity.findFirst({ where: { leadId: lead.id, title: 'Marked do not email' } })).not.toBeNull();
    const stale = await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/do-not-email`, headers: { cookie }, payload: { doNotEmail: false, updatedAt: lead.updatedAt.toISOString() } });
    expect(stale.statusCode).toBe(409);
    const off = await app.inject({ method: 'POST', url: `/api/leads/${lead.id}/do-not-email`, headers: { cookie }, payload: { doNotEmail: false, updatedAt: res.json().updatedAt } });
    expect(off.json().doNotEmail).toBe(false);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).unsubscribedAt).toBeNull();
    expect(await prisma.leadActivity.findFirst({ where: { leadId: lead.id, title: 'Do not email removed' } })).not.toBeNull();
  });
});
