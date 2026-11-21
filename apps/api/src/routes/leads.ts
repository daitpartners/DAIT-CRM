import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { Prisma, type Lead } from '@prisma/client';
import {
  CLOSED_STATUSES, CompanyActivityQuery, DuplicateCheck, LeadBulk, LeadCreate, LeadDoNotEmail, LeadListQuery, LeadStatusChange, LeadTransfer, LeadUnassign,
  LeadUpdate, LogCall, MeetingNote, ResearchNote, ResolveCompany, SwitchContact, UpdatedAtOnly, can, checkDomain, isClosedStatus, pageArgs, type CompanyCandidate,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { NotFoundError, ValidationError, parseBody, parseQuery } from '../validate.js';
import { requireRight, requireUser, type AuthUser } from '../plugins/auth.js';
import { assertCompanyVisible, visibleCompanyIds } from '../companies/visibility.js';
import { findCompanyMatches } from '../companies/match.js';
import { StaleError, isNotFound, isUniqueViolation } from '../prismaErrors.js';
import { assertLeadVisible, leadWhere } from '../leads/visibility.js';
import {
  activityInclude, activityRow, assignmentInclude, assignmentRow, leadDetail, leadDetailInclude, leadSummary,
  leadSummaryInclude, taskInclude, taskRow,
} from '../leads/serialize.js';
import {
  RuleError, applyStatusChange, auditCreatedLead, companyDataFromLead, createLeadWithCompany, recordAssignment,
  syncFollowUpTask,
} from '../leads/service.js';
import { dateOnly, todayIn } from '../leads/dates.js';

type Tx = Prisma.TransactionClient;

const ACTIVITY_PAGE_SIZE = 15;
const WEBSITE_SOURCE = 'Website Contact Form';
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ errors */

/** RuleError codes answered with 409; `forbidden` is a 403; every other rule refusal is a 400. */
const CONFLICT_CODES = new Set(['stale', 'company_inactive', 'already_assigned', 'company_already_linked']);

/** Maps a business-rule / concurrency error to its HTTP reply; anything else is rethrown. */
export async function guard<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StaleError || isNotFound(e)) return reply.code(409).send({ error: 'stale' });
    if (e instanceof RuleError) {
      const code = e.code === 'forbidden' ? 403 : CONFLICT_CODES.has(e.code) ? 409 : 400;
      return reply.code(code).send({ error: e.code });
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Who `user` may assign a lead to: Administrator / Manager anyone active, Sales Representative
 * self or nobody, Data Research User self only. `null` = unassigned.
 */
export async function assertAssignable(tx: Tx, user: AuthUser, toUserId: number | null): Promise<void> {
  const everyone = can(user.role, 'view_all_leads');
  if (toUserId === null) {
    if (everyone || user.role === 'Sales Representative') return;
    throw new RuleError('cannot_assign_hidden');
  }
  if (!everyone && toUserId !== user.id) throw new RuleError('cannot_assign_hidden');
  const active = await tx.user.count({ where: { id: toUserId, isActive: true } });
  if (active === 0) throw new RuleError('cannot_assign_hidden');
}

/**
 * The visible lead (archived included), checked against the client's `updatedAt` and touched
 * under that same `updatedAt`: the row is locked for the rest of the transaction and a concurrent
 * write since the client read it is a 409 `stale`. Refuses an archived lead unless `allowArchived`.
 */
export async function lockFresh(
  tx: Tx, user: AuthUser, id: number, updatedAt: string, opts: { allowArchived?: boolean } = {},
): Promise<{ before: Lead; lead: Lead }> {
  const before = await assertLeadVisible(tx, user, id, { includeArchived: true });
  if (new Date(updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
  if (before.archivedAt && !opts.allowArchived) throw new RuleError('lead_archived');
  const lead = await tx.lead.update({ where: { id, updatedAt: before.updatedAt }, data: { updatedAt: new Date() } });
  return { before, lead };
}

async function detailOf(db: Tx | typeof prisma, id: number, user: AuthUser) {
  const row = await db.lead.findUnique({ where: { id }, include: leadDetailInclude });
  if (!row) throw new NotFoundError();
  return leadDetail(row, todayIn(user.timezone));
}

/** 409 body for a domain unique violation: names the company holding the domain. */
export async function domainTaken(domain: string | null) {
  if (!domain) return null;
  const holder = await prisma.company.findFirst({ where: { domain }, select: { id: true } });
  return holder ? { error: 'domain_taken', companyId: holder.id } : null;
}

const leadId = (raw: string) => Number(raw);

/* ------------------------------------------------------------------ list */

function orderBy(sort: LeadListQuery['sort'], dir: 'asc' | 'desc'): Prisma.LeadOrderByWithRelationInput[] {
  const key = sort ?? 'createdAt';
  const tie: Prisma.LeadOrderByWithRelationInput = { id: dir };
  switch (key) {
    case 'contact':
      return [{ contact: { lastName: dir } }, { contact: { firstName: dir } }, tie];
    case 'assignedTo':
      return [{ assignedTo: { name: dir } }, tie];
    case 'nextFollowUp':
      return [{ nextFollowUp: { sort: dir, nulls: 'last' } }, tie];
    default:
      return [{ [key]: dir }, tie];
  }
}

/** Leads with an open follow-up task due before `today` that are still open. */
const overdueWhere = (today: string): Prisma.LeadWhereInput => ({
  status: { notIn: [...CLOSED_STATUSES] },
  tasks: { some: { origin: 'follow_up', isDone: false, dueDate: { lt: dateOnly(today) } } },
});

function tabWhere(tab: LeadListQuery['tab'], user: AuthUser, today: string): Prisma.LeadWhereInput {
  switch (tab) {
    case 'leads': return { leadType: 'Lead' };
    case 'prospects': return { leadType: 'Prospect' };
    case 'mine': return { assignedToId: user.id };
    case 'overdue': return overdueWhere(today);
    case 'unassigned': return { assignedToId: null };
    default: return {};
  }
}

function filterWhere(query: LeadListQuery): Prisma.LeadWhereInput[] {
  const and: Prisma.LeadWhereInput[] = [];
  if (query.companyId !== undefined) and.push({ companyId: query.companyId });
  if (query.status) and.push({ status: query.status });
  if (query.source) and.push({ leadSource: query.source });
  if (query.country) and.push({ country: { equals: query.country, mode: 'insensitive' } });
  if (query.assignedTo !== undefined) and.push({ assignedToId: query.assignedTo === 'none' ? null : query.assignedTo });
  if (query.leadType) and.push({ leadType: query.leadType });
  if (query.language) and.push({ outreachLanguage: query.language });
  if (query.priority) and.push({ priority: query.priority });
  if (query.from) and.push({ createdAt: { gte: dateOnly(query.from) } });
  if (query.to) and.push({ createdAt: { lt: new Date(dateOnly(query.to).getTime() + DAY_MS) } });
  if (query.q) {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    and.push({
      OR: [
        { number: contains }, { companyName: contains }, { businessEmail: contains },
        { contact: { firstName: contains } }, { contact: { lastName: contains } },
      ],
    });
  }
  return and;
}

/** Open follow-up tasks on visible, live, open leads: mine (or everyone's with view_all_leads). */
function followUpTasks(user: AuthUser, dueDate: Prisma.DateTimeFilter): Prisma.TaskWhereInput {
  return {
    origin: 'follow_up', isDone: false, dueDate,
    ...(can(user.role, 'view_all_leads') ? {} : { assignedToId: user.id }),
    lead: { AND: [leadWhere(user), { status: { notIn: [...CLOSED_STATUSES] } }] },
  };
}

/* ------------------------------------------------------------------ routes */

export const leadRoutes: FastifyPluginAsync = async (app) => {
  app.get('/leads', { preHandler: [requireUser] }, async (request, reply) => {
    const query = parseQuery(LeadListQuery, request.query);
    const user = request.user!;
    if (query.archived === '1' && !can(user.role, 'view_all_leads')) return reply.code(403).send({ error: 'forbidden' });
    const today = todayIn(user.timezone);
    const visible = leadWhere(user, { includeArchived: query.archived === '1' });
    const live = leadWhere(user);
    const where: Prisma.LeadWhereInput = { AND: [visible, tabWhere(query.tab, user, today), ...filterWhere(query)] };
    const countTab = (tab: LeadListQuery['tab']) => prisma.lead.count({ where: { AND: [live, tabWhere(tab, user, today)] } });
    const weekAgo = new Date(Date.now() - 7 * DAY_MS);
    const dir = query.sort ? query.dir : 'desc';

    const [total, rows, all, leads, prospects, mine, overdue, unassigned, newThisWeek, newFromWebsite, dueToday, overdueTasks] =
      await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.findMany({ where, include: leadSummaryInclude, orderBy: orderBy(query.sort, dir), ...pageArgs(query) }),
        countTab('all'), countTab('leads'), countTab('prospects'), countTab('mine'), countTab('overdue'), countTab('unassigned'),
        prisma.lead.count({ where: { AND: [live, { createdAt: { gte: weekAgo } }] } }),
        prisma.lead.count({ where: { AND: [live, { createdAt: { gte: weekAgo }, leadSource: WEBSITE_SOURCE }] } }),
        prisma.task.count({ where: followUpTasks(user, { equals: dateOnly(today) }) }),
        prisma.task.count({ where: followUpTasks(user, { lt: dateOnly(today) }) }),
      ]);
    return {
      items: rows.map((r) => leadSummary(r, today)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      tiles: { newThisWeek, newThisWeekFromWebsite: newFromWebsite, followUpsDueToday: dueToday, overdue: overdueTasks, unassigned },
      counts: { all, leads, prospects, mine, overdue, unassigned },
    };
  });

  app.post('/leads', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(LeadCreate, request.body);
    const user = request.user!;
    const domain = checkDomain({ website: body.website ?? undefined, businessEmail: body.businessEmail ?? undefined });
    try {
      return await guard(reply, async () => {
        const id = await prisma.$transaction(async (tx) => {
          if (body.assignedToId != null) await assertAssignable(tx, user, body.assignedToId);
          const created = await createLeadWithCompany(tx, body, user);
          await auditCreatedLead(tx, user.id, created);
          return created.lead.id;
        });
        return reply.code(201).send(await detailOf(prisma, id, user));
      });
    } catch (e) {
      if (isUniqueViolation(e, 'domain')) {
        const taken = await domainTaken(domain);
        if (taken) return reply.code(409).send(taken);
      }
      throw e;
    }
  });

  app.post('/leads/check-duplicates', { preHandler: [requireUser] }, async (request) => {
    const body = parseBody(DuplicateCheck, request.body);
    const matches = await findCompanyMatches(prisma, body);
    const ids = [...(matches.auto ? [matches.auto.id] : []), ...matches.review.map((r) => r.candidate.id)];
    const visible = await visibleCompanyIds(prisma, request.user!, ids);
    // A hidden company is still reported (id, number, name) so the user knows it exists.
    const shown = (c: CompanyCandidate) => (visible.has(c.id) ? c : { id: c.id, number: c.number, name: c.name });
    return {
      auto: matches.auto ? shown(matches.auto) : null,
      review: matches.review.map((r) => ({ candidate: shown(r.candidate), how: r.how })),
    };
  });

  app.post('/leads/bulk', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(LeadBulk, request.body);
    const user = request.user!;
    if (body.action === 'assign' && body.toUserId === undefined) {
      throw new ValidationError([{ path: ['toUserId'], message: 'Required for assign' }]);
    }
    return guard(reply, async () => {
      const updated = await prisma.$transaction(async (tx) => {
        if (body.action === 'assign') return bulkAssign(tx, user, body.ids, body.toUserId ?? null, body.note);
        return bulkArchive(tx, user, body.ids, body.action === 'archive');
      });
      return { updated };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { activitiesPage?: string } }>(
    '/leads/:id', { preHandler: [requireUser] }, async (request) => {
      const user = request.user!;
      const page = request.query.activitiesPage === undefined ? 1 : Number(request.query.activitiesPage);
      if (!Number.isInteger(page) || page < 1) {
        throw new ValidationError([{ path: ['activitiesPage'], message: 'Must be a positive whole number' }]);
      }
      const { id } = await assertLeadVisible(prisma, user, leadId(request.params.id), { includeArchived: true });
      const today = todayIn(user.timezone);
      const [row, activityTotal, callCount, lastContact, activities, assignments, tasks] = await Promise.all([
        prisma.lead.findUnique({ where: { id }, include: leadDetailInclude }),
        prisma.leadActivity.count({ where: { leadId: id } }),
        // The lead page's "Calls {n}" tab and "Last contact: {type · when}" line.
        prisma.leadActivity.count({ where: { leadId: id, activityType: 'call' } }),
        prisma.leadActivity.findFirst({
          where: { leadId: id, activityType: { in: ['call', 'email', 'meeting'] }, occurredAt: { lte: new Date() } },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], select: { activityType: true, occurredAt: true },
        }),
        prisma.leadActivity.findMany({
          where: { leadId: id }, include: activityInclude, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * ACTIVITY_PAGE_SIZE, take: ACTIVITY_PAGE_SIZE,
        }),
        prisma.leadAssignment.findMany({ where: { leadId: id }, include: assignmentInclude, orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }] }),
        prisma.task.findMany({ where: { leadId: id, isDone: false }, include: taskInclude, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] }),
      ]);
      if (!row) throw new NotFoundError();
      return {
        ...leadDetail(row, today),
        activities: activities.map((a) => activityRow(a, user.id)),
        activityTotal,
        callCount,
        lastContact: lastContact ? { type: lastContact.activityType, at: lastContact.occurredAt } : null,
        assignments: assignments.map(assignmentRow),
        tasks: tasks.map((t) => taskRow(t, today)),
      };
    },
  );

  /** Activities of the company's leads the user may see (live leads), newest first, with the lead's number. */
  app.get<{ Params: { id: string } }>('/companies/:id/activities', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const query = parseQuery(CompanyActivityQuery, request.query);
    const company = await assertCompanyVisible(prisma, user, Number(request.params.id));
    const where: Prisma.LeadActivityWhereInput = { lead: { AND: [{ companyId: company.id }, leadWhere(user)] } };
    const [total, rows, byType, last] = await Promise.all([
      prisma.leadActivity.count({ where }),
      prisma.leadActivity.findMany({
        where, include: { ...activityInclude, lead: { select: { id: true, number: true } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], ...pageArgs(query),
      }),
      prisma.leadActivity.groupBy({ by: ['activityType'], where, _count: { _all: true } }),
      // A meeting may be dated ahead; the last touch is the latest one that has already happened.
      prisma.leadActivity.aggregate({ where: { AND: [where, { occurredAt: { lte: new Date() } }] }, _max: { occurredAt: true } }),
    ]);
    const ofType = (type: string) => byType.find((g) => g.activityType === type)?._count._all ?? 0;
    return {
      items: rows.map((r) => ({ ...activityRow(r, request.user!.id), lead: { id: r.lead.id, number: r.lead.number } })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      // The prototype's "Activity summary" card: counts across every page, and the last touch.
      summary: {
        call: ofType('call'), email: ofType('email'), meeting: ofType('meeting'), quote: ofType('quote'),
        lastAt: last._max.occurredAt?.toISOString() ?? null,
      },
    };
  });

  app.patch<{ Params: { id: string } }>('/leads/:id', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const { updatedAt, nextFollowUp, ...body } = parseBody(LeadUpdate, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { before } = await lockFresh(tx, user, id, updatedAt);
        // A closed lead keeps no follow-up (as Log call): refuse setting one.
        if (nextFollowUp && isClosedStatus(before.status)) throw new RuleError('lead_closed');
        const data: Prisma.LeadUncheckedUpdateInput = { ...body };
        if (nextFollowUp !== undefined) data.nextFollowUp = nextFollowUp ? dateOnly(nextFollowUp) : null;
        const after = await tx.lead.update({ where: { id }, data });
        if (nextFollowUp !== undefined || body.companyName !== undefined) await syncFollowUpTask(tx, after);
        await audit(tx, { entityType: 'lead', entityId: id, action: 'update', userId: user.id, before, after });
      });
      return detailOf(prisma, id, user);
    });
  });

  app.post<{ Params: { id: string } }>('/leads/:id/status', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(LeadStatusChange, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { before, lead } = await lockFresh(tx, user, id, body.updatedAt);
        const after = await applyStatusChange(tx, lead, body.status, { userId: user.id }, { reason: body.reason ?? undefined });
        await audit(tx, {
          entityType: 'lead', entityId: id, action: 'update', userId: user.id,
          before: { status: before.status }, after: { status: after.status, reason: body.reason ?? null },
        });
      });
      return detailOf(prisma, id, user);
    });
  });

  // Do not email (release 2C, prototype Edit profile): the Mailer skips the lead; the contact is stamped unsubscribed.
  app.post<{ Params: { id: string } }>('/leads/:id/do-not-email', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(LeadDoNotEmail, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { lead } = await lockFresh(tx, user, id, body.updatedAt);
        if (lead.doNotEmail === body.doNotEmail) return;
        await tx.lead.update({ where: { id }, data: { doNotEmail: body.doNotEmail } });
        if (lead.contactId) await tx.contact.update({ where: { id: lead.contactId }, data: { unsubscribedAt: body.doNotEmail ? new Date() : null } });
        await tx.leadActivity.create({
          data: body.doNotEmail
            ? { leadId: id, activityType: 'note', title: 'Marked do not email', body: 'The mailer will skip this lead.', byUserId: user.id }
            : { leadId: id, activityType: 'note', title: 'Do not email removed', body: 'The mailer may email this lead again.', byUserId: user.id },
        });
        await audit(tx, { entityType: 'lead', entityId: id, action: 'update', userId: user.id, before: { doNotEmail: lead.doNotEmail }, after: { doNotEmail: body.doNotEmail } });
      });
      return detailOf(prisma, id, user);
    });
  });

  app.post<{ Params: { id: string } }>('/leads/:id/log-call', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(LogCall, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { before, lead } = await lockFresh(tx, user, id, body.updatedAt);
        const text = body.body ?? null;
        const minutes = body.minutes !== undefined ? `${body.minutes} min` : null;
        await tx.leadActivity.create({
          data: {
            leadId: id, activityType: 'call', title: `Call · ${body.outcome}`,
            body: minutes && text ? `${minutes} · ${text}` : (minutes ?? text), byUserId: user.id,
          },
        });
        let current = lead;
        if (body.statusAfter) {
          current = await applyStatusChange(tx, current, body.statusAfter, { userId: user.id }, { sourceTitle: 'Log call' });
        }
        // A closed lead keeps no follow-up.
        if (body.nextFollowUp !== undefined && !isClosedStatus(current.status)) {
          current = await tx.lead.update({
            where: { id }, data: { nextFollowUp: body.nextFollowUp ? dateOnly(body.nextFollowUp) : null },
          });
          await syncFollowUpTask(tx, current);
        }
        await audit(tx, {
          entityType: 'lead', entityId: id, action: 'update', userId: user.id,
          before: { status: before.status, nextFollowUp: before.nextFollowUp },
          after: { status: current.status, nextFollowUp: current.nextFollowUp, call: body.outcome },
        });
      });
      return detailOf(prisma, id, user);
    });
  });

  /** Research and meeting notes: one timeline activity each; the lead is touched (stale check) and audited. */
  app.post<{ Params: { id: string } }>('/leads/:id/research', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(ResearchNote, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      const row = await prisma.$transaction(async (tx) => {
        await lockFresh(tx, user, id, body.updatedAt);
        const activity = await tx.leadActivity.create({
          data: { leadId: id, activityType: 'research', title: body.title, url: body.url ?? null, body: body.body ?? null, byUserId: user.id },
          include: activityInclude,
        });
        await audit(tx, {
          entityType: 'lead', entityId: id, action: 'update', userId: user.id,
          after: { research: body.title, url: activity.url, activityId: activity.id },
        });
        return activity;
      });
      return reply.code(201).send(activityRow(row));
    });
  });

  app.post<{ Params: { id: string } }>('/leads/:id/meeting', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(MeetingNote, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      const row = await prisma.$transaction(async (tx) => {
        await lockFresh(tx, user, id, body.updatedAt);
        const activity = await tx.leadActivity.create({
          data: {
            leadId: id, activityType: 'meeting', title: body.title, body: body.body ?? null,
            occurredAt: new Date(body.occurredAt), byUserId: user.id,
          },
          include: activityInclude,
        });
        await audit(tx, {
          entityType: 'lead', entityId: id, action: 'update', userId: user.id,
          after: { meeting: body.title, occurredAt: activity.occurredAt, activityId: activity.id },
        });
        return activity;
      });
      return reply.code(201).send(activityRow(row));
    });
  });

  app.post<{ Params: { id: string } }>('/leads/:id/contact', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(SwitchContact, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { before } = await lockFresh(tx, user, id, body.updatedAt);
        let title = 'Contact cleared';
        if (body.contactId !== null) {
          const contact = before.companyId === null
            ? null
            : await tx.contact.findFirst({ where: { id: body.contactId, companyId: before.companyId, isActive: true } });
          if (!contact) {
            throw new ValidationError([{ path: ['contactId'], message: 'Contact must be an active contact of the lead\'s company' }]);
          }
          title = `Contact switched to ${`${contact.firstName} ${contact.lastName}`.trim()}`;
        }
        if (before.contactId === body.contactId) return;
        await tx.lead.update({ where: { id }, data: { contactId: body.contactId } });
        await tx.leadActivity.create({ data: { leadId: id, activityType: 'assign', title, byUserId: user.id } });
        await audit(tx, {
          entityType: 'lead', entityId: id, action: 'update', userId: user.id,
          before: { contactId: before.contactId }, after: { contactId: body.contactId },
        });
      });
      return detailOf(prisma, id, user);
    });
  });

  /**
   * Resolves the company of a lead imported with an unresolved duplicate (company null): links
   * a visible company (and its primary contact) or creates one from the lead's details.
   */
  app.post<{ Params: { id: string } }>(
    '/leads/:id/resolve-company', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
      const body = parseBody(ResolveCompany, request.body);
      const user = request.user!;
      const id = leadId(request.params.id);
      let domain: string | null = null;
      try {
        return await guard(reply, async () => {
          await prisma.$transaction(async (tx) => {
            const { before } = await lockFresh(tx, user, id, body.updatedAt);
            if (before.companyId !== null) throw new RuleError('company_already_linked');
            let company;
            if (body.companyId === 'create') {
              const data = companyDataFromLead(before, user.id);
              domain = data.domain ?? null;
              company = await tx.company.create({ data });
              await audit(tx, { entityType: 'company', entityId: company.id, action: 'create', userId: user.id, after: company });
            } else {
              company = await assertCompanyVisible(tx, user, body.companyId);
            }
            const contactId = (await tx.contact.findFirst({
              where: { companyId: company.id, isPrimary: true, isActive: true }, select: { id: true },
            }))?.id ?? null;
            await tx.lead.update({ where: { id }, data: { companyId: company.id, contactId } });
            await tx.leadActivity.create({
              data: {
                leadId: id, activityType: 'note', byUserId: user.id,
                title: body.companyId === 'create' ? `Company ${company.number} created` : `Linked to company ${company.number}`,
              },
            });
            await audit(tx, {
              entityType: 'lead', entityId: id, action: 'update', userId: user.id,
              before: { companyId: null, contactId: before.contactId }, after: { companyId: company.id, contactId },
            });
          });
          return detailOf(prisma, id, user);
        });
      } catch (e) {
        if (isUniqueViolation(e, 'domain')) {
          const taken = await domainTaken(domain);
          if (taken) return reply.code(409).send(taken);
        }
        throw e;
      }
    },
  );

  for (const action of ['archive', 'unarchive'] as const) {
    app.post<{ Params: { id: string } }>(`/leads/:id/${action}`, { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
      const body = parseBody(UpdatedAtOnly, request.body);
      const user = request.user!;
      const id = leadId(request.params.id);
      return guard(reply, async () => {
        await prisma.$transaction(async (tx) => {
          const { before } = await lockFresh(tx, user, id, body.updatedAt, { allowArchived: true });
          if ((before.archivedAt !== null) === (action === 'archive')) return;
          const archivedAt = action === 'archive' ? new Date() : null;
          await tx.lead.update({ where: { id }, data: { archivedAt } });
          await audit(tx, {
            entityType: 'lead', entityId: id, action: 'update', userId: user.id,
            before: { archivedAt: before.archivedAt }, after: { archivedAt },
          });
        });
        return detailOf(prisma, id, user);
      });
    });
  }

  /* ---------------------------------------------------------------- transfer, claim, unassign */

  app.post<{ Params: { id: string } }>('/leads/:id/transfer', { preHandler: [requireRight('transfer_leads')] }, async (request, reply) => {
    const body = parseBody(LeadTransfer, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { lead } = await lockFresh(tx, user, id, body.updatedAt);
        if (body.toUserId !== user.id && !body.note) throw new RuleError('transfer_note_required');
        if ((await tx.user.count({ where: { id: body.toUserId, isActive: true } })) === 0) throw new RuleError('unknown_user');
        await assertAssignable(tx, user, body.toUserId);
        await assignAndAudit(tx, user, lead, body.toUserId, body.note);
      });
      return detailOf(prisma, id, user);
    });
  });

  app.post<{ Params: { id: string } }>('/leads/:id/claim', { preHandler: [requireRight('claim_leads')] }, async (request, reply) => {
    const body = parseBody(UpdatedAtOnly, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { lead } = await lockFresh(tx, user, id, body.updatedAt);
        if (lead.assignedToId !== null) throw new RuleError('already_assigned');
        await assignAndAudit(tx, user, lead, user.id);
      });
      return detailOf(prisma, id, user);
    });
  });

  app.post<{ Params: { id: string } }>('/leads/:id/unassign', { preHandler: [requireRight('view_all_leads')] }, async (request, reply) => {
    const body = parseBody(LeadUnassign, request.body);
    const user = request.user!;
    const id = leadId(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction(async (tx) => {
        const { lead } = await lockFresh(tx, user, id, body.updatedAt);
        await assignAndAudit(tx, user, lead, null, body.note);
      });
      return detailOf(prisma, id, user);
    });
  });
};

