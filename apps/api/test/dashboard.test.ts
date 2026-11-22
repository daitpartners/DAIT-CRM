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

const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/dashboard', headers: cookie ? { cookie } : {} });

type RoleKey = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE';
async function as(role: RoleKey, name: string): Promise<{ user: User; cookie: string }> {
  const user = await makeUser({ role, name });
  return { user, cookie: await signIn(app, user) };
}

const DAY = 86_400_000;
const shift = (s: string, days: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
const task = (assignedToId: number, due: string, extra: { leadId?: number; title?: string; isDone?: boolean } = {}) =>
  prisma.task.create({
    data: {
      assignedToId, dueDate: new Date(`${due}T00:00:00Z`), title: extra.title ?? 'Task', origin: 'manual',
      leadId: extra.leadId ?? null, isDone: extra.isDone ?? false,
    },
  });
const note = (userId: number, text: string, minutesAgo: number) =>
  prisma.notification.create({ data: { userId, text, createdAt: new Date(Date.now() - minutesAgo * 60_000) } });

describe('dashboard API', () => {
  it('401 when signed out', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it('dashboard is scoped to the signed-in user', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Arjun Mehta');
    const manager = await as('MANAGER', 'Neha Kapoor');
    const today = todayIn('UTC');

    // The rep: three open leads (one created a week ago), one won, one lost, one archived.
    const old = new Date(Date.now() - 7 * DAY);
    const r1 = await makeLead({ assignedToId: rep.user.id, status: 'New' });
    await makeLead({ assignedToId: rep.user.id, status: 'Contacted', createdAt: old });
    await makeLead({ assignedToId: rep.user.id, status: 'Contacted' });
    await makeLead({ assignedToId: rep.user.id, status: 'Won', createdAt: old });
    await makeLead({ assignedToId: rep.user.id, status: 'Lost', createdAt: old });
    await makeLead({ assignedToId: rep.user.id, status: 'New', archivedAt: new Date() });
    // Unassigned (the rep can see it, but it is not theirs) and the manager's own leads.
    await makeLead({ assignedToId: null, status: 'New' });
    const m1 = await makeLead({ assignedToId: manager.user.id, status: 'Negotiation' });
    await makeLead({ assignedToId: manager.user.id, status: 'Interested' });

    const overdue = await task(rep.user.id, shift(today, -2), { leadId: r1.id, title: 'Chase proposal' });
    const due = await task(rep.user.id, today, { title: 'Send deck' });
    const later = await task(rep.user.id, shift(today, 3), { title: 'Follow up' });
    await task(rep.user.id, today, { title: 'Done already', isDone: true });
    await task(manager.user.id, today, { leadId: m1.id, title: 'Manager task' });
    await task(manager.user.id, shift(today, -1), { title: 'Manager personal' });

    await note(rep.user.id, 'Old', 60);
    for (let i = 0; i < 5; i += 1) await note(rep.user.id, `Rep ${i}`, 50 - i);
    await prisma.notification.updateMany({ where: { userId: rep.user.id, text: 'Rep 0' }, data: { isRead: true } });
    await note(manager.user.id, 'For the manager', 1);

    const res = await get(rep.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.greeting).toEqual({ name: 'Arjun Mehta', date: today });
    expect(body.tiles).toEqual({
      myOpenLeads: 3, newSinceYesterday: 2, tasksDueToday: 1, overdue: 1, upcoming: 1, openTasks: 3, unreadNotifications: 5,
    });
    expect(body.tasks.map((t: { id: number }) => t.id)).toEqual([overdue.id, due.id, later.id]);
    expect(body.tasks[0]).toMatchObject({ title: 'Chase proposal', isOverdue: true, lead: { id: r1.id } });
    expect(body.notifications.map((n: { text: string }) => n.text)).toEqual(['Rep 4', 'Rep 3', 'Rep 2', 'Rep 1', 'Rep 0']);
    expect(body.notifications[4]).toMatchObject({ isRead: true });
    expect(body.pipeline).toEqual([
      { status: 'New', count: 1 },
      { status: 'Not Contacted', count: 0 },
      { status: 'Contacted', count: 2 },
      { status: 'Interested', count: 0 },
      { status: 'Qualified', count: 0 },
      { status: 'Proposal Sent', count: 0 },
      { status: 'Negotiation', count: 0 },
    ]);
    expect(body.closed).toEqual({ won: 1, lost: 1 });

    // The manager sees every lead in lists, but the dashboard is personal.
    const mres = (await get(manager.cookie)).json();
    expect(mres.greeting.name).toBe('Neha Kapoor');
    expect(mres.tiles).toMatchObject({ myOpenLeads: 2, tasksDueToday: 1, overdue: 1, upcoming: 0, openTasks: 2, unreadNotifications: 1 });
    expect(mres.tasks.map((t: { title: string }) => t.title)).toEqual(['Manager personal', 'Manager task']);
    expect(mres.notifications.map((n: { text: string }) => n.text)).toEqual(['For the manager']);
    expect(mres.pipeline.find((p: { status: string }) => p.status === 'Negotiation').count).toBe(1);
    expect(mres.pipeline.find((p: { status: string }) => p.status === 'Interested').count).toBe(1);
    expect(mres.pipeline.find((p: { status: string }) => p.status === 'Contacted').count).toBe(0);
    expect(mres.closed).toEqual({ won: 0, lost: 0 });
  });

  it('caps the task list and follows the lead_status order', async () => {
    const admin = await as('ADMINISTRATOR', 'Maya Pillai');
    const today = todayIn('UTC');
    for (let i = 0; i < 8; i += 1) await task(admin.user.id, shift(today, i), { title: `T${i}` });
    // Reorder: Negotiation first; a retired status drops out; closed statuses are never bars.
    await prisma.lookupValue.update({ where: { group_value: { group: 'lead_status', value: 'Negotiation' } }, data: { sortOrder: -1 } });
    await prisma.lookupValue.update({ where: { group_value: { group: 'lead_status', value: 'New' } }, data: { isActive: false } });
    const body = (await get(admin.cookie)).json();
    expect(body.tasks).toHaveLength(6);
    expect(body.tiles.openTasks).toBe(8);
    expect(body.pipeline.map((p: { status: string }) => p.status)).toEqual([
      'Negotiation', 'Not Contacted', 'Contacted', 'Interested', 'Qualified', 'Proposal Sent',
    ]);
  });
  it("today's agenda: the user's own timed tasks for today (calls, meetings, timed follow-ups, done ones too), never Outlook events", async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Arjun Mehta');
    const manager = await as('MANAGER', 'Neha Kapoor');
    const today = todayIn('Europe/London');
    const lead = await makeLead({ assignedToId: rep.user.id, companyName: 'Bluefin Marine' });
    const timed = (assignedToId: number, due: string, title: string, kind: string, dueTime: string | null, extra: { isDone?: boolean; leadId?: number } = {}) =>
      prisma.task.create({
        data: {
          assignedToId, dueDate: new Date(`${due}T00:00:00Z`), title, origin: 'manual', kind, dueTime,
          durationMinutes: kind === 'call' ? 30 : kind === 'meeting' ? 60 : null, isDone: extra.isDone ?? false, leadId: extra.leadId ?? null,
        },
      });
    const meeting = await timed(rep.user.id, today, 'Demo', 'meeting', '14:00');
    const call = await timed(rep.user.id, today, 'Call back', 'call', '10:30', { leadId: lead.id });
    const followUp = await timed(rep.user.id, today, 'Chase reply', 'followup', '16:45');
    const done = await timed(rep.user.id, today, 'Morning call', 'call', '09:00', { isDone: true });
    await timed(rep.user.id, today, 'Untimed', 'followup', null);
    await timed(rep.user.id, shift(today, 1), 'Tomorrow', 'call', '10:00');
    await timed(manager.user.id, today, 'Not mine', 'meeting', '11:00', { leadId: lead.id });
    // An Outlook event today, calendar sync on: never on the dashboard.
    const box = await prisma.emailAccount.create({
      data: { userId: rep.user.id, address: 'arjun@example.com', provider: 'microsoft', kind: 'personal', refreshTokenEnc: encrypt('rt'), status: 'connected', syncCalendar: true },
    });
    await prisma.calendarEvent.create({
      data: { userId: rep.user.id, accountId: box.id, graphId: 'g1', subject: 'Outlook only', startsAt: new Date(`${today}T12:00:00Z`), endsAt: new Date(`${today}T13:00:00Z`) },
    });

    const body = (await get(rep.cookie)).json();
    expect(body.agenda.map((t: { id: number }) => t.id)).toEqual([done.id, call.id, meeting.id, followUp.id]);
    expect(body.agenda[1]).toMatchObject({ kind: 'call', dueTime: '10:30', durationMinutes: 30, lead: { id: lead.id, companyName: 'Bluefin Marine' } });
    expect(body.agenda[0]).toMatchObject({ isDone: true });
    expect(JSON.stringify(body)).not.toContain('Outlook only');
  });
  it('quotes awaiting response: the user\'s own Sent / Negotiating quotations with their display totals (prototype tile)', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Arjun Mehta');
    const other = await as('SALES_REPRESENTATIVE', 'Ravi Shah');
    const india = await makeCompany({ country: 'India', createdById: rep.user.id });
    const us = await makeCompany({ country: 'United States', createdById: rep.user.id });
    const theirs = await makeCompany({ country: 'India', createdById: other.user.id });
    const quote = async (cookie: string, companyId: number, price: number, status: string) => {
      const created = await app.inject({ method: 'POST', url: '/api/quotations', headers: { cookie }, payload: { companyId } });
      expect(created.statusCode, created.body).toBe(201);
      const q = created.json();
      const res = await app.inject({
        method: 'PATCH', url: `/api/quotations/${q.id}`, headers: { cookie },
        payload: { updatedAt: q.updatedAt, lines: [{ item: 'Work', description: null, qty: 1, unit: 'unit', unitPrice: price, discount: 0 }] },
      });
      expect(res.statusCode, res.body).toBe(200);
      await prisma.quotation.update({ where: { id: q.id }, data: { status } });
      return q.id as number;
    };
    const sent = await quote(rep.cookie, india.id, 1000, 'Sent');
    const neg = await quote(rep.cookie, us.id, 2500, 'Negotiating');
    await quote(rep.cookie, india.id, 50, 'Draft');
    await quote(rep.cookie, us.id, 70, 'Accepted');
    await quote(other.cookie, theirs.id, 90, 'Sent');

    const body = (await get(rep.cookie)).json();
    // 1000 + 18 % GST in INR; 2500 at 0 % in USD; newest first, as the prototype's store order.
    expect(body.awaitingQuotes).toEqual([
      { id: neg, currency: 'USD', total: 2500 },
      { id: sent, currency: 'INR', total: 1180 },
    ]);
    expect((await get(other.cookie)).json().awaitingQuotes).toHaveLength(1);
  });
});
