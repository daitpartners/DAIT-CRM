import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/nav-counts', headers: cookie ? { cookie } : {} });

const DAY = 86_400_000;
const shift = (s: string, days: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
const task = (assignedToId: number, due: string, isDone = false) =>
  prisma.task.create({ data: { assignedToId, dueDate: new Date(`${due}T00:00:00Z`), title: 'Task', origin: 'manual', isDone } });

describe('nav counts API', () => {
  it('401 when signed out', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it('counts visible leads, my overdue open tasks and my unread notifications', async () => {
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const today = todayIn('UTC');

    // Visible to the rep: two of their own (one closed still counts) and one unassigned; not archived or someone else's.
    await makeLead({ assignedToId: rep.id, status: 'New' });
    await makeLead({ assignedToId: rep.id, status: 'Lost' });
    await makeLead({ assignedToId: null, status: 'New' });
    await makeLead({ assignedToId: rep.id, status: 'New', archivedAt: new Date() });
    await makeLead({ assignedToId: other.id, status: 'New' });

    // Overdue = mine, not done, due before today.
    await task(rep.id, shift(today, -2));
    await task(rep.id, shift(today, -1));
    await task(rep.id, shift(today, -1), true);
    await task(rep.id, today);
    await task(other.id, shift(today, -1));

    await prisma.notification.createMany({
      data: [
        { userId: rep.id, text: 'a' },
        { userId: rep.id, text: 'b', isRead: true },
        { userId: other.id, text: 'c' },
      ],
    });

    const res = await get(await signIn(app, rep));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ leads: 3, overdueTasks: 2, unread: 1, mailUnread: 0, mailerLive: 0, projects: 0 });
  });

  it('counts the projects the user can see: lead rule, company rule without a lead, or manager = me', async () => {
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const other = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const mine = await makeLead({ assignedToId: rep.id });
    const archived = await makeLead({ assignedToId: rep.id, archivedAt: new Date() });
    const theirs = await makeLead({ assignedToId: other.id });
    let k = 0;
    const project = (companyId: number, leadId: number | null, managerId: number) => {
      k += 1;
      return prisma.project.create({
        data: {
          number: `PRJ-${k}`, companyId, leadId, name: `P${k}`, startDate: new Date('2026-11-22T00:00:00Z'), currency: 'INR',
          managerId, createdById: admin.id,
        },
      });
    };
    await project(mine.companyId!, mine.id, admin.id); // my lead
    await project(archived.companyId!, archived.id, admin.id); // my archived lead still counts
    await project(theirs.companyId!, theirs.id, admin.id); // hidden
    await project(theirs.companyId!, theirs.id, rep.id); // hidden lead, but I manage it
    await project(mine.companyId!, null, admin.id); // no lead: my company (a lead of mine is on it)
    await project(theirs.companyId!, null, admin.id); // no lead, hidden company

    expect((await get(await signIn(app, rep))).json().projects).toBe(4);
    expect((await get(await signIn(app, admin))).json().projects).toBe(6);
  });
});
