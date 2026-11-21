import type { FastifyPluginAsync } from 'fastify';
import type { Lead, Prisma, Task } from '@prisma/client';
import { TaskCreate, TaskListQuery, TaskUpdate, UpdatedAtOnly, can, isClosedStatus, pageArgs, type TaskListQuery as Query } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { NotFoundError, parseBody, parseQuery } from '../validate.js';
import { requireUser, type AuthUser } from '../plugins/auth.js';
import { StaleError } from '../prismaErrors.js';
import { assertLeadVisible, canUserSeeLead, leadWhere } from '../leads/visibility.js';
import { taskInclude, taskRow } from '../leads/serialize.js';
import { RuleError } from '../leads/service.js';
import { notifyUser } from '../leads/notify.js';
import { dateOnly, todayIn, ymd } from '../leads/dates.js';
import { guard, lockLeads } from './leads.js';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;

/** Tasks the user may see: those on a lead they can see (live leads), and their own tasks with no lead. */
const taskWhere = (user: AuthUser): Prisma.TaskWhereInput => ({
  OR: [{ lead: { AND: [leadWhere(user)] } }, { leadId: null, assignedToId: user.id }],
});

type Tab = Exclude<Query['tab'], 'open'>;
const SECTIONS = ['overdue', 'today', 'upcoming'] as const;

function tabWhere(tab: Tab, today: string): Prisma.TaskWhereInput {
  const day = dateOnly(today);
  switch (tab) {
    case 'today': return { isDone: false, dueDate: day };
    case 'overdue': return { isDone: false, dueDate: { lt: day } };
    case 'upcoming': return { isDone: false, dueDate: { gt: day } };
    case 'done': return { isDone: true };
  }
}

const orderBy = (tab: Tab): Prisma.TaskOrderByWithRelationInput[] =>
  tab === 'done' ? [{ doneAt: 'desc' }, { id: 'desc' }] : [{ dueDate: 'asc' }, { id: 'asc' }];

/** A task's assignee must be active and, for a task on a lead, able to see that lead. */
async function assertTaskAssignee(tx: Tx, assigneeId: number, leadId: number | null): Promise<void> {
  const ok = leadId === null
    ? (await tx.user.count({ where: { id: assigneeId, isActive: true } })) > 0
    : await canUserSeeLead(tx, assigneeId, leadId);
  if (!ok) throw new RuleError('cannot_assign_hidden');
}

const notifyAssignee = (tx: Tx, task: Pick<Task, 'assignedToId' | 'title'>) =>
  notifyUser(tx, task.assignedToId, `Task assigned to you · ${task.title}`, null, '/tasks');

/**
 * The visible task the user may edit, checked against the client's `updatedAt` (409 `stale` when it
 * has moved on). Editing needs more than seeing: the actor is the task's assignee, the lead's
 * assignee, or has `view_all_leads` (else 403 `forbidden`). For a follow-up task the lead row is
 * locked too (returned as `followUpLead`), since the edit is mirrored onto `lead.nextFollowUp`.
 */
async function editableTask(
  tx: Tx, user: AuthUser, id: number, updatedAt: string,
): Promise<{ task: Task; followUpLead: Lead | null }> {
  const found = Number.isInteger(id) ? await tx.task.findFirst({ where: { AND: [{ id }, taskWhere(user)] } }) : null;
  if (!found) throw new NotFoundError();
  let followUpLead: Lead | null = null;
  if (found.leadId !== null) {
    await lockLeads(tx, [found.leadId]);
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: found.leadId } });
    if (found.origin === 'follow_up') followUpLead = lead;
    if (found.assignedToId !== user.id && lead.assignedToId !== user.id && !can(user.role, 'view_all_leads')) {
      throw new RuleError('forbidden');
    }
  } else if (found.assignedToId !== user.id && !can(user.role, 'view_all_leads')) {
    throw new RuleError('forbidden');
  }
  // Re-read under the lead lock: the stale check sees the latest row.
  const task = await tx.task.findUniqueOrThrow({ where: { id } });
  if (new Date(updatedAt).getTime() !== task.updatedAt.getTime()) throw new StaleError();
  return { task, followUpLead };
}

/**
 * Mirrors a follow-up task edit onto its lead: `nextFollowUp` becomes `next` (null when ticked),
 * audited. Without this the next `syncFollowUpTask` would undo the edit. Refuses on a closed lead.
 */
async function mirrorFollowUp(tx: Tx, user: AuthUser, lead: Lead, next: Date | null): Promise<void> {
  if ((lead.nextFollowUp?.getTime() ?? null) === (next?.getTime() ?? null)) return;
  if (next !== null && isClosedStatus(lead.status)) throw new RuleError('lead_closed');
  await tx.lead.update({ where: { id: lead.id }, data: { nextFollowUp: next } });
  await audit(tx, {
    entityType: 'lead', entityId: lead.id, action: 'update', userId: user.id,
    before: { nextFollowUp: ymd(lead.nextFollowUp) }, after: { nextFollowUp: ymd(next) },
  });
}

async function rowOf(id: number, user: AuthUser) {
  const row = await prisma.task.findUniqueOrThrow({ where: { id }, include: taskInclude });
  return taskRow(row, todayIn(user.timezone));
}

