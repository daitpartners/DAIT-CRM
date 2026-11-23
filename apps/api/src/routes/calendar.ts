import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { CalendarQuery, domainOf, taskEndTime, type CalendarItem, type CalendarResponse, type TaskKind } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { parseQuery } from '../validate.js';
import { requireUser, type AuthUser } from '../plugins/auth.js';
import { canSeeLead } from '../leads/visibility.js';
import { allDayMidnight, dateOnly, todayIn, ymd } from '../leads/dates.js';
import { visibleCompanyIds } from '../companies/visibility.js';
import { taskWhere } from './tasks.js';

const DAY_MS = 86_400_000;

const calendarTaskInclude = {
  lead: { select: { id: true, number: true, companyName: true } },
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.TaskInclude;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof calendarTaskInclude }>;

const addDays = (d: string, days: number) => ymd(new Date(dateOnly(d).getTime() + days * DAY_MS))!;

/** Date and `HH:MM` of an instant in `timezone` (UTC for an unknown zone). */
function wallClock(at: Date, timezone: string): { date: string; time: string } {
  const parts = (timeZone: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  };
  try {
    return parts(timezone);
  } catch {
    return parts('UTC');
  }
}

/** Prototype order: by date, then time (untimed last), then title. */
const byWhen = (a: CalendarItem, b: CalendarItem) =>
  a.date !== b.date ? (a.date < b.date ? -1 : 1)
    : (a.time ?? '99') !== (b.time ?? '99') ? ((a.time ?? '99') < (b.time ?? '99') ? -1 : 1)
      : a.title.localeCompare(b.title);

function taskItem(t: TaskRow, today: string): CalendarItem {
  const date = ymd(t.dueDate)!;
  const kind = t.kind as TaskKind;
  return {
    kind: 'task', id: t.id, date, time: t.dueTime,
    end: kind !== 'followup' && t.dueTime && t.durationMinutes ? taskEndTime(t.dueTime, t.durationMinutes) : null,
    title: t.title, type: kind, done: t.isDone, overdue: !t.isDone && date < today,
    leadId: t.lead?.id ?? null, leadNumber: t.lead?.number ?? null, company: t.lead?.companyName ?? null,
    ownerId: t.assignedTo.id, ownerName: t.assignedTo.name,
    where: kind === 'call' ? 'Phone' : kind === 'meeting' ? 'Microsoft Teams' : null,
  };
}

/**
 * The caller's own Outlook events on `from`..`to`, in their time zone. A timed event shows on its start date (end capped
 * at 23:59 when it runs past midnight); an all-day event, stored midnight to midnight UTC, shows untimed on each of its
 * own dates, unshifted (taken from the nearest UTC midnight, in case Graph sent its own zone's midnight). `meeting`
 * when anyone (organiser or attendee) is outside the synced mailbox's domain, else `internal`. The lead link is
 * re-checked against what the caller may see now (hidden lead → no link, no company); a company-only match shows the
 * company only when the caller may see it.
 */
async function eventItems(user: AuthUser, from: string, to: string): Promise<CalendarItem[]> {
  // A day either side covers every time zone; exact dates are checked after conversion. Only from a mailbox still
  // syncing its calendar: a run killed before clearing would otherwise leave copied events showing after sync is off.
  const rows = await prisma.calendarEvent.findMany({
    where: {
      userId: user.id, startsAt: { lt: dateOnly(addDays(to, 2)) }, endsAt: { gt: dateOnly(addDays(from, -1)) },
      account: { syncCalendar: true, status: { in: ['connected', 'error'] } },
    },
    include: {
      account: { select: { address: true } },
      lead: { select: { id: true, number: true, companyName: true } },
      company: { select: { name: true } },
    },
  });
  const companyOnly = [...new Set(rows.filter((e) => e.leadId === null && e.companyId !== null).map((e) => e.companyId!))];
  const companies = await visibleCompanyIds(prisma, user, companyOnly);
  const visible = new Map<number, boolean>();
  const out: CalendarItem[] = [];
  for (const e of rows) {
    let lead = e.lead;
    if (lead) {
      if (!visible.has(lead.id)) visible.set(lead.id, await canSeeLead(prisma, user, lead.id));
      if (!visible.get(lead.id)) lead = null;
    }
    const company = e.leadId !== null ? lead?.companyName ?? null
      : e.companyId !== null && companies.has(e.companyId) ? e.company?.name ?? null : null;
    const attendees = (e.attendeeAddresses as string[] | null) ?? [];
    const own = domainOf(e.account.address) ?? '';
    const people = [...attendees, ...(e.organizerAddress ? [e.organizerAddress] : [])];
    const base = {
      kind: 'event' as const, id: e.id, title: e.subject, type: people.some((a) => (domainOf(a) ?? '') !== own) ? 'meeting' as const : 'internal' as const,
      done: false, overdue: false, leadId: lead?.id ?? null, leadNumber: lead?.number ?? null, company,
      ownerId: user.id, ownerName: user.name,
      where: e.location ?? (e.isOnline ? 'Microsoft Teams' : null),
      organizer: e.organizerName ?? e.organizerAddress, attendees,
    };
    if (e.isAllDay) {
      const first = allDayMidnight(e.startsAt, user.timezone);
      const last = ymd(new Date(Math.max(first.getTime(), allDayMidnight(e.endsAt, user.timezone).getTime() - DAY_MS)))!;
      for (let d = ymd(first)!; d <= last; d = addDays(d, 1)) {
        if (d >= from && d <= to) out.push({ ...base, date: d, time: null, end: null });
      }
      continue;
    }
    const start = wallClock(e.startsAt, user.timezone);
    if (start.date < from || start.date > to) continue;
    const finish = wallClock(e.endsAt, user.timezone);
    out.push({ ...base, date: start.date, time: start.time, end: finish.date === start.date ? finish.time : '23:59' });
  }
  return out;
}

export const calendarRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The Calendar page: the caller's tasks (Everyone: every assignee's tasks they may see, administrators only) and
   * their own Outlook events (always only their own, whatever the role) on `from`..`to`, plus every overdue task.
   */
  app.get('/calendar', { preHandler: [requireUser] }, async (request): Promise<CalendarResponse> => {
    const query = parseQuery(CalendarQuery, request.query);
    const user = request.user!;
    const everyone = query.who === 'all' && user.role === 'Administrator';
    const scope: Prisma.TaskWhereInput[] = [taskWhere(user), ...(everyone ? [] : [{ assignedToId: user.id }])];
    const today = todayIn(user.timezone);
    const [inRange, late, events, syncing] = await Promise.all([
      prisma.task.findMany({
        where: { AND: [...scope, { dueDate: { gte: dateOnly(query.from), lte: dateOnly(query.to) } }] },
        include: calendarTaskInclude,
      }),
      prisma.task.findMany({ where: { AND: [...scope, { isDone: false, dueDate: { lt: dateOnly(today) } }] }, include: calendarTaskInclude }),
      eventItems(user, query.from, query.to),
      prisma.emailAccount.count({ where: { kind: 'personal', userId: user.id, status: 'connected', syncCalendar: true } }),
    ]);
    return {
      items: [...inRange.map((t) => taskItem(t, today)), ...events].sort(byWhen),
      overdue: late.map((t) => taskItem(t, today)).sort(byWhen),
      outlook: { syncOn: syncing > 0 },
    };
  });
};
