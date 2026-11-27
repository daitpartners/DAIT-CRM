import type { FastifyInstance } from 'fastify';
import type { EmailMessage } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import { BULK_MAX } from '@dait-crm/shared';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { encrypt } from '../src/crypto/tokens';
import { startOfDayIn, todayIn } from '../src/leads/dates';
import { listWhere, orderCandidates, type Candidate } from '../src/mail/list';
import { fakeGraph, resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/** Web-mail release 2, Task 7: the list's folders, Leads views, chips, filters, sort and conversation view. */

const BASE = new Date('2026-11-20T10:00:00Z').getTime();
const cand = (c: Partial<Candidate> & { id: number }): Candidate => ({
  userId: 1, threadId: null, occurredAt: new Date(BASE + c.id * 60_000), fromKey: '', leadNumber: null, stageRank: null, sizeBytes: 0, ...c,
});

describe('orderCandidates', () => {
  test('orderCandidates groups by owner and conversation: two mailboxes stay two rows, no thread is its own row (Review Focus 3)', () => {
    const rows = [cand({ id: 5, userId: 1, threadId: 't' }), cand({ id: 4, userId: 2, threadId: 't' }), cand({ id: 3, userId: 1, threadId: 't' }), cand({ id: 2, userId: 1, threadId: null }), cand({ id: 1, userId: 1, threadId: null })];
    expect(orderCandidates(rows, 'date', 'desc', true).map((r) => r.id)).toEqual([5, 4, 2, 1]);
    expect(orderCandidates(rows, 'date', 'desc', false)).toHaveLength(5);
  });

  test('sort by from, lead, stage and size, either direction, missing keys last', () => {
    const rows = [
      cand({ id: 1, fromKey: 'bob', leadNumber: 'LD-1010', stageRank: 3, sizeBytes: 500 }),
      cand({ id: 2, fromKey: 'alice', leadNumber: null, stageRank: null, sizeBytes: 100 }),
      cand({ id: 3, fromKey: 'carol', leadNumber: 'LD-999', stageRank: 1, sizeBytes: 900 }),
      cand({ id: 4, fromKey: 'alice', leadNumber: 'LD-1100', stageRank: 3, sizeBytes: 100 }),
    ];
    const ids = (sort: Parameters<typeof orderCandidates>[1], dir: 'asc' | 'desc') => orderCandidates(rows, sort, dir, false).map((r) => r.id);
    expect(ids('date', 'desc')).toEqual([4, 3, 2, 1]);
    expect(ids('date', 'asc')).toEqual([1, 2, 3, 4]);
    // Ties: newest first, either direction.
    expect(ids('from', 'asc')).toEqual([4, 2, 1, 3]);
    expect(ids('from', 'desc')).toEqual([3, 1, 4, 2]);
    // Lead numbers compare as numbers (LD-999 before LD-1010); no lead is last either way.
    expect(ids('lead', 'asc')).toEqual([3, 1, 4, 2]);
    expect(ids('lead', 'desc')).toEqual([4, 1, 3, 2]);
    expect(ids('stage', 'asc')).toEqual([3, 4, 1, 2]);
    expect(ids('stage', 'desc')).toEqual([4, 1, 3, 2]);
    expect(ids('size', 'asc')).toEqual([4, 2, 1, 3]);
    expect(ids('size', 'desc')).toEqual([3, 1, 4, 2]);
    // The input is not reordered in place.
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  test('a conversation row is always its newest message, whatever the sort and direction; rows are then sorted by the key (R2 T7 ruling)', () => {
    const rows = [cand({ id: 1, threadId: 't', sizeBytes: 900 }), cand({ id: 2, threadId: 't', sizeBytes: 100 }), cand({ id: 3, sizeBytes: 500 })];
    const ids = (sort: Parameters<typeof orderCandidates>[1], dir: 'asc' | 'desc') => orderCandidates(rows, sort, dir, true).map((r) => r.id);
    // Message 2 is the newest of conversation t (message 1 is older and larger).
    expect(ids('size', 'desc')).toEqual([3, 2]);
    expect(ids('size', 'asc')).toEqual([2, 3]);
    expect(ids('date', 'asc')).toEqual([2, 3]);
    expect(ids('date', 'desc')).toEqual([3, 2]);
  });
});

describe('listWhere date filter', () => {
  test("today is the viewer's local day: an Asia/Kolkata user at 23:30 UTC is already on the next day", async () => {
    const user = { id: 1, email: 'a@b.c', name: 'A', role: 'Sales Representative', language: 'en', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY' } as never;
    const where = await listWhere(user, { where: { userId: 1 }, ownerId: 1 }, { page: 1, pageSize: 50, date: 'today' }, new Date('2026-11-27T23:30:00Z'));
    expect(JSON.stringify(where)).toContain(JSON.stringify({ occurredAt: { gte: new Date('2026-11-27T18:30:00.000Z') } }));
    const week = await listWhere(user, { where: { userId: 1 }, ownerId: 1 }, { page: 1, pageSize: 50, date: '7d' }, new Date('2026-11-27T23:30:00Z'));
    expect(JSON.stringify(week)).toContain(JSON.stringify({ occurredAt: { gte: new Date('2026-11-21T18:30:00.000Z') } }));
  });
});

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

const call = (url: string, cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
const personal = (userId: number, address: string) =>
  prisma.emailAccount.create({ data: { address, provider: 'microsoft', kind: 'personal', userId, refreshTokenEnc: encrypt('rt'), status: 'connected' } });

let n = 0;
async function msg(userId: number, data: Partial<EmailMessage> = {}) {
  n += 1;
  return prisma.emailMessage.create({
    data: {
      userId, folder: 'inbox', status: 'received', source: 'sync', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz',
      toAddresses: ['maya@daitpartners.com'], subject: 'Proposal', bodyText: 'Looks good', graphId: `g-${n}`,
      threadId: null, isRead: true, occurredAt: new Date('2026-11-20T10:00:00Z'),
      ...(data as object),
    },
  });
}

async function setup() {
  const rep = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Maya Pillai' });
  const carlos = await makeUser({ role: 'SALES_REPRESENTATIVE', name: 'Carlos Mendez' });
  const admin = await makeUser({ role: 'ADMINISTRATOR', name: 'Deepak Singh' });
  await makeUser({ role: 'MANAGER', name: 'Zed Former', isActive: false });
  const acme = await makeCompany({ name: 'Acme', website: 'https://acme.com' });
  const beta = await makeCompany({ name: 'Beta Labs', website: 'https://beta.io' });
  const ana = await makeContact({ companyId: acme.id, firstName: 'Ana', lastName: 'Ruiz', businessEmail: 'ana@acme.com' });
  const leadA = await makeLead({ companyId: acme.id, companyName: 'Acme', contactId: ana.id, assignedToId: rep.id, status: 'Contacted' });
  const leadB = await makeLead({ companyId: beta.id, companyName: 'Beta Labs', assignedToId: carlos.id, status: 'Qualified' });
  await personal(rep.id, 'maya@daitpartners.com');
  await personal(carlos.id, 'carlos@daitpartners.com');
  const repCookie = await signIn(app, rep);
  return { rep, carlos, admin, acme, beta, ana, leadA, leadB, repCookie };
}

type Item = Record<string, unknown> & { id: number; subject: string };
const items = async (url: string, cookie: string): Promise<Item[]> => {
  const res = await call(url, cookie);
  expect(res.statusCode).toBe(200);
  return res.json().items as Item[];
};
const subjects = async (url: string, cookie: string) => (await items(url, cookie)).map((i) => i.subject);

/** One conversation of three (two received, your reply between them) and a lone message, in Maya's mailbox. */
async function conversation(f: Awaited<ReturnType<typeof setup>>) {
  const first = await msg(f.rep.id, { subject: 'Proposal', threadId: 'p', leadId: f.leadA.id, companyId: f.acme.id, occurredAt: new Date('2026-11-20T10:00:00Z') });
  const reply = await msg(f.rep.id, {
    subject: 'Re: Proposal', threadId: 'p', folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com', fromName: 'Maya Pillai',
    toAddresses: ['ana@acme.com'], leadId: f.leadA.id, companyId: f.acme.id, occurredAt: new Date('2026-11-20T11:00:00Z'),
  });
  const latest = await msg(f.rep.id, { subject: 'Re: Proposal', threadId: 'p', leadId: f.leadA.id, companyId: f.acme.id, isRead: false, occurredAt: new Date('2026-11-20T12:00:00Z') });
  const lone = await msg(f.rep.id, { subject: 'Hello', fromAddress: 'zoe@zeta.com', fromName: 'Zoe', occurredAt: new Date('2026-11-20T09:00:00Z') });
  return { first, reply, latest, lone };
}

describe('GET /mail (web-mail release 2)', () => {
  it('conversation view: one row per conversation, the newest, with its count; total counts rows (Review Focus 3)', async () => {
    const f = await setup();
    const c = await conversation(f);
    const repCookie = f.repCookie;
    const body = (await call('/api/mail?view=inbox', repCookie)).json();
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({ subject: 'Re: Proposal', conversationCount: 3 });
    expect((await call('/api/mail?view=inbox&conv=0', repCookie)).json().total).toBe(3);
    // The row acts on the conversation's messages in this view (F24): the two received ones, not your sent reply.
    expect(body.items[0]).toMatchObject({ id: c.latest.id, conversationIds: [c.latest.id, c.first.id] });
    expect(body.items[1]).toMatchObject({ id: c.lone.id, conversationCount: 1, conversationIds: [c.lone.id] });
    // Paging counts rows: page 2 of size 1 is the lone message, page 3 is empty.
    const p2 = (await call('/api/mail?view=inbox&pageSize=1&page=2', repCookie)).json();
    expect([p2.total, p2.items.map((i: Item) => i.id)]).toEqual([2, [c.lone.id]]);
    expect((await call('/api/mail?view=inbox&pageSize=1&page=3', repCookie)).json().items).toEqual([]);
    // Oldest first or by size: the conversation's row is still its newest message.
    expect((await items('/api/mail?view=inbox&sort=date&dir=asc', repCookie)).map((i) => i.id)).toEqual([c.lone.id, c.latest.id]);
    await prisma.emailMessage.update({ where: { id: c.first.id }, data: { sizeBytes: 9000 } });
    expect((await items('/api/mail?view=inbox&sort=size&dir=desc', repCookie)).map((i) => i.id)).toEqual([c.latest.id, c.lone.id]);
    // count=0 (later batches): no total.
    expect((await call('/api/mail?view=inbox&count=0', repCookie)).json().total).toBeNull();
    // Message view: each message its own row, with its own id only.
    const flat = await items('/api/mail?view=inbox&conv=0', repCookie);
    expect(flat.map((i) => i.id)).toEqual([c.latest.id, c.first.id, c.lone.id]);
    expect(flat[1]).toMatchObject({ conversationCount: 3, conversationIds: [c.first.id] });
  });

  it('conversation ids are at most BULK_MAX', async () => {
    const f = await setup();
    for (let i = 0; i < BULK_MAX + 2; i += 1) await msg(f.rep.id, { threadId: 'big', occurredAt: new Date(BASE + i * 60_000) });
    const [row] = await items('/api/mail?view=inbox', f.repCookie);
    expect(row!.conversationCount).toBe(BULK_MAX + 2);
    expect((row!.conversationIds as number[]).length).toBe(BULK_MAX);
  });

  it('team view (Everyone): the same conversation in two mailboxes is two rows, each with its owner', async () => {
    const f = await setup();
    await conversation(f);
    await msg(f.carlos.id, { subject: 'Re: Proposal', threadId: 'p', leadId: f.leadA.id, companyId: f.acme.id, occurredAt: new Date('2026-11-20T11:30:00Z') });
    await msg(f.carlos.id, { subject: 'Proposal', threadId: 'p', leadId: f.leadA.id, companyId: f.acme.id, occurredAt: new Date('2026-11-20T10:00:00Z') });
    // Carlos's draft and unlinked mail stay out of team view.
    await msg(f.carlos.id, { subject: 'Draft', folder: 'drafts', status: 'draft', leadId: f.leadB.id });
    await msg(f.carlos.id, { subject: 'Personal', fromAddress: 'mum@gmail.com' });
    const body = (await call('/api/mail?mailOf=all&view=inbox', await signIn(app, f.admin))).json();
    expect(body.items.map((i: Item & { owner: { name: string }; conversationCount: number }) => [i.subject, i.owner.name, i.conversationCount])).toEqual([
      ['Re: Proposal', 'Maya Pillai', 3], ['Re: Proposal', 'Carlos Mendez', 2],
    ]);
    expect(body.total).toBe(2);
    expect((await call('/api/mail?mailOf=all&view=drafts', await signIn(app, f.admin))).json().items).toEqual([]);
  });

  it('chips Unread, Flagged and Attachments narrow the list', async () => {
    const f = await setup();
    await msg(f.rep.id, { subject: 'Unread', isRead: false });
    await msg(f.rep.id, { subject: 'Flagged', flagStatus: 'flagged' });
    await msg(f.rep.id, { subject: 'Done flag', flagStatus: 'complete' });
    await msg(f.rep.id, { subject: 'Files', attachmentNames: ['a.pdf'] });
    const c = f.repCookie;
    expect((await subjects('/api/mail?view=inbox&conv=0', c)).sort()).toEqual(['Done flag', 'Files', 'Flagged', 'Unread']);
    expect(await subjects('/api/mail?view=inbox&chip=unread', c)).toEqual(['Unread']);
    expect(await subjects('/api/mail?view=inbox&chip=flagged', c)).toEqual(['Flagged']);
    expect(await subjects('/api/mail?view=inbox&chip=attachments', c)).toEqual(['Files']);
    expect(await subjects('/api/mail?view=inbox&attachments=1', c)).toEqual(['Files']);
    expect((await subjects('/api/mail?view=inbox&chip=all', c))).toHaveLength(4);
  });

  it('filters From, To, Subject, Lead (number or company), Owner (lead owner) and Date (today in the user zone), with Has attachments', async () => {
    const f = await setup();
    await prisma.user.update({ where: { id: f.rep.id }, data: { timezone: 'Asia/Kolkata' } });
    const start = startOfDayIn(todayIn('Asia/Kolkata'), 'Asia/Kolkata');
    await msg(f.rep.id, { subject: 'Plan 50%_off', fromName: 'Maria Gómez', fromAddress: 'maria@acme.com', toAddresses: ['maya@daitpartners.com', 'sales@dait.com'], leadId: f.leadA.id, occurredAt: start, attachmentNames: ['x.pdf'] });
    await msg(f.rep.id, { subject: 'Yesterday news', fromName: 'Bob', fromAddress: 'bob@beta.io', leadId: f.leadB.id, occurredAt: new Date(start.getTime() - 60_000) });
    await msg(f.rep.id, { subject: 'Plain', fromName: null, fromAddress: 'zoe@zeta.com', occurredAt: new Date(start.getTime() - 86_400_000 - 60_000) });
    const c = await signIn(app, f.rep);
    const q = (s: string) => subjects(`/api/mail?view=inbox&${s}`, c);
    expect(await q('from=MARIA')).toEqual(['Plan 50%_off']);
    expect(await q('from=zeta')).toEqual(['Plain']);
    expect(await q('to=sales@')).toEqual(['Plan 50%_off']);
    expect(await q('subject=news')).toEqual(['Yesterday news']);
    // ILIKE wildcards are matched literally.
    expect(await q('subject=%25_')).toEqual(['Plan 50%_off']);
    expect(await q('subject=_')).toEqual(['Plan 50%_off']);
    expect(await q(`leadQ=${f.leadA.number}`)).toEqual(['Plan 50%_off']);
    expect(await q('leadQ=acm')).toEqual(['Plan 50%_off']);
    // Carlos's lead: its number finds it, its company name does not (Maya cannot see that lead).
    expect(await q(`leadQ=${f.leadB.number}`)).toEqual(['Yesterday news']);
    expect(await q('leadQ=beta')).toEqual([]);
    expect(await q('owner=me')).toEqual(['Plan 50%_off']);
    // Carlos's lead is hidden from Maya: its owner never filters her mail (no restricted-lead leak).
    expect(await q(`owner=${f.carlos.id}`)).toEqual([]);
    // An Administrator, who sees the lead, finds Maya's mail on it by its owner.
    expect(await subjects(`/api/mail?mailOf=all&view=inbox&owner=${f.carlos.id}`, await signIn(app, f.admin))).toEqual(['Yesterday news']);
    expect(await q('date=today')).toEqual(['Plan 50%_off']);
    expect(await q('date=7d')).toEqual(['Plan 50%_off', 'Yesterday news', 'Plain']);
    const today = todayIn('Asia/Kolkata');
    const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    expect(await q(`date=custom&since=${yesterday}&until=${yesterday}`)).toEqual(['Yesterday news']);
    expect(await q(`date=custom&since=${yesterday}`)).toEqual(['Plan 50%_off', 'Yesterday news']);
    expect(await q('from=a&attachments=1')).toEqual(['Plan 50%_off']);
  });

  it('views Scheduled, Flagged, Follow-up due today and My leads / Team leads', async () => {
    const f = await setup();
    const today = todayIn('Europe/London');
    await prisma.lead.update({ where: { id: f.leadA.id }, data: { nextFollowUp: new Date(`${today}T00:00:00Z`) } });
    const closed = await makeLead({ companyId: f.acme.id, assignedToId: f.rep.id, status: 'Won', nextFollowUp: new Date('2026-01-01T00:00:00Z') });
    // Carlos's lead is due too, but hidden from Maya: her mail on it is not "due" for her.
    await prisma.lead.update({ where: { id: f.leadB.id }, data: { nextFollowUp: new Date(`${today}T00:00:00Z`) } });
    const later = await makeLead({ companyId: f.acme.id, assignedToId: f.rep.id, status: 'New', nextFollowUp: new Date('2099-01-01T00:00:00Z') });
    const sent = { folder: 'sent', status: 'sent', fromAddress: 'maya@daitpartners.com' } as const;
    await msg(f.rep.id, { ...sent, subject: 'Queued', source: 'crm', status: 'queued' });
    await msg(f.rep.id, { ...sent, subject: 'Sending', source: 'crm', status: 'sending' });
    await msg(f.rep.id, { ...sent, subject: 'Synced sent' });
    await msg(f.rep.id, { subject: 'Flag', flagStatus: 'flagged', leadId: f.leadA.id });
    await msg(f.rep.id, { subject: 'Flag binned', flagStatus: 'flagged', folder: 'deleted', leadId: f.leadA.id });
    await msg(f.rep.id, { subject: 'Draft on lead', folder: 'drafts', status: 'draft', leadId: f.leadA.id });
    await msg(f.rep.id, { subject: 'Closed lead', leadId: closed.id });
    await msg(f.rep.id, { subject: 'Later lead', leadId: later.id });
    await msg(f.rep.id, { subject: 'Carlos lead', leadId: f.leadB.id });
    await msg(f.carlos.id, { subject: 'Carlos own', leadId: f.leadB.id });
    const c = f.repCookie;
    const v = (view: string, extra = '') => subjects(`/api/mail?view=${view}&conv=0${extra}`, c);
    expect((await v('scheduled')).sort()).toEqual(['Queued', 'Sending']);
    expect(await v('flagged')).toEqual(['Flag']);
    expect(await v('due')).toEqual(['Flag']);
    expect((await v('mine')).sort()).toEqual(['Closed lead', 'Flag', 'Later lead']);
    // Team leads: any lead mail in the team scope (not drafts or deleted).
    const admin = await signIn(app, f.admin);
    expect((await subjects('/api/mail?mailOf=all&view=due&conv=0', admin)).sort()).toEqual(['Carlos lead', 'Carlos own', 'Flag']);
    const team = await subjects('/api/mail?mailOf=all&view=mine&conv=0', admin);
    expect(team.sort()).toEqual(['Carlos lead', 'Carlos own', 'Closed lead', 'Flag', 'Later lead']);
    // Mail of the Administrator's own id is their own scope: My leads (none assigned to them).
    expect(await subjects(`/api/mail?mailOf=${f.admin.id}&view=mine`, admin)).toEqual([]);
  });

  it('items carry replied, flag, conversation count and lead status; restricted leads give no status', async () => {
    const f = await setup();
    const c = await conversation(f);
    await prisma.emailMessage.update({ where: { id: c.latest.id }, data: { flagStatus: 'flagged', flagDue: new Date('2026-11-28T00:00:00Z') } });
    const other = await msg(f.rep.id, { subject: 'Other owner', leadId: f.leadB.id, occurredAt: new Date('2026-11-19T10:00:00Z') });
    const flat = await items('/api/mail?view=inbox&conv=0', f.repCookie);
    const by = (id: number) => flat.find((i) => i.id === id)!;
    expect(by(c.first.id)).toMatchObject({ replied: true, flagStatus: 'notFlagged', flagDue: null, conversationCount: 3, leadStatus: 'Contacted' });
    expect(by(c.latest.id)).toMatchObject({ replied: false, flagStatus: 'flagged', flagDue: '2026-11-28', conversationCount: 3, leadStatus: 'Contacted' });
    expect(by(c.lone.id)).toMatchObject({ replied: false, conversationCount: 1, leadStatus: null });
    expect(by(other.id)).toMatchObject({ leadRestricted: true, leadNumber: f.leadB.number, leadStatus: null, leadId: null });
  });

  it('sort by from, lead, stage and size through the API, with direction and conversation grouping', async () => {
    const f = await setup();
    const a = await msg(f.rep.id, { subject: 'A', fromName: 'Bea', leadId: f.leadA.id, sizeBytes: 300, occurredAt: new Date('2026-11-20T10:00:00Z') });
    const b = await msg(f.rep.id, { subject: 'B', fromName: 'Ann', sizeBytes: 900, occurredAt: new Date('2026-11-20T11:00:00Z') });
    const lead = await makeLead({ companyId: f.acme.id, assignedToId: f.rep.id, status: 'Won' });
    const d = await msg(f.rep.id, { subject: 'D', fromName: 'Cid', leadId: lead.id, sizeBytes: 100, occurredAt: new Date('2026-11-20T12:00:00Z') });
    const c = f.repCookie;
    const ids = async (s: string) => (await items(`/api/mail?view=inbox&${s}`, c)).map((i) => i.id);
    expect(await ids('sort=from&dir=asc')).toEqual([b.id, a.id, d.id]);
    expect(await ids('sort=size&dir=desc')).toEqual([b.id, a.id, d.id]);
    expect(await ids('sort=lead&dir=asc')).toEqual([a.id, d.id, b.id]);
    // Stage in the lead_status order: Contacted before Won; no lead last.
    expect(await ids('sort=stage&dir=asc')).toEqual([a.id, d.id, b.id]);
    expect(await ids('sort=stage&dir=desc')).toEqual([d.id, a.id, b.id]);
    expect(await ids('sort=date&dir=asc&conv=0')).toEqual([a.id, b.id, d.id]);
    expect(await ids('sort=date&dir=asc')).toEqual([a.id, b.id, d.id]);
  });

  it('meta: counts per folder and Leads group, lead owners; no unlinked', async () => {
    const f = await setup();
    const today = todayIn('Europe/London');
    await prisma.lead.update({ where: { id: f.leadA.id }, data: { nextFollowUp: new Date(`${today}T00:00:00Z`) } });
    const leadC = await makeLead({ companyId: f.acme.id, assignedToId: f.rep.id, status: 'New' });
    await msg(f.rep.id, { subject: 'Unread', isRead: false, leadId: f.leadA.id });
    await msg(f.rep.id, { subject: 'Read', leadId: leadC.id, flagStatus: 'flagged' });
    await msg(f.rep.id, { subject: 'Draft', folder: 'drafts', status: 'draft' });
    await msg(f.rep.id, { subject: 'Queued', folder: 'sent', status: 'queued', source: 'crm', fromAddress: 'maya@daitpartners.com', leadId: f.leadA.id, threadId: 'q' });
    await msg(f.carlos.id, { subject: 'Not mine', isRead: false, leadId: f.leadB.id });
    // Maya's mail on Carlos's due lead, which she cannot see: not counted as due for her.
    await prisma.lead.update({ where: { id: f.leadB.id }, data: { nextFollowUp: new Date(`${today}T00:00:00Z`) } });
    await msg(f.rep.id, { subject: 'On hidden lead', leadId: f.leadB.id });
    const meta = (await call('/api/mail/meta', f.repCookie)).json();
    expect(meta.counts).toEqual({ inbox: 1, drafts: 1, scheduled: 1, flagged: 1, awaiting: 1, due: 1, leads: 2 });
    expect(meta).not.toHaveProperty('unlinked');
    expect(meta.unread).toBe(1);
    expect(meta.leadOwners).toEqual([
      { id: f.carlos.id, name: 'Carlos Mendez' }, { id: f.admin.id, name: 'Deepak Singh' }, { id: f.rep.id, name: 'Maya Pillai' },
    ]);
    // Team scope: Team leads counts every lead with mail in it.
    const all = (await call('/api/mail/meta?mailOf=all', await signIn(app, f.admin))).json();
    expect(all.counts).toMatchObject({ inbox: 2, drafts: 0, due: 2, leads: 3 });
  });

  it('?view=unlinked falls back to Inbox', async () => {
    const f = await setup();
    await msg(f.rep.id, { subject: 'In inbox' });
    await msg(f.rep.id, { subject: 'Archived', folder: 'archive' });
    expect(await subjects('/api/mail?view=unlinked', f.repCookie)).toEqual(['In inbox']);
    expect(await subjects('/api/mail?view=nonsense', f.repCookie)).toEqual(['In inbox']);
  });
});