/** Hands the (locked) lead to `toUserId` (null = unassign) and audits it; no-op when unchanged. */
async function assignAndAudit(tx: Tx, user: AuthUser, lead: Lead, toUserId: number | null, note?: string): Promise<void> {
  if (lead.assignedToId === toUserId) return;
  await recordAssignment(tx, lead, toUserId, { userId: user.id, note });
  await audit(tx, {
    entityType: 'lead', entityId: lead.id, action: 'update', userId: user.id,
    before: { assignedToId: lead.assignedToId }, after: { assignedToId: toUserId, note: note ?? null },
  });
}

/* ------------------------------------------------------------------ bulk */

/**
 * Locks the lead rows among `ids` for the rest of the transaction (`FOR UPDATE`, id order so
 * concurrent bulk calls cannot deadlock). Read after this, the rows cannot change under us.
 */
export async function lockLeads(tx: Tx, ids: number[]): Promise<void> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  await tx.$queryRaw`SELECT id FROM leads WHERE id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`;
}

/**
 * Assigns the visible, live leads among `ids` to `toUserId` (null = unassign). A note is required
 * when any of them is currently with someone else. Returns how many changed hands.
 *
 * Rights: unassigning needs `view_all_leads`. Without `transfer_leads` this is a bulk claim: the
 * target must be the actor, who needs `claim_leads`, and every lead that would move must be
 * unassigned. Anything else is 403 `forbidden`.
 */
