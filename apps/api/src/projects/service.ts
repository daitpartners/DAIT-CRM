import type { Prisma, PrismaClient, Project } from '@prisma/client';
import { primaryStakeholderIds, quoteTotals, round2, type ProjectCreate, type ProjectUpdate } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { audit } from '../audit.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { StaleError } from '../prismaErrors.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import { assertLeadVisible, leadWhere } from '../leads/visibility.js';
import { RuleError } from '../leads/service.js';
import { notifyUser } from '../leads/notify.js';
import { dateOnly, todayIn, ymd } from '../leads/dates.js';
import { appendHistory, lockVisibleQuotation } from '../quotations/service.js';
import { canEditQuotation, quotationWhere } from '../quotations/visibility.js';
import { nextProjectNumber } from './number.js';
import { canCreateProject, canEditProject, projectWhere } from './visibility.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

/* ------------------------------------------------------------------ serializer */

export const projectInclude = {
  company: { select: { id: true, name: true } },
  lead: { select: { id: true, number: true, assignedToId: true } },
  quotation: { select: { id: true, number: true } },
  manager: { select: { id: true, name: true } },
  stakeholders: {
    select: { contact: { select: { id: true, firstName: true, lastName: true, businessEmail: true } } },
    orderBy: [{ contact: { firstName: 'asc' } }, { contact: { lastName: 'asc' } }],
  },
} satisfies Prisma.ProjectInclude;

type ProjectRowData = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

/** A project as the list, the company tab and the dialog see it. */
export function projectRow(p: ProjectRowData, user: AuthUser) {
  return {
    id: p.id,
    number: p.number,
    name: p.name,
    status: p.status,
    startDate: ymd(p.startDate),
    value: p.value === null ? null : Number(p.value),
    currency: p.currency,
    company: p.company,
    lead: p.lead ? { id: p.lead.id, number: p.lead.number } : null,
    quotation: p.quotation,
    manager: p.manager,
    stakeholders: p.stakeholders.map(({ contact: c }) => ({ id: c.id, name: fullName(c), email: c.businessEmail })),
    description: p.description,
    completedAt: p.completedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    canEdit: canEditProject(user, p),
  };
}
export type ProjectRow = ReturnType<typeof projectRow>;

