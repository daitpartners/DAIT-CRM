import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  defaultCurrency, projectCreateSchema, projectFormOptionsQuerySchema, projectListQuerySchema, projectUpdateSchema,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { NotFoundError, parseBody, parseQuery } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { StaleError, isNotFound, isUniqueViolation } from '../prismaErrors.js';
import { RuleError } from '../leads/service.js';
import { leadWhere } from '../leads/visibility.js';
import { todayIn } from '../leads/dates.js';
import { companyWhere } from '../companies/visibility.js';
import { quotationWhere } from '../quotations/visibility.js';
import { projectWhere } from '../projects/visibility.js';
import { sumsByCurrency } from '../quotations/service.js';
import { convertQuotation, createProject, projectRowById, projectRows, updateProject } from '../projects/service.js';

const NOT_ACCEPTED = 'Only an accepted quotation can become a project.';

/**
 * 409 `stale`; RuleError `forbidden` → 403, `not_accepted` → 409 with the prototype's message, `quotation_linked`
 * (or the one-project-per-quotation key) → 409; other rules → 400.
 * `staleOnNotFound`: a P2025 is a concurrent write only on the update path; elsewhere it stays an error.
 */
async function guard<T>(reply: FastifyReply, fn: () => Promise<T>, opts: { staleOnNotFound?: boolean } = {}): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StaleError || (opts.staleOnNotFound && isNotFound(e))) return reply.code(409).send({ error: 'stale' });
    if (e instanceof RuleError) {
      if (e.code === 'forbidden') return reply.code(403).send({ error: e.code });
      if (e.code === 'not_accepted') return reply.code(409).send({ error: e.code, message: NOT_ACCEPTED });
      if (e.code === 'quotation_linked') return reply.code(409).send({ error: e.code });
      return reply.code(400).send({ error: e.code });
    }
    if (isUniqueViolation(e, 'quotation_id')) return reply.code(409).send({ error: 'quotation_linked' });
    throw e;
  }
}

const idOf = (raw: string) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
  return id;
};