export const taskRoutes: FastifyPluginAsync = async (app) => {
  app.get('/tasks', { preHandler: [requireUser] }, async (request, reply) => {
    const query = parseQuery(TaskListQuery, request.query);
    const user = request.user!;
    const everyone = can(user.role, 'view_all_leads');
    const assignedTo = query.assignedTo ?? user.id;
    if (assignedTo !== user.id && !everyone) return reply.code(403).send({ error: 'forbidden' });
    const base: Prisma.TaskWhereInput[] = [taskWhere(user), ...(assignedTo === 'all' ? [] : [{ assignedToId: assignedTo }])];
    const today = todayIn(user.timezone);
    const count = (tab: Tab) => prisma.task.count({ where: { AND: [...base, tabWhere(tab, today)] } });
    const counts = async () => {
      const [todayCount, overdue, upcoming, done] = await Promise.all([count('today'), count('overdue'), count('upcoming'), count('done')]);
      return { today: todayCount, overdue, upcoming, done };
    };

    if (query.tab === 'open') {
      // Every open task, grouped as the Tasks page shows them; each section capped at pageSize.
      const [lists, all] = await Promise.all([
        Promise.all(SECTIONS.map((tab) =>
          prisma.task.findMany({ where: { AND: [...base, tabWhere(tab, today)] }, include: taskInclude, orderBy: orderBy(tab), take: query.pageSize }))),
        counts(),
      ]);
      const sections = Object.fromEntries(SECTIONS.map((tab, i) => [tab, lists[i]!.map((r) => taskRow(r, today))]));
      return { sections, counts: all, pageSize: query.pageSize };
    }

    const tab = query.tab;
    const where: Prisma.TaskWhereInput = { AND: [...base, tabWhere(tab, today)] };
    const [total, rows, all] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({ where, include: taskInclude, orderBy: orderBy(tab), ...pageArgs(query) }),
      counts(),
    ]);
    return {
      items: rows.map((r) => taskRow(r, today)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      counts: all,
    };
  });

  app.post('/tasks', { preHandler: [requireUser] }, async (request, reply) => {
    const body = parseBody(TaskCreate, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const id = await prisma.$transaction(async (tx) => {
        const leadId = body.leadId ?? null;
        if (leadId !== null) await assertLeadVisible(tx, user, leadId);
        await assertTaskAssignee(tx, body.assignedToId, leadId);
        const task = await tx.task.create({
          data: { leadId, title: body.title, dueDate: dateOnly(body.dueDate), assignedToId: body.assignedToId, origin: 'manual' },
        });
        if (task.assignedToId !== user.id) await notifyAssignee(tx, task);
        await audit(tx, { entityType: 'task', entityId: task.id, action: 'create', userId: user.id, after: task });
        return task.id;
      });
      return reply.code(201).send(await rowOf(id, user));
    });
  });

  app.patch<{ Params: { id: string } }>('/tasks/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const { updatedAt, ...body } = parseBody(TaskUpdate, request.body);
    const user = request.user!;
    const id = Number(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { task: before, followUpLead } = await editableTask(tx, user, id, updatedAt);
        const data: Prisma.TaskUncheckedUpdateInput = {};
        if (body.title !== undefined) data.title = body.title;
        if (body.dueDate !== undefined) data.dueDate = dateOnly(body.dueDate);
        if (body.isDone !== undefined && body.isDone !== before.isDone) {
          data.isDone = body.isDone;
          data.doneAt = body.isDone ? new Date() : null;
          if (!body.isDone) data.closedReason = null;
        }
        const reassigned = body.assignedToId !== undefined && body.assignedToId !== before.assignedToId;
        if (reassigned) {
          await assertTaskAssignee(tx, body.assignedToId!, before.leadId);
          data.assignedToId = body.assignedToId;
        }
        const after = await tx.task.update({ where: { id, updatedAt: before.updatedAt }, data });
        // The lead's assignee is left alone on a reassign; only the date / done state is mirrored.
        if (followUpLead) await mirrorFollowUp(tx, user, followUpLead, after.isDone ? null : after.dueDate);
        if (reassigned && after.assignedToId !== user.id) await notifyAssignee(tx, after);
        await audit(tx, { entityType: 'task', entityId: id, action: 'update', userId: user.id, before, after });
      });
      return rowOf(id, user);
    });
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/snooze', { preHandler: [requireUser] }, async (request, reply) => {
    const { updatedAt } = parseBody(UpdatedAtOnly, request.body);
    const user = request.user!;
    const id = Number(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { task: before, followUpLead } = await editableTask(tx, user, id, updatedAt);
        if (before.isDone) throw new RuleError('task_done');
        const dueDate = new Date(dateOnly(todayIn(user.timezone)).getTime() + DAY_MS);
        const after = await tx.task.update({ where: { id, updatedAt: before.updatedAt }, data: { dueDate } });
        if (followUpLead) await mirrorFollowUp(tx, user, followUpLead, after.dueDate);
        await audit(tx, {
          entityType: 'task', entityId: id, action: 'update', userId: user.id,
          before: { dueDate: ymd(before.dueDate) }, after: { dueDate: ymd(after.dueDate), snoozed: true },
        });
      });
      return rowOf(id, user);
    });
  });
};
