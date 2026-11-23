import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { encrypt } from '../src/crypto/tokens';
import { todayIn } from '../src/leads/dates';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeLead, makeUser, signIn } from './factory';

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

const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

type RoleKey = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER';
async function as(role: RoleKey, timezone = 'UTC'): Promise<{ user: User; cookie: string }> {
  const made = await makeUser({ role });
  const user = await prisma.user.update({ where: { id: made.id }, data: { timezone } });
  return { user, cookie: await signIn(app, user) };
}

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const shift = (s: string, days: number) => new Date(day(s).getTime() + days * 86_400_000).toISOString().slice(0, 10);

type TaskExtra = Partial<{ leadId: number | null; title: string; isDone: boolean; kind: string; dueTime: string | null; durationMinutes: number | null }>;
const task = (assignedToId: number, due: string, extra: TaskExtra = {}) =>
  prisma.task.create({
    data: {
      assignedToId, dueDate: day(due), title: extra.title ?? 'Task', origin: 'manual', leadId: extra.leadId ?? null,
      isDone: extra.isDone ?? false, kind: extra.kind ?? 'followup', dueTime: extra.dueTime ?? null,
      durationMinutes: extra.durationMinutes ?? null,
    },
  });

/** A connected personal mailbox for the user (calendar sync on unless said otherwise). */
const mailbox = (user: User, over: { syncCalendar?: boolean; address?: string } = {}) =>
  prisma.emailAccount.create({
    data: {
      userId: user.id, address: over.address ?? user.email, provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'),
      status: 'connected', syncCalendar: over.syncCalendar ?? true,
    },
  });

type EventExtra = Partial<{
  subject: string; endsAt: Date; isAllDay: boolean; location: string | null; organizerName: string | null;
  organizerAddress: string | null; attendeeAddresses: string[]; isOnline: boolean; leadId: number | null; companyId: number | null;
}>;
let graphN = 0;
const event = (user: User, accountId: number, startsAt: Date, extra: EventExtra = {}) => {
  graphN += 1;
  return prisma.calendarEvent.create({
    data: {
      userId: user.id, accountId, graphId: `g${graphN}`, subject: extra.subject ?? 'Event', startsAt,
      endsAt: extra.endsAt ?? new Date(startsAt.getTime() + 3600_000), isAllDay: extra.isAllDay ?? false,
      location: extra.location ?? null, organizerName: extra.organizerName ?? null, organizerAddress: extra.organizerAddress ?? null,
      attendeeAddresses: extra.attendeeAddresses ?? [], isOnline: extra.isOnline ?? false, leadId: extra.leadId ?? null,
      companyId: extra.companyId ?? null,
    },
  });
};

interface Item {
  kind: 'task' | 'event'; id: number; date: string; time: string | null; end: string | null; title: string; type: string;
  done: boolean; overdue: boolean; leadId: number | null; leadNumber: string | null; company: string | null; ownerId: number;
  ownerName: string; where: string | null; organizer?: string | null; attendees?: string[];
}
interface Body { items: Item[]; overdue: Item[]; outlook: { syncOn: boolean } }

const RANGE = 'from=2030-03-01&to=2030-03-31';