async function bulkAssign(tx: Tx, user: AuthUser, ids: number[], toUserId: number | null, note?: string): Promise<number> {
  const transfer = can(user.role, 'transfer_leads');
  if (toUserId === null) {
    if (!can(user.role, 'view_all_leads')) throw new RuleError('forbidden');
  } else if (!transfer && (toUserId !== user.id || !can(user.role, 'claim_leads'))) {
    throw new RuleError('forbidden');
  }
  await assertAssignable(tx, user, toUserId);
  await lockLeads(tx, ids);
  const rows = await tx.lead.findMany({ where: { AND: [{ id: { in: ids } }, leadWhere(user)] }, orderBy: { id: 'asc' } });
  const moving = rows.filter((r) => r.assignedToId !== toUserId);
  if (!transfer && moving.some((r) => r.assignedToId !== null)) throw new RuleError('forbidden');
  if (!note?.trim() && moving.some((r) => r.assignedToId !== null)) throw new RuleError('transfer_note_required');
  for (const lead of moving) await assignAndAudit(tx, user, lead, toUserId, note?.trim() || undefined);
  return moving.length;
}

/** Archives (or restores) the visible leads among `ids`; returns how many changed. */
async function bulkArchive(tx: Tx, user: AuthUser, ids: number[], archive: boolean): Promise<number> {
  await lockLeads(tx, ids);
  const rows = await tx.lead.findMany({
    where: { AND: [{ id: { in: ids } }, leadWhere(user, { includeArchived: true }), { archivedAt: archive ? null : { not: null } }] },
    select: { id: true, archivedAt: true },
    orderBy: { id: 'asc' },
  });
  if (rows.length === 0) return 0;
  const archivedAt = archive ? new Date() : null;
  await tx.lead.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { archivedAt } });
  for (const r of rows) {
    await audit(tx, {
      entityType: 'lead', entityId: r.id, action: 'update', userId: user.id,
      before: { archivedAt: r.archivedAt }, after: { archivedAt },
    });
  }
  return rows.length;
}
