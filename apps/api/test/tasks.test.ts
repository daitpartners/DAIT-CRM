import type { FastifyInstance } from 'fastify';
import type { Task, User } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { todayIn } from '../src/leads/dates';
import { resetDb, seedLookups } from './helpers';
import { makeLead, makeUser, signIn } from './factory';

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
afterEach(() => {
  vi.useRealTimers();
});

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie?: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });

type RoleKey = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER';
async function as(role: RoleKey, timezone?: string): Promise<{ user: User; cookie: string }> {
  let user = await makeUser({ role });
  if (timezone) user = await prisma.user.update({ where: { id: user.id }, data: { timezone } });
  return { user, cookie: await signIn(app, user) };
}

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const shift = (s: string, days: number) => new Date(day(s).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const stamp = (t: Task) => t.updatedAt.toISOString();
const task = (assignedToId: number, due: string, extra: Partial<{ leadId: number | null; title: string; isDone: boolean }> = {}) =>
  prisma.task.create({
    data: { assignedToId, dueDate: day(due), title: extra.title ?? 'Task', origin: 'manual', leadId: extra.leadId ?? null, isDone: extra.isDone ?? false },
  });
const ids = (body: { items: { id: number }[] }) => body.items.map((t) => t.id).sort((a, b) => a - b);

describe('tasks API', () => {
  it('401 when signed out', async () => {
    expect((await req('GET', '/api/tasks')).statusCode).toBe(401);
    expect((await req('POST', '/api/tasks', undefined, {})).statusCode).toBe(401);
  });

  it('tasks list hides other reps\' tasks', async () => {
    const repA = await as('SALES_REPRESENTATIVE');
    const repB = await as('SALES_REPRESENTATIVE');
    const manager = await as('MANAGER');
    const today = todayIn('UTC');
    const leadA = await makeLead({ assignedToId: repA.user.id });
    const leadB = await makeLead({ assignedToId: repB.user.id });
    const a1 = await task(repA.user.id, today, { leadId: leadA.id, title: 'Call Acme' });
    const aPersonal = await task(repA.user.id, today, { title: 'Expenses' });
    const b1 = await task(repB.user.id, today, { leadId: leadB.id });
    const bPersonal = await task(repB.user.id, today);
    const archived = await makeLead({ assignedToId: repA.user.id, archivedAt: new Date() });
    await task(repA.user.id, today, { leadId: archived.id });

    const mine = await req('GET', '/api/tasks?tab=today', repA.cookie);
    expect(mine.statusCode).toBe(200);
    expect(ids(mine.json())).toEqual([a1.id, aPersonal.id]);
    expect(mine.json()).toMatchObject({ total: 2, page: 1, pageSize: 25, counts: { today: 2, overdue: 0, upcoming: 0, done: 0 } });
    const row = mine.json().items.find((t: { id: number }) => t.id === a1.id);
    expect(row).toMatchObject({
      title: 'Call Acme', dueDate: today, isToday: true, isOverdue: false, isDone: false, origin: 'manual',
      lead: { id: leadA.id, number: leadA.number }, assignedTo: { id: repA.user.id },
    });

    expect((await req('GET', '/api/tasks?assignedTo=all', repA.cookie)).statusCode).toBe(403);
    expect((await req('GET', `/api/tasks?assignedTo=${repB.user.id}`, repA.cookie)).statusCode).toBe(403);
    expect(ids((await req('GET', `/api/tasks?assignedTo=${repA.user.id}`, repA.cookie)).json())).toEqual([a1.id, aPersonal.id]);

    // A manager sees every lead's tasks, but not other people's personal tasks.
    const all = await req('GET', '/api/tasks?assignedTo=all', manager.cookie);
    expect(ids(all.json())).toEqual([a1.id, b1.id]);
    expect(all.json().counts.today).toBe(2);
    expect(ids((await req('GET', `/api/tasks?assignedTo=${repB.user.id}`, manager.cookie)).json())).toEqual([b1.id]);
    expect((await req('GET', '/api/tasks', manager.cookie)).json().total).toBe(0);
    expect(bPersonal.id).toBeGreaterThan(0);

    // Editing a hidden task is a 404.
    expect((await req('PATCH', `/api/tasks/${b1.id}`, repA.cookie, { title: 'Mine now', updatedAt: stamp(b1) })).statusCode).toBe(404);
    expect((await req('PATCH', `/api/tasks/${bPersonal.id}`, manager.cookie, { title: 'x', updatedAt: stamp(bPersonal) })).statusCode).toBe(404);
  });

  it('tabs classify by the user\'s timezone', async () => {
    // 20:00 UTC: already tomorrow in India (UTC+05:30).
    const utcToday = new Date().toISOString().slice(0, 10);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${utcToday}T20:00:00Z`));
    const rep = await as('SALES_REPRESENTATIVE', 'Asia/Kolkata');
    const istToday = shift(utcToday, 1);
    expect(todayIn('Asia/Kolkata')).toBe(istToday);

    const dueUtcToday = await task(rep.user.id, utcToday);
    const dueIstToday = await task(rep.user.id, istToday);
    const later = await task(rep.user.id, shift(istToday, 3));
    const done = await task(rep.user.id, shift(utcToday, -5), { isDone: true });

    const counts = { today: 1, overdue: 1, upcoming: 1, done: 1 };
    const tab = async (name: string) => (await req('GET', `/api/tasks?tab=${name}`, rep.cookie)).json();
    expect((await tab('today')).counts).toEqual(counts);
    expect(ids(await tab('today'))).toEqual([dueIstToday.id]);
    expect(ids(await tab('overdue'))).toEqual([dueUtcToday.id]);
    expect((await tab('overdue')).items[0]).toMatchObject({ isOverdue: true, isToday: false });
    expect(ids(await tab('upcoming'))).toEqual([later.id]);
    expect(ids(await tab('done'))).toEqual([done.id]);
    // Default tab is today.
    expect(ids((await req('GET', '/api/tasks', rep.cookie)).json())).toEqual([dueIstToday.id]);

    // The same tasks for a user on UTC.
    await prisma.user.update({ where: { id: rep.user.id }, data: { timezone: 'UTC' } });
    expect(ids(await tab('today'))).toEqual([dueUtcToday.id]);
    expect(ids(await tab('upcoming'))).toEqual([dueIstToday.id, later.id]);
    expect((await tab('today')).counts).toEqual({ today: 1, overdue: 0, upcoming: 2, done: 1 });
  });

  it('open tab returns tasks grouped by section', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'UTC');
    const other = await as('SALES_REPRESENTATIVE');
    const manager = await as('MANAGER');
    const today = todayIn('UTC');
    const lead = await makeLead({ assignedToId: rep.user.id });
    const late = await task(rep.user.id, shift(today, -2), { leadId: lead.id });
    const later = await task(rep.user.id, shift(today, -1));
    const now = await task(rep.user.id, today);
    const soon = await task(rep.user.id, shift(today, 2));
    const ticked = await task(rep.user.id, shift(today, -3), { isDone: true });
    const hidden = await task(other.user.id, today);

    const res = await req('GET', '/api/tasks?tab=open', rep.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const sec = (k: 'overdue' | 'today' | 'upcoming') => body.sections[k].map((t: { id: number }) => t.id);
    // Oldest first within a section; done and other people's tasks are left out.
    expect(sec('overdue')).toEqual([late.id, later.id]);
    expect(sec('today')).toEqual([now.id]);
    expect(sec('upcoming')).toEqual([soon.id]);
    expect(body.counts).toEqual({ today: 1, overdue: 2, upcoming: 1, done: 1 });
    expect(body.sections.overdue[0]).toMatchObject({ isOverdue: true, lead: { id: lead.id } });
    expect(JSON.stringify(body)).not.toContain(`"id":${ticked.id},`);

    // Same right rule as the other tabs: only view_all_leads may ask for everyone's.
    expect((await req('GET', '/api/tasks?tab=open&assignedTo=all', rep.cookie)).statusCode).toBe(403);
    const team = (await req('GET', '/api/tasks?tab=open&assignedTo=all', manager.cookie)).json();
    // The manager sees lead tasks on every lead, but not other people's personal tasks.
    expect(team.sections.overdue.map((t: { id: number }) => t.id)).toEqual([late.id]);
    expect(team.sections.today.map((t: { id: number }) => t.id)).not.toContain(hidden.id);
  });

  it('tick sets doneAt', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const t = await task(rep.user.id, todayIn('UTC'), { title: 'Send deck' });
    const res = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { isDone: true, updatedAt: stamp(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.id, isDone: true });
    const ticked = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(ticked.doneAt).toBeInstanceOf(Date);
    expect(res.json().doneAt).toBe(ticked.doneAt!.toISOString());

    // The old copy is stale.
    const stale = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { isDone: false, updatedAt: stamp(t) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale' });

    const untick = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { isDone: false, updatedAt: stamp(ticked) });
    expect(untick.statusCode).toBe(200);
    expect(untick.json()).toMatchObject({ isDone: false, doneAt: null });

    const retitle = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, {
      title: 'Send revised deck', dueDate: '2027-01-15', updatedAt: untick.json().updatedAt,
    });
    expect(retitle.json()).toMatchObject({ title: 'Send revised deck', dueDate: '2027-01-15' });

    const logs = await prisma.auditLog.findMany({ where: { entityType: 'task', entityId: String(t.id) } });
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.action === 'update' && l.userId === rep.user.id)).toBe(true);
  });

  it('snooze moves to tomorrow', async () => {
    const rep = await as('SALES_REPRESENTATIVE', 'Asia/Kolkata');
    const today = todayIn('Asia/Kolkata');
    const t = await task(rep.user.id, shift(today, -3));
    const res = await req('POST', `/api/tasks/${t.id}/snooze`, rep.cookie, { updatedAt: stamp(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dueDate: shift(today, 1), isOverdue: false });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).dueDate).toEqual(day(shift(today, 1)));
    expect(await prisma.auditLog.count({ where: { entityType: 'task', entityId: String(t.id) } })).toBe(1);
    expect((await req('POST', `/api/tasks/${t.id}/snooze`, rep.cookie, { updatedAt: stamp(t) })).statusCode).toBe(409);
  });

  it('reassign to someone who cannot see the lead is refused', async () => {
    const manager = await as('MANAGER');
    const [repA, repB] = [await makeUser(), await makeUser()];
    const lead = await makeLead({ assignedToId: repA.id });
    const t = await task(repA.id, todayIn('UTC'), { leadId: lead.id, title: 'Send deck' });

    const refused = await req('PATCH', `/api/tasks/${t.id}`, manager.cookie, { assignedToId: repB.id, updatedAt: stamp(t) });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'cannot_assign_hidden' });
    const created = await req('POST', '/api/tasks', manager.cookie, { leadId: lead.id, title: 'Visit', dueDate: '2027-01-10', assignedToId: repB.id });
    expect(created.json()).toEqual({ error: 'cannot_assign_hidden' });
    const inactive = await makeUser({ role: 'MANAGER', isActive: false });
    expect((await req('PATCH', `/api/tasks/${t.id}`, manager.cookie, { assignedToId: inactive.id, updatedAt: stamp(t) })).json())
      .toEqual({ error: 'cannot_assign_hidden' });
    expect(await prisma.notification.count()).toBe(0);

    // Someone who can see it: allowed and notified.
    const other = await makeUser({ role: 'MANAGER' });
    const ok = await req('PATCH', `/api/tasks/${t.id}`, manager.cookie, { assignedToId: other.id, updatedAt: stamp(t) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().assignedTo).toEqual({ id: other.id, name: other.name });
    const note = await prisma.notification.findFirstOrThrow();
    expect(note).toMatchObject({ userId: other.id, text: 'Task assigned to you · Send deck', link: '/tasks' });

    // Create: manual origin, audited, assignee notified.
    const made = await req('POST', '/api/tasks', manager.cookie, { leadId: lead.id, title: 'Visit', dueDate: '2027-01-10', assignedToId: repA.id });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ title: 'Visit', dueDate: '2027-01-10', origin: 'manual', lead: { id: lead.id }, assignedTo: { id: repA.id } });
    expect(await prisma.auditLog.count({ where: { entityType: 'task', action: 'create', entityId: String(made.json().id) } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: repA.id, text: 'Task assigned to you · Visit' } })).toBe(1);

    // A rep cannot create a task on a lead they cannot see.
    const rep = await as('SALES_REPRESENTATIVE');
    const hidden = await req('POST', '/api/tasks', rep.cookie, { leadId: lead.id, title: 'Peek', dueDate: '2027-01-10', assignedToId: rep.user.id });
    expect(hidden.statusCode).toBe(404);
    const personal = await req('POST', '/api/tasks', rep.cookie, { title: 'Expenses', dueDate: '2027-01-10', assignedToId: rep.user.id });
    expect(personal.statusCode).toBe(201);
    expect(personal.json()).toMatchObject({ leadId: null, lead: null });
  });
});

describe('follow-up tasks stay in step with the lead', () => {
  const setup = async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const lead = await makeLead({ companyName: 'Acme', assignedToId: rep.user.id, nextFollowUp: day('2027-01-05') });
    const t = await prisma.task.create({
      data: { leadId: lead.id, assignedToId: rep.user.id, title: 'Follow up · Acme', dueDate: day('2027-01-05'), origin: 'follow_up' },
    });
    return { rep, lead, t };
  };
  const leadOf = (id: number) => prisma.lead.findUniqueOrThrow({ where: { id } });
  const leadAudits = (id: number) => prisma.auditLog.findMany({ where: { entityType: 'lead', entityId: String(id) } });

  it('re-dating a follow-up task updates the lead', async () => {
    const { rep, lead, t } = await setup();
    const res = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { dueDate: '2027-02-01', updatedAt: stamp(t) });
    expect(res.statusCode).toBe(200);
    expect((await leadOf(lead.id)).nextFollowUp).toEqual(day('2027-02-01'));
    const logs = await leadAudits(lead.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: rep.user.id, before: { nextFollowUp: '2027-01-05' }, after: { nextFollowUp: '2027-02-01' } });

    // Reassigning leaves the lead's assignee alone.
    const manager = await makeUser({ role: 'MANAGER' });
    const mgr = await as('MANAGER');
    await req('PATCH', `/api/tasks/${t.id}`, mgr.cookie, { assignedToId: manager.id, updatedAt: res.json().updatedAt });
    expect((await leadOf(lead.id)).assignedToId).toBe(rep.user.id);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).assignedToId).toBe(manager.id);
  });

  it('ticking a follow-up task clears the lead follow-up', async () => {
    const { rep, lead, t } = await setup();
    const res = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { isDone: true, updatedAt: stamp(t) });
    expect(res.statusCode).toBe(200);
    expect((await leadOf(lead.id)).nextFollowUp).toBeNull();
    // Unticking restores it from the task's date.
    const untick = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { isDone: false, updatedAt: res.json().updatedAt });
    expect(untick.statusCode).toBe(200);
    expect((await leadOf(lead.id)).nextFollowUp).toEqual(day('2027-01-05'));
    expect(await leadAudits(lead.id)).toHaveLength(2);
  });

  it('snoozing a follow-up task moves the lead follow-up', async () => {
    const { rep, lead, t } = await setup();
    const res = await req('POST', `/api/tasks/${t.id}/snooze`, rep.cookie, { updatedAt: stamp(t) });
    expect(res.statusCode).toBe(200);
    const tomorrow = shift(todayIn('UTC'), 1);
    expect((await leadOf(lead.id)).nextFollowUp).toEqual(day(tomorrow));
    expect(await leadAudits(lead.id)).toHaveLength(1);
  });

  it('a later lead edit does not resurrect a ticked follow-up', async () => {
    const { rep, lead, t } = await setup();
    expect((await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { isDone: true, updatedAt: stamp(t) })).statusCode).toBe(200);
    const current = await leadOf(lead.id);
    const edit = await req('PATCH', `/api/leads/${lead.id}`, rep.cookie, {
      notes: 'Spoke briefly', companyName: 'Acme Ltd', updatedAt: current.updatedAt.toISOString(),
    });
    expect(edit.statusCode).toBe(200);
    expect(await prisma.task.count({ where: { leadId: lead.id, origin: 'follow_up', isDone: false } })).toBe(0);
    expect((await leadOf(lead.id)).nextFollowUp).toBeNull();
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).isDone).toBe(true);
  });
});

describe('task edit permission', () => {
  it('another rep cannot edit a task on an unassigned lead', async () => {
    const repA = await as('SALES_REPRESENTATIVE');
    const repB = await as('SALES_REPRESENTATIVE');
    const manager = await as('MANAGER');
    const lead = await makeLead({ assignedToId: repA.user.id });
    const t = await task(repA.user.id, '2027-01-05', { leadId: lead.id });
    const un = await req('POST', `/api/leads/${lead.id}/unassign`, manager.cookie, { note: 'Pool', updatedAt: lead.updatedAt.toISOString() });
    expect(un.statusCode).toBe(200);
    const kept = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(kept.assignedToId).toBe(repA.user.id);

    // Rep B can see the unassigned lead and its task, but may not edit it.
    expect((await req('GET', `/api/leads/${lead.id}`, repB.cookie)).statusCode).toBe(200);
    const res = await req('PATCH', `/api/tasks/${t.id}`, repB.cookie, { isDone: true, updatedAt: stamp(kept) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect((await req('POST', `/api/tasks/${t.id}/snooze`, repB.cookie, { updatedAt: stamp(kept) })).statusCode).toBe(403);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).isDone).toBe(false);

    // The assignee and a manager may.
    const own = await req('PATCH', `/api/tasks/${t.id}`, repA.cookie, { title: 'Still mine', updatedAt: stamp(kept) });
    expect(own.statusCode).toBe(200);
    const mgr = await req('PATCH', `/api/tasks/${t.id}`, manager.cookie, { title: 'Checked', updatedAt: own.json().updatedAt });
    expect(mgr.statusCode).toBe(200);
  });
});


describe('timed tasks (calls and meetings)', () => {
  const setup = async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const assignee = await prisma.user.update({ where: { id: rep.user.id }, data: { name: 'Neha Kapoor' } });
    const lead = await makeLead({ assignedToId: rep.user.id });
    return { rep, assignee, lead };
  };
  const create = (cookie: string, body: object) => req('POST', '/api/tasks', cookie, body);
  const activities = (leadId: number) =>
    prisma.leadActivity.findMany({ where: { leadId }, orderBy: { id: 'asc' }, select: { activityType: true, title: true, body: true, byUserId: true } });

  it('existing rows read as untimed follow-ups', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    await task(rep.user.id, todayIn('UTC'));
    const [row] = (await req('GET', '/api/tasks?tab=today', rep.cookie)).json().items;
    expect(row).toMatchObject({ kind: 'followup', dueTime: null, durationMinutes: null });
  });

  it('a call or meeting needs a time; a meeting lasts 60 minutes', async () => {
    const { rep, lead } = await setup();
    const base = { leadId: lead.id, title: 'Intro', dueDate: '2026-11-23', assignedToId: rep.user.id };
    expect((await create(rep.cookie, { ...base, kind: 'call' })).statusCode).toBe(400);
    expect(await prisma.task.count()).toBe(0);

    const meeting = await create(rep.cookie, { ...base, kind: 'meeting', dueTime: '10:00' });
    expect(meeting.statusCode).toBe(201);
    expect(meeting.json()).toMatchObject({ kind: 'meeting', dueTime: '10:00', durationMinutes: 60, origin: 'manual' });
    const call = await create(rep.cookie, { ...base, kind: 'call', dueTime: '09:15' });
    expect(call.json()).toMatchObject({ kind: 'call', dueTime: '09:15', durationMinutes: 30 });
    const timedFollowUp = await create(rep.cookie, { ...base, dueTime: '08:00' });
    expect(timedFollowUp.json()).toMatchObject({ kind: 'followup', dueTime: '08:00', durationMinutes: null });
    // Without `timeline` (the existing Add task dialogs) no lead activity is written.
    expect(await activities(lead.id)).toEqual([]);
  });

  it('planned from the calendar, the lead timeline gets an entry', async () => {
    const { rep, lead } = await setup();
    const base = { leadId: lead.id, dueDate: '2026-11-23', assignedToId: rep.user.id, timeline: true };
    expect((await create(rep.cookie, { ...base, title: 'Pricing call', kind: 'call', dueTime: '23:30' })).statusCode).toBe(201);
    expect((await create(rep.cookie, { ...base, title: 'Demo', kind: 'meeting', dueTime: '10:00' })).statusCode).toBe(201);
    expect((await create(rep.cookie, { ...base, title: 'Send deck' })).statusCode).toBe(201);
    expect((await create(rep.cookie, { ...base, title: 'Chase reply', dueTime: '16:45' })).statusCode).toBe(201);
    expect(await activities(lead.id)).toEqual([
      // The end is capped at 23:59, never past midnight.
      { activityType: 'meeting', title: 'Call scheduled · Pricing call', body: '2026-11-23 23:30–23:59 · Phone', byUserId: rep.user.id },
      { activityType: 'meeting', title: 'Meeting scheduled · Demo', body: '2026-11-23 10:00–11:00 · Microsoft Teams', byUserId: rep.user.id },
      { activityType: 'note', title: 'Follow-up planned · Send deck', body: '2026-11-23 · Neha Kapoor', byUserId: rep.user.id },
      { activityType: 'note', title: 'Follow-up planned · Chase reply', body: '2026-11-23 16:45 · Neha Kapoor', byUserId: rep.user.id },
    ]);
    // A personal task (no lead) has no timeline.
    expect((await create(rep.cookie, { title: 'Expenses', dueDate: '2026-11-23', assignedToId: rep.user.id, timeline: true })).statusCode).toBe(201);
    expect(await prisma.leadActivity.count()).toBe(4);
  });

  it('a planned entry is marked with its task and is not a contact (lead Last contact, company Activity summary)', async () => {
    const { rep, lead } = await setup();
    const base = { leadId: lead.id, dueDate: '2026-11-23', assignedToId: rep.user.id, timeline: true };
    const call = await create(rep.cookie, { ...base, title: 'Pricing call', kind: 'call', dueTime: '09:00' });
    const meeting = await create(rep.cookie, { ...base, title: 'Demo', kind: 'meeting', dueTime: '10:00' });
    await create(rep.cookie, { ...base, title: 'Send deck' });
    const rows = await prisma.leadActivity.findMany({ where: { leadId: lead.id }, orderBy: { id: 'asc' } });
    expect(rows.slice(0, 2).map((a) => [a.relatedType, a.relatedId])).toEqual([['task', call.json().id], ['task', meeting.json().id]]);
    const detail = (await req('GET', `/api/leads/${lead.id}`, rep.cookie)).json();
    expect(detail.lastContact).toBeNull();
    expect(detail.activities).toHaveLength(3); // the timeline still shows them
    const company = (await req('GET', `/api/companies/${lead.companyId}/activities`, rep.cookie)).json();
    expect(company.summary).toEqual({ call: 0, email: 0, meeting: 0, quote: 0, lastAt: null });
    expect(company.items).toHaveLength(3);
    // A logged meeting still counts.
    await prisma.leadActivity.create({ data: { leadId: lead.id, activityType: 'meeting', title: 'Met', byUserId: rep.user.id } });
    expect((await req('GET', `/api/leads/${lead.id}`, rep.cookie)).json().lastContact).toMatchObject({ type: 'meeting' });
    expect((await req('GET', `/api/companies/${lead.companyId}/activities`, rep.cookie)).json().summary).toMatchObject({ meeting: 1 });
  });

  it('editing the type keeps a time and sets the duration', async () => {
    const { rep, lead } = await setup();
    const t = await task(rep.user.id, '2026-11-23', { leadId: lead.id });
    const noTime = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { kind: 'call', updatedAt: stamp(t) });
    expect(noTime.statusCode).toBe(400);
    expect(noTime.json()).toEqual({ error: 'time_required' });

    const call = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { kind: 'call', dueTime: '11:00', updatedAt: stamp(t) });
    expect(call.statusCode).toBe(200);
    expect(call.json()).toMatchObject({ kind: 'call', dueTime: '11:00', durationMinutes: 30 });
    // Clearing the time of a call is refused (merged result).
    const cleared = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { dueTime: null, updatedAt: call.json().updatedAt });
    expect(cleared.json()).toEqual({ error: 'time_required' });

    const meeting = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { kind: 'meeting', updatedAt: call.json().updatedAt });
    expect(meeting.json()).toMatchObject({ kind: 'meeting', dueTime: '11:00', durationMinutes: 60 });
    const back = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { kind: 'followup', updatedAt: meeting.json().updatedAt });
    expect(back.json()).toMatchObject({ kind: 'followup', dueTime: '11:00', durationMinutes: null });
    const untimed = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { dueTime: null, updatedAt: back.json().updatedAt });
    expect(untimed.json()).toMatchObject({ kind: 'followup', dueTime: null });

    // Snooze moves the date and keeps the time; editing writes no timeline entry.
    const timed = await req('PATCH', `/api/tasks/${t.id}`, rep.cookie, { kind: 'call', dueTime: '09:00', updatedAt: untimed.json().updatedAt });
    const snoozed = await req('POST', `/api/tasks/${t.id}/snooze`, rep.cookie, { updatedAt: timed.json().updatedAt });
    expect(snoozed.statusCode).toBe(200);
    expect(snoozed.json()).toMatchObject({ kind: 'call', dueTime: '09:00', durationMinutes: 30, dueDate: shift(todayIn('UTC'), 1) });
    expect(await activities(lead.id)).toEqual([]);
  });
});
