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