/** Visible projects matching `where`, newest first, as rows. */
export async function projectRows(db: Db, user: AuthUser, where: Prisma.ProjectWhereInput = {}): Promise<ProjectRow[]> {
  const rows = await db.project.findMany({
    where: { AND: [projectWhere(user), where] }, include: projectInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map((r) => projectRow(r, user));
}

/** One visible project as a row (NotFoundError when hidden). */
export async function projectRowById(db: Db, user: AuthUser, id: number): Promise<ProjectRow> {
  const p = await db.project.findFirst({ where: { AND: [{ id }, projectWhere(user)] }, include: projectInclude });
  if (!p) throw new NotFoundError();
  return projectRow(p, user);
}

/* ------------------------------------------------------------------ checks */

async function assertActiveManager(tx: Tx, managerId: number): Promise<void> {
  if ((await tx.user.count({ where: { id: managerId, isActive: true } })) === 0) {
    throw new ValidationError([{ path: ['managerId'], message: 'Project manager must be an active user' }]);
  }
}

/** Every id is a contact of the company that is active (or in `keep`, the project's current stakeholders). */
async function assertStakeholders(tx: Tx, companyId: number, ids: number[], keep: number[] = []): Promise<void> {
  if (ids.length === 0) return;
  const ok = await tx.contact.count({ where: { id: { in: ids }, companyId, OR: [{ isActive: true }, { id: { in: keep } }] } });
  if (ok !== ids.length) throw new ValidationError([{ path: ['stakeholderIds'], message: 'Stakeholders must be contacts of the client' }]);
}

/**
 * The quotation to link, locked FOR UPDATE: visible to the user, the client's, Accepted, and not linked to another
 * project (400 otherwise). `projectId` is the project being edited (its own quotation is fine).
 */
async function lockLinkableQuotation(tx: Tx, user: AuthUser, companyId: number, quotationId: number, projectId: number | null) {
  const visible = await tx.quotation.findFirst({ where: { AND: [{ id: quotationId }, quotationWhere(user)] }, select: { id: true } });
  if (visible) await tx.$queryRaw`SELECT id FROM quotations WHERE id = ${quotationId} FOR UPDATE`;
  const q = visible
    ? await tx.quotation.findUnique({ where: { id: quotationId }, include: { linkedProject: { select: { id: true } } } })
    : null;
  const free = (id: number | null | undefined) => id == null || id === projectId;
  if (!q || q.companyId !== companyId || q.status !== 'Accepted' || !free(q.projectId) || !free(q.linkedProject?.id)) {
    throw new ValidationError([{ path: ['quotationId'], message: 'Quotation must be an accepted quotation of the client with no project' }]);
  }
  return q;
}

/** Points the quotation at the project (the project row already carries quotationId) and writes its history. */
async function linkQuotation(tx: Tx, user: AuthUser, q: { id: number; history: Prisma.JsonValue }, project: Pick<Project, 'id' | 'number'>, text: string): Promise<void> {
  await tx.quotation.update({ where: { id: q.id }, data: { projectId: project.id, history: appendHistory(q, `${text} ${project.number}`) } });
  await audit(tx, { entityType: 'quotation', entityId: q.id, action: 'update', userId: user.id, before: { projectId: null }, after: { projectId: project.id } });
}

/* ------------------------------------------------------------------ create */

/**
 * After any create (prototype createProject): the company becomes a client; with a lead, the timeline entry
 * "Project created · PRJ-n <name>" listing the stakeholders; the manager is notified unless they created it; audit.
 */
async function recordCreated(tx: Tx, user: AuthUser, p: Project, leadNumber: string | null): Promise<void> {
  const company = await tx.company.update({ where: { id: p.companyId }, data: { isClient: true }, select: { name: true } });
  if (p.leadId !== null) {
    const contacts = await tx.contact.findMany({
      where: { projectStakeholders: { some: { projectId: p.id } } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      select: { firstName: true, lastName: true },
    });
    await tx.leadActivity.create({
      data: {
        leadId: p.leadId, activityType: 'status', title: `Project created · ${p.number} ${p.name}`,
        body: contacts.length ? `Stakeholders: ${contacts.map(fullName).join(', ')}` : null,
        relatedType: 'project', relatedId: p.id, byUserId: user.id,
      },
    });
  }
  if (p.managerId !== user.id) {
    await notifyUser(tx, p.managerId, `Project created · ${p.name}`, `${company.name}${leadNumber ? ` · from ${leadNumber}` : ''}`, '/projects');
  }
  await audit(tx, { entityType: 'project', entityId: p.id, action: 'create', userId: user.id, after: p });
}

/**
 * `POST /projects` (Create project dialog). With a lead it must be visible, the client's, and the user its assignee,
 * the manager or `view_all_leads` (403); without one the company must be visible. A chosen quotation is linked.
 */
export async function createProject(tx: Tx, user: AuthUser, body: ProjectCreate): Promise<number> {
  let lead: { id: number; number: string; assignedToId: number | null } | null = null;
  if (body.leadId != null) {
    const visible = await assertLeadVisible(tx, user, body.leadId);
    if (visible.companyId !== body.companyId) {
      throw new ValidationError([{ path: ['leadId'], message: 'Lead must belong to the client' }]);
    }
    lead = visible;
  } else {
    await assertCompanyVisible(tx, user, body.companyId);
  }
  if (!canCreateProject(user, { managerId: body.managerId, lead })) throw new RuleError('forbidden');
  await assertActiveManager(tx, body.managerId);
  await assertStakeholders(tx, body.companyId, body.stakeholderIds);
  const quotation = body.quotationId != null ? await lockLinkableQuotation(tx, user, body.companyId, body.quotationId, null) : null;

  const number = await nextProjectNumber(tx);
  const p = await tx.project.create({
    data: {
      number, companyId: body.companyId, leadId: lead?.id ?? null, quotationId: quotation?.id ?? null, name: body.name, status: body.status,
      startDate: dateOnly(body.startDate), value: body.value ?? null, currency: body.currency, managerId: body.managerId,
      description: body.description ?? null, createdById: user.id, completedAt: body.status === 'Completed' ? new Date() : null,
      stakeholders: { create: body.stakeholderIds.map((contactId) => ({ contactId })) },
    },
  });
  if (quotation) await linkQuotation(tx, user, quotation, p, 'Linked to project');
  await recordCreated(tx, user, p, lead?.number ?? null);
  return p.id;
}

/* ------------------------------------------------------------------ convert */

/**
 * Convert to project (prototype convertQuote) for users who may edit the quotation. Already converted → the existing
 * project (`created: false`). Only Accepted → 409 `not_accepted`. Value = the last sent revision's total less GST
 * (the working copy's net when none was sent), in the quotation's currency; manager = the quotation's owner.
 */
export async function convertQuotation(tx: Tx, user: AuthUser, quotationId: number): Promise<{ id: number; created: boolean }> {
  const q = await lockVisibleQuotation(tx, user, quotationId);
  if (!canEditQuotation(user, q)) throw new RuleError('forbidden');
  if (q.projectId !== null) return { id: q.projectId, created: false };
  if (q.status !== 'Accepted') throw new RuleError('not_accepted');

  const last = q.revisions.at(-1);
  const value = last
    ? round2(Number(last.grandTotal) - Number(last.taxTotal))
    : quoteTotals({ lines: q.lines.map((l) => ({ qty: l.qty, price: l.unitPrice, discount: l.discount })), overallDiscount: q.overallDiscount, taxRate: q.taxRate }).net;
  const contacts = await tx.contact.findMany({
    where: { companyId: q.companyId, isActive: true }, orderBy: { id: 'asc' }, select: { id: true, isPrimary: true, contactType: true },
  });
  const leadRow = q.leadId !== null ? await tx.lead.findUnique({ where: { id: q.leadId }, select: { contactId: true } }) : null;
  const leadContactId = contacts.some((c) => c.id === leadRow?.contactId) ? leadRow!.contactId : null;

  const number = await nextProjectNumber(tx);
  const p = await tx.project.create({
    data: {
      number, companyId: q.companyId, leadId: q.leadId, quotationId: q.id, name: q.subject.slice(0, 200), status: 'Active',
      startDate: dateOnly(todayIn(user.timezone)), value, currency: q.currency, managerId: q.ownerId, createdById: user.id,
      stakeholders: { create: primaryStakeholderIds(contacts, leadContactId).map((contactId) => ({ contactId })) },
    },
  });
  await linkQuotation(tx, user, q, p, 'Converted to project');
  await recordCreated(tx, user, p, q.lead?.number ?? null);
  if (q.leadId !== null) {
    await tx.leadActivity.create({
      data: {
        leadId: q.leadId, activityType: 'status', title: `Converted to project ${p.number}`, body: `From accepted quotation ${q.number}`,
        relatedType: 'project', relatedId: p.id, byUserId: user.id,
      },
    });
  }
  return { id: p.id, created: true };
}

/* ------------------------------------------------------------------ edit */

/**
 * `PATCH /projects/:id` (Edit project dialog): every field but the client, in any status, by those who may edit
 * (403). A new lead must be one of the client's leads the user can see (400); changing it writes no timeline entry.
 * Swapping or clearing the quotation unlinks the old one (history "Unlinked from project PRJ-n"). Completed sets
 * completedAt; any other status clears it. 409 `stale` when `updatedAt` has moved on.
 */
export async function updateProject(tx: Tx, user: AuthUser, id: number, input: ProjectUpdate): Promise<void> {
  const visible = Number.isInteger(id) ? await tx.project.findFirst({ where: { AND: [{ id }, projectWhere(user)] }, select: { id: true } }) : null;
  if (!visible) throw new NotFoundError();
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${id} FOR UPDATE`;
  const p = await tx.project.findUniqueOrThrow({
    where: { id }, include: { lead: { select: { assignedToId: true } }, stakeholders: { select: { contactId: true } } },
  });
  if (!canEditProject(user, p)) throw new RuleError('forbidden');
  if (new Date(input.updatedAt).getTime() !== p.updatedAt.getTime()) throw new StaleError();

  const leadId = input.leadId ?? null;
  if (leadId !== null && leadId !== p.leadId) {
    const ok = await tx.lead.count({ where: { AND: [{ id: leadId, companyId: p.companyId }, leadWhere(user)] } });
    if (!ok) throw new ValidationError([{ path: ['leadId'], message: 'Lead must be a visible lead of the client' }]);
  }
  if (input.managerId !== p.managerId) await assertActiveManager(tx, input.managerId);
  const current = p.stakeholders.map((s) => s.contactId);
  await assertStakeholders(tx, p.companyId, input.stakeholderIds, current);

  const quotationId = input.quotationId ?? null;
  const swapQuotation = quotationId !== p.quotationId;
  const newQuotation = swapQuotation && quotationId !== null ? await lockLinkableQuotation(tx, user, p.companyId, quotationId, p.id) : null;
  if (swapQuotation && p.quotationId !== null) {
    await tx.$queryRaw`SELECT id FROM quotations WHERE id = ${p.quotationId} FOR UPDATE`;
    const old = await tx.quotation.findUniqueOrThrow({ where: { id: p.quotationId }, select: { id: true, history: true, projectId: true } });
    await tx.quotation.update({
      where: { id: old.id },
      data: { projectId: old.projectId === p.id ? null : old.projectId, history: appendHistory(old, `Unlinked from project ${p.number}`) },
    });
    await audit(tx, { entityType: 'quotation', entityId: old.id, action: 'update', userId: user.id, before: { projectId: old.projectId }, after: { projectId: null } });
  }

  const completedAt = input.status === 'Completed' ? (p.status === 'Completed' ? p.completedAt : new Date()) : null;
  const after = await tx.project.update({
    where: { id },
    data: {
      leadId, quotationId, name: input.name, status: input.status, startDate: dateOnly(input.startDate), value: input.value ?? null,
      currency: input.currency, managerId: input.managerId, description: input.description ?? null, completedAt, updatedAt: new Date(),
    },
  });
  const sameStakeholders = current.length === input.stakeholderIds.length && input.stakeholderIds.every((s) => current.includes(s));
  if (!sameStakeholders) {
    await tx.projectStakeholder.deleteMany({ where: { projectId: id } });
    await tx.projectStakeholder.createMany({ data: input.stakeholderIds.map((contactId) => ({ projectId: id, contactId })) });
  }
  if (newQuotation) await linkQuotation(tx, user, newQuotation, after, 'Linked to project');

  const { lead: _l, stakeholders: _s, ...before } = p;
  await audit(tx, {
    entityType: 'project', entityId: id, action: 'update', userId: user.id,
    before: { ...before, stakeholderIds: sameStakeholders ? undefined : current },
    after: { ...after, stakeholderIds: sameStakeholders ? undefined : input.stakeholderIds },
  });
}