describe('calendar API', () => {
  it('401 signed out; 400 on a bad or too long range', async () => {
    expect((await get(`/api/calendar?${RANGE}`)).statusCode).toBe(401);
    const rep = await as('SALES_REPRESENTATIVE');
    expect((await get('/api/calendar?from=2030-03-01', rep.cookie)).statusCode).toBe(400);
    expect((await get('/api/calendar?from=2030-03-31&to=2030-03-01', rep.cookie)).statusCode).toBe(400);
    expect((await get('/api/calendar?from=2030-03-01&to=2030-05-02', rep.cookie)).statusCode).toBe(400); // 63 days
    expect((await get('/api/calendar?from=2030-03-01&to=2030-05-01', rep.cookie)).statusCode).toBe(200); // 62 days
    expect((await get(`/api/calendar?${RANGE}&who=team`, rep.cookie)).statusCode).toBe(400);
  });

  it('tasks: mine by default; Everyone only for an Administrator (ignored for others)', async () => {
    const admin = await as('ADMINISTRATOR');
    const manager = await as('MANAGER');
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const repTask = await task(rep.user.id, '2030-03-10', { leadId: lead.id, title: 'Call Acme' });
    const adminTask = await task(admin.user.id, '2030-03-11', { title: 'Admin own' });
    const managerTask = await task(manager.user.id, '2030-03-12', { leadId: lead.id, title: 'Manager on lead' });
    await task(rep.user.id, '2030-04-10', { leadId: lead.id }); // out of range

    const ids = (b: Body) => b.items.map((i) => i.id).sort((a, b2) => a - b2);
    expect(ids((await get(`/api/calendar?${RANGE}`, admin.cookie)).json())).toEqual([adminTask.id]);
    expect(ids((await get(`/api/calendar?${RANGE}&who=mine`, admin.cookie)).json())).toEqual([adminTask.id]);
    // Everyone: every assignee's tasks the admin may see (all leads; another user's lead-less task stays private).
    expect(ids((await get(`/api/calendar?${RANGE}&who=all`, admin.cookie)).json())).toEqual([repTask.id, adminTask.id, managerTask.id]);
    // Managers and reps: who=all is treated as mine.
    expect(ids((await get(`/api/calendar?${RANGE}&who=all`, manager.cookie)).json())).toEqual([managerTask.id]);
    expect(ids((await get(`/api/calendar?${RANGE}&who=all`, rep.cookie)).json())).toEqual([repTask.id]);

    const row = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items[0];
    expect(row).toEqual({
      kind: 'task', id: repTask.id, date: '2030-03-10', time: null, end: null, title: 'Call Acme', type: 'followup',
      done: false, overdue: false, leadId: lead.id, leadNumber: lead.number, company: lead.companyName,
      ownerId: rep.user.id, ownerName: rep.user.name, where: null,
    });
  });

  it('calls and meetings carry start, end and where; done tasks are flagged', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const call = await task(rep.user.id, '2030-03-10', { kind: 'call', dueTime: '10:00', durationMinutes: 30, title: 'Call' });
    const meet = await task(rep.user.id, '2030-03-10', { kind: 'meeting', dueTime: '23:30', durationMinutes: 60, title: 'Late', isDone: true });
    const fu = await task(rep.user.id, '2030-03-10', { dueTime: '09:15', title: 'Timed follow-up' });
    const items = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    const by = (id: number) => items.find((i) => i.id === id)!;
    expect(by(call.id)).toMatchObject({ type: 'call', time: '10:00', end: '10:30', where: 'Phone', done: false });
    expect(by(meet.id)).toMatchObject({ type: 'meeting', time: '23:30', end: '23:59', where: 'Microsoft Teams', done: true });
    expect(by(fu.id)).toMatchObject({ type: 'followup', time: '09:15', end: null, where: null });
  });

  it('events: only the caller\'s own, even for an Administrator with who=all', async () => {
    const admin = await as('ADMINISTRATOR');
    const rep = await as('SALES_REPRESENTATIVE');
    const repBox = await mailbox(rep.user);
    const adminBox = await mailbox(admin.user);
    const repEvent = await event(rep.user, repBox.id, new Date('2030-03-10T09:00:00Z'), { subject: 'Rep private' });
    const adminEvent = await event(admin.user, adminBox.id, new Date('2030-03-10T11:00:00Z'), { subject: 'Admin own' });

    const all = (await get(`/api/calendar?${RANGE}&who=all`, admin.cookie)).json<Body>();
    expect(all.items.filter((i) => i.kind === 'event').map((i) => i.id)).toEqual([adminEvent.id]);
    const mine = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>();
    expect(mine.items.filter((i) => i.kind === 'event').map((i) => i.id)).toEqual([repEvent.id]);
  });

  it('a timed event is shown in the viewer\'s time zone, with organiser, attendees and type', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Asia/Kolkata');
    const box = await mailbox(rep.user, { address: 'maya@daitpartners.com' });
    // 2030-03-10 20:00 UTC = 2030-03-11 01:30 in Kolkata.
    const external = await event(rep.user, box.id, new Date('2030-03-10T20:00:00Z'), {
      subject: 'Demo', endsAt: new Date('2030-03-10T21:00:00Z'), location: 'Room 1', organizerName: 'Maya',
      organizerAddress: 'maya@daitpartners.com', attendeeAddresses: ['ana@client.com', 'carlos@daitpartners.com'],
    });
    const internal = await event(rep.user, box.id, new Date('2030-03-12T04:30:00Z'), {
      subject: 'Standup', attendeeAddresses: ['carlos@daitpartners.com'], isOnline: true, organizerAddress: 'carlos@daitpartners.com',
    });
    const items = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    expect(items.find((i) => i.id === external.id)).toEqual({
      kind: 'event', id: external.id, date: '2030-03-11', time: '01:30', end: '02:30', title: 'Demo', type: 'meeting',
      done: false, overdue: false, leadId: null, leadNumber: null, company: null, ownerId: rep.user.id, ownerName: rep.user.name,
      where: 'Room 1', organizer: 'Maya', attendees: ['ana@client.com', 'carlos@daitpartners.com'],
    });
    expect(items.find((i) => i.id === internal.id)).toMatchObject({
      date: '2030-03-12', time: '10:00', end: '11:00', type: 'internal', where: 'Microsoft Teams', organizer: 'carlos@daitpartners.com',
    });
  });

  it('an event that converts to a date outside the range is left out; one converting into it is kept', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Asia/Kolkata');
    const box = await mailbox(rep.user);
    const inside = await event(rep.user, box.id, new Date('2030-02-28T20:00:00Z')); // 1 Mar 01:30 Kolkata
    await event(rep.user, box.id, new Date('2030-03-31T20:00:00Z')); // 1 Apr 01:30 Kolkata
    const items = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    expect(items.map((i) => [i.id, i.date])).toEqual([[inside.id, '2030-03-01']]);
  });

  it('an all-day event stays on its own date(s), untimed, whatever the viewer\'s zone', async () => {
    const west = await as('SALES_REPRESENTATIVE', 'America/Los_Angeles');
    const box = await mailbox(west.user);
    const one = await event(west.user, box.id, day('2030-03-10'), { subject: 'Holiday', isAllDay: true, endsAt: day('2030-03-11') });
    const two = await event(west.user, box.id, day('2030-03-20'), { subject: 'Offsite', isAllDay: true, endsAt: day('2030-03-22') });
    const items = (await get(`/api/calendar?${RANGE}`, west.cookie)).json<Body>().items;
    expect(items.filter((i) => i.id === one.id).map((i) => [i.date, i.time, i.end])).toEqual([['2030-03-10', null, null]]);
    expect(items.filter((i) => i.id === two.id).map((i) => i.date)).toEqual(['2030-03-20', '2030-03-21']);
    // A multi-day all-day event starting before the range shows on the days inside it.
    const spans = (await get('/api/calendar?from=2030-03-21&to=2030-03-25', west.cookie)).json<Body>().items;
    expect(spans.map((i) => [i.id, i.date])).toEqual([[two.id, '2030-03-21']]);
  });

  it('an all-day row stored at its own zone\'s midnight (east or west of UTC) shows on its intended date(s)', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Asia/Kolkata');
    const box = await mailbox(rep.user);
    const east = await event(rep.user, box.id, new Date('2030-03-09T18:30:00Z'), { isAllDay: true, endsAt: new Date('2030-03-10T18:30:00Z') });
    const west = await event(rep.user, box.id, new Date('2030-03-20T05:00:00Z'), { isAllDay: true, endsAt: new Date('2030-03-22T05:00:00Z') });
    const items = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    expect(items.filter((i) => i.id === east.id).map((i) => [i.date, i.time])).toEqual([['2030-03-10', null]]);
    expect(items.filter((i) => i.id === west.id).map((i) => i.date)).toEqual(['2030-03-20', '2030-03-21']);
  });

  it('an all-day row stored at the midnight of a zone east of UTC+12 shows on its intended date for a user there', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Pacific/Tongatapu');
    const box = await mailbox(rep.user);
    // 10 Mar 2030 in Tonga (UTC+13).
    const e = await event(rep.user, box.id, new Date('2030-03-09T11:00:00Z'), { isAllDay: true, endsAt: new Date('2030-03-10T11:00:00Z') });
    const items = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    expect(items.filter((i) => i.id === e.id).map((i) => i.date)).toEqual(['2030-03-10']);
  });

  it('a company-only match shows the company only to someone who may see it', async () => {
    const admin = await as('ADMINISTRATOR');
    const rep = await as('SALES_REPRESENTATIVE');
    const company = await makeCompany({ name: 'Hidden Co' });
    const at = new Date('2030-03-10T09:00:00Z');
    const repEvent = await event(rep.user, (await mailbox(rep.user)).id, at, { companyId: company.id });
    const adminEvent = await event(admin.user, (await mailbox(admin.user)).id, at, { companyId: company.id });
    const repItems = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    expect(repItems.find((i) => i.id === repEvent.id)).toMatchObject({ company: null, leadId: null });
    const adminItems = (await get(`/api/calendar?${RANGE}`, admin.cookie)).json<Body>().items;
    expect(adminItems.find((i) => i.id === adminEvent.id)).toMatchObject({ company: 'Hidden Co' });
  });

  it('an event linked to a lead the viewer can no longer see loses the link', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await as('SALES_REPRESENTATIVE');
    const box = await mailbox(rep.user);
    const mine = await makeLead({ assignedToId: rep.user.id });
    const hidden = await makeLead({ assignedToId: other.user.id });
    const linked = await event(rep.user, box.id, new Date('2030-03-10T09:00:00Z'), { leadId: mine.id, companyId: mine.companyId });
    const gone = await event(rep.user, box.id, new Date('2030-03-10T10:00:00Z'), { leadId: hidden.id, companyId: hidden.companyId });
    const items = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    expect(items.find((i) => i.id === linked.id)).toMatchObject({ leadId: mine.id, leadNumber: mine.number, company: mine.companyName });
    expect(items.find((i) => i.id === gone.id)).toMatchObject({ leadId: null, leadNumber: null, company: null });
  });

  it('overdue: open tasks before today in the same scope, any date; outlook.syncOn', async () => {
    const admin = await as('ADMINISTRATOR');
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const today = todayIn('UTC');
    const old = await task(rep.user.id, shift(today, -400), { leadId: lead.id, title: 'Ancient' });
    const recent = await task(rep.user.id, shift(today, -1), { leadId: lead.id, title: 'Yesterday' });
    await task(rep.user.id, shift(today, -2), { leadId: lead.id, isDone: true });
    await task(rep.user.id, today, { leadId: lead.id });
    const adminOld = await task(admin.user.id, shift(today, -3), { title: 'Admin late' });

    const repBody = (await get(`/api/calendar?${RANGE}&who=all`, rep.cookie)).json<Body>();
    expect(repBody.overdue.map((i) => i.id)).toEqual([old.id, recent.id]);
    expect(repBody.overdue[0]).toMatchObject({ kind: 'task', overdue: true, done: false });
    expect(repBody.outlook).toEqual({ syncOn: false });

    expect((await get(`/api/calendar?${RANGE}`, admin.cookie)).json<Body>().overdue.map((i) => i.id)).toEqual([adminOld.id]);
    expect((await get(`/api/calendar?${RANGE}&who=all`, admin.cookie)).json<Body>().overdue.map((i) => i.id))
      .toEqual([old.id, adminOld.id, recent.id]);

    // In-range tasks before today are flagged overdue too.
    const window = `from=${shift(today, -5)}&to=${today}`;
    const items = (await get(`/api/calendar?${window}`, rep.cookie)).json<Body>().items;
    expect(items.find((i) => i.id === recent.id)).toMatchObject({ overdue: true });

    await mailbox(rep.user, { syncCalendar: false });
    expect((await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().outlook).toEqual({ syncOn: false });
    await prisma.emailAccount.updateMany({ where: { userId: rep.user.id }, data: { syncCalendar: true } });
    expect((await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().outlook).toEqual({ syncOn: true });
  });

  it('copied events show only from a mailbox with calendar sync on that is connected or in error (a killed run can leave rows behind)', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const box = await mailbox(rep.user);
    const ev = await event(rep.user, box.id, new Date('2030-03-10T09:00:00Z'));
    const ids = async () => (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items.filter((i) => i.kind === 'event').map((i) => i.id);
    expect(await ids()).toEqual([ev.id]);
    await prisma.emailAccount.update({ where: { id: box.id }, data: { status: 'error' } });
    expect(await ids()).toEqual([ev.id]);
    await prisma.emailAccount.update({ where: { id: box.id }, data: { status: 'disconnected' } });
    expect(await ids()).toEqual([]);
    await prisma.emailAccount.update({ where: { id: box.id }, data: { status: 'connected', syncCalendar: false } });
    expect(await ids()).toEqual([]);
  });

  it('sorted by date, then time (untimed last), then title', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const box = await mailbox(rep.user);
    const b = await task(rep.user.id, '2030-03-10', { title: 'B untimed' });
    const a = await task(rep.user.id, '2030-03-10', { title: 'A untimed' });
    const call = await task(rep.user.id, '2030-03-10', { kind: 'call', dueTime: '14:00', durationMinutes: 30, title: 'Z call' });
    const ev = await event(rep.user, box.id, new Date('2030-03-10T09:00:00Z'), { subject: 'Morning' });
    const allDay = await event(rep.user, box.id, day('2030-03-10'), { subject: 'All day', isAllDay: true, endsAt: day('2030-03-11') });
    const early = await task(rep.user.id, '2030-03-09', { title: 'Z earlier day' });
    const items = (await get(`/api/calendar?${RANGE}`, rep.cookie)).json<Body>().items;
    expect(items.map((i) => i.id)).toEqual([early.id, ev.id, call.id, a.id, allDay.id, b.id]);
  });
});