export const projectRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The Projects list: visible projects (newest first) narrowed by the Client / Status filters; tiles over every
   * visible project, `clients` = client companies the user can see.
   */
  app.get('/projects', { preHandler: [requireUser] }, async (request) => {
    const query = parseQuery(projectListQuerySchema, request.query);
    const user = request.user!;
    const [all, clients] = await Promise.all([
      projectRows(prisma, user),
      prisma.company.count({ where: { isClient: true, ...companyWhere(user) } }),
    ]);
    const year = todayIn(user.timezone).slice(0, 4);
    const items = all.filter((p) => (!query.company || p.company.id === query.company) && (!query.status || p.status === query.status));
    return {
      items,
      total: items.length,
      tiles: {
        active: all.filter((p) => p.status === 'Active').length,
        clients,
        totals: sumsByCurrency(all.flatMap((p) => (p.value === null ? [] : [{ currency: p.currency as 'USD' | 'CAD' | 'INR', total: p.value }]))),
        completedThisYear: all.filter((p) => p.completedAt !== null && todayIn(user.timezone, new Date(p.completedAt)).slice(0, 4) === year).length,
        onHold: all.filter((p) => p.status === 'On hold').length,
      },
    };
  });

  /**
   * The company profile's Projects tab and the lead page's Projects card: the company's projects the user can see.
   * Open to users who can see the company, a lead of it, or a project of it (a rep on an unassigned lead sees the
   * lead but not its company).
   */
  app.get<{ Params: { id: string } }>('/companies/:id/projects', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const id = idOf(request.params.id);
    // As form-options: the company, a lead of it (archived included: its page still shows the card) or a project of it.
    const company = await prisma.company.findFirst({
      where: {
        id,
        OR: [
          companyWhere(user),
          { leads: { some: leadWhere(user, { includeArchived: true }) } },
          { projects: { some: projectWhere(user) } },
        ],
      },
      select: { id: true, isClient: true },
    });
    if (!company) throw new NotFoundError();
    return { items: await projectRows(prisma, user, { companyId: company.id }), isClient: company.isClient };
  });

  /**
   * The Create / Edit dialog's choices for one client: its leads the user can see, its Accepted quotations with no
   * project, its active contacts, and active users (Project manager). Open to users who can see the company, a lead
   * of it, or a project of it (a project manager may edit without seeing the lead). `project` (the project being
   * edited, visible and the client's, else 404) adds back its own lead (even archived or hidden), quotation and
   * current stakeholders (even deactivated). The lead route in includes archived leads, as GET /companies/:id/projects.
   */
  app.get('/projects/form-options', { preHandler: [requireUser] }, async (request) => {
    const query = parseQuery(projectFormOptionsQuerySchema, request.query);
    const user = request.user!;
    const company = await prisma.company.findFirst({
      where: {
        id: query.company,
        OR: [
          companyWhere(user),
          { leads: { some: leadWhere(user, { includeArchived: true }) } },
          { projects: { some: projectWhere(user) } },
        ],
      },
    });
    if (!company) throw new NotFoundError();
    const project = query.project === undefined
      ? null
      : await prisma.project.findFirst({
        where: { AND: [{ id: query.project, companyId: company.id }, projectWhere(user)] },
        select: { leadId: true, quotationId: true, stakeholders: { select: { contactId: true } } },
      });
    if (query.project !== undefined && !project) throw new NotFoundError();
    const ownLead = project?.leadId != null ? [{ id: project.leadId }] : [];
    const ownQuotation = project?.quotationId != null ? [{ id: project.quotationId }] : [];
    const ownStakeholders = project?.stakeholders.length ? [{ id: { in: project.stakeholders.map((s) => s.contactId) } }] : [];
    const [leads, quotations, contacts, users] = await Promise.all([
      prisma.lead.findMany({
        where: { companyId: company.id, OR: [leadWhere(user), ...ownLead] }, orderBy: { id: 'desc' },
        select: { id: true, number: true, status: true, leadSource: true, contactId: true, contact: { select: { firstName: true, lastName: true } } },
      }),
      prisma.quotation.findMany({
        where: {
          companyId: company.id,
          OR: [{ AND: [{ status: 'Accepted', projectId: null, linkedProject: { is: null } }, quotationWhere(user)] }, ...ownQuotation],
        },
        orderBy: { id: 'desc' }, select: { id: true, number: true, status: true, subject: true, currency: true },
      }),
      prisma.contact.findMany({
        where: { companyId: company.id, OR: [{ isActive: true }, ...ownStakeholders] }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        select: { id: true, firstName: true, lastName: true, designation: true, contactType: true, businessEmail: true, isPrimary: true },
      }),
      prisma.user.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    return {
      company: { id: company.id, name: company.name, legalName: company.legalName, country: company.country, isClient: company.isClient, defaultCurrency: defaultCurrency(company.country) },
      leads: leads.map(({ contact, ...l }) => ({ ...l, contactName: contact ? `${contact.firstName} ${contact.lastName}`.trim() : null })),
      quotations,
      contacts: contacts.map((c) => ({
        id: c.id, name: `${c.firstName} ${c.lastName}`.trim(), designation: c.designation, contactType: c.contactType, email: c.businessEmail,
        isPrimary: c.isPrimary,
      })),
      users,
    };
  });

  app.post('/projects', { preHandler: [requireRight('manage_quotes')] }, async (request, reply) => {
    const body = parseBody(projectCreateSchema, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      const id = await prisma.$transaction((tx) => createProject(tx, user, body));
      return reply.code(201).send(await projectRowById(prisma, user, id));
    });
  });

  app.patch<{ Params: { id: string } }>('/projects/:id', { preHandler: [requireRight('manage_quotes')] }, async (request, reply) => {
    const body = parseBody(projectUpdateSchema, request.body);
    const user = request.user!;
    const id = idOf(request.params.id);
    return guard(reply, async () => {
      await prisma.$transaction((tx) => updateProject(tx, user, id, body));
      return projectRowById(prisma, user, id);
    }, { staleOnNotFound: true });
  });

  /**
   * Convert to project: 201 with the new project, or 200 with the one the quotation already has (a second click, or
   * a concurrent convert that lost the race on the one-project-per-quotation key).
   */
  app.post<{ Params: { id: string } }>('/quotations/:id/convert', { preHandler: [requireRight('manage_quotes')] }, async (request, reply) => {
    const user = request.user!;
    const id = idOf(request.params.id);
    return guard(reply, async () => {
      let result: { id: number; created: boolean };
      try {
        result = await prisma.$transaction((tx) => convertQuotation(tx, user, id));
      } catch (e) {
        if (!isUniqueViolation(e, 'quotation_id')) throw e;
        const existing = await prisma.project.findUnique({ where: { quotationId: id }, select: { id: true } });
        if (!existing) throw e;
        result = { id: existing.id, created: false };
      }
      return reply.code(result.created ? 201 : 200).send(await projectRowById(prisma, user, result.id));
    });
  });
};
