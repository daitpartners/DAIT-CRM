import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { CLOSED_STATUSES } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { requireUser, type AuthUser } from '../plugins/auth.js';
import { leadWhere } from '../leads/visibility.js';
import { taskInclude, taskRow } from '../leads/serialize.js';
import { dateOnly, todayIn } from '../leads/dates.js';
import { taskWhere } from './tasks.js';

/** Task rows on the dashboard card (prototype V.dashboard shows the first six). */
export const DASHBOARD_TASKS = 6;
/** Notifications on the dashboard card. */
export const DASHBOARD_NOTIFICATIONS = 5;
/** Pipeline bars: the first seven open statuses in lookup order. */
export const PIPELINE_STATUSES = 7;
const DAY_MS = 86_400_000;

/**
 * The instant a calendar day (YYYY-MM-DD) starts in `timezone` (UTC for an unknown zone).
 * Two passes of "UTC midnight minus the zone's offset at that moment" settle DST edges.
 */
export function startOfDayIn(day: string, timezone: string): Date {
  const utc = new Date(`${day}T00:00:00Z`).getTime();
  const offsetAt = (ms: number) => {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
      );
      const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
      return wall - ms;
    } catch {
      return 0;
    }
  };
  let guess = utc - offsetAt(utc);
  guess = utc - offsetAt(guess);
  return new Date(guess);
}

/**
 * The signed-in user's dashboard (prototype V.dashboard). Personal for every role, Administrator included:
 * "my" leads are visible leads assigned to the user; tasks are the user's own visible tasks; notifications
 * are the user's own. No team numbers.
 */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/dashboard', { preHandler: [requireUser] }, async (request) => {
    const user: AuthUser = request.user!;
    const today = todayIn(user.timezone);
    const day = dateOnly(today);
    const yesterday = new Date(day.getTime() - DAY_MS).toISOString().slice(0, 10);

    const mine: Prisma.LeadWhereInput = { AND: [leadWhere(user), { assignedToId: user.id }] };
    const myOpen: Prisma.LeadWhereInput = { AND: [mine, { status: { notIn: [...CLOSED_STATUSES] } }] };
    const myTasks: Prisma.TaskWhereInput = { AND: [taskWhere(user), { assignedToId: user.id, isDone: false }] };
    const countTasks = (due: Prisma.DateTimeFilter) => prisma.task.count({ where: { AND: [myTasks, { dueDate: due }] } });

    const [
      myOpenLeads, newSinceYesterday, tasksDueToday, overdue, upcoming, unreadNotifications,
      taskRows, notes, statuses, byStatus, won, lost,
    ] = await Promise.all([
      prisma.lead.count({ where: myOpen }),
      prisma.lead.count({ where: { AND: [myOpen, { createdAt: { gte: startOfDayIn(yesterday, user.timezone) } }] } }),
      countTasks({ equals: day }),
      countTasks({ lt: day }),
      countTasks({ gt: day }),
      prisma.notification.count({ where: { userId: user.id, isRead: false } }),
      prisma.task.findMany({ where: myTasks, include: taskInclude, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: DASHBOARD_TASKS }),
      prisma.notification.findMany({
        where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: DASHBOARD_NOTIFICATIONS,
      }),
      prisma.lookupValue.findMany({
        where: { group: 'lead_status', isActive: true, value: { notIn: [...CLOSED_STATUSES] } },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        take: PIPELINE_STATUSES,
        select: { value: true },
      }),
      prisma.lead.groupBy({ by: ['status'], where: myOpen, _count: { _all: true } }),
      prisma.lead.count({ where: { AND: [mine, { status: 'Won' }] } }),
      prisma.lead.count({ where: { AND: [mine, { status: 'Lost' }] } }),
    ]);

    const counts = new Map(byStatus.map((g) => [g.status, g._count._all]));
    return {
      greeting: { name: user.name, date: today },
      tiles: { myOpenLeads, newSinceYesterday, tasksDueToday, overdue, upcoming, openTasks: tasksDueToday + overdue + upcoming, unreadNotifications },
      tasks: taskRows.map((r) => taskRow(r, today)),
      notifications: notes.map((n) => ({ id: n.id, text: n.text, detail: n.detail, link: n.link, isRead: n.isRead, createdAt: n.createdAt })),
      pipeline: statuses.map((s) => ({ status: s.value, count: counts.get(s.value) ?? 0 })),
      closed: { won, lost },
    };
  });
};
