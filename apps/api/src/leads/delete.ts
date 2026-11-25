/**
 * Delete leads (owner, 25 Nov 2026; docs/superpowers/specs/2026-11-25-lead-delete-design.md). Administrators only
 * (`delete_leads`), at most LEAD_DELETE_MAX at once, archived leads included. A preview lists what goes and what stays
 * (and why); confirm plans again under locks and removes only what is still safe AND was in the preview.
 *
 * Per relation (prisma/schema.prisma; no ON DELETE had to change):
 * - removed with the lead: activities (notes, calls, meetings, timeline) and assignments (FK cascade), tasks (cascade),
 *   its Draft quotations (deleted here, with their lines, revisions and tasks), notifications linking to it;
 * - unlinked, never removed (FK set null): email_messages and calendar_events (they stay with their owner, private),
 *   Mailer recipients (campaign history kept), import rows, research runs and source records of a company kept;
 * - blocks the lead (kept, archive instead): a project, or a quotation that is not a never-sent Draft;
 * - the company goes (with its contacts, locations, research runs, suggestions and sources, notifications linking to it)
 *   only when, after the deletion, it has no other lead (archived included), project or quotation, and none of its
 *   contacts is used by another lead, a quotation or a project; otherwise it stays with all its contacts;
 * - a lead's own contact on a company that stays goes when nothing else uses it (other lead, quotation, project).
 *
 * Locks are taken in the order import Undo and update rows take them (companies → contacts → leads, each by id).
 */
import type { Prisma } from '@prisma/client';
import type { LeadDeletePlan, LeadDeletePreview, LeadDeleteReason } from '@dait-crm/shared';
import { prisma } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { isRetryable } from '../imports/undo.js';

type Db = Prisma.TransactionClient;
type Keep = LeadDeletePreview['keep'][number];

/** A refusal the route answers with `status` and `{ error: code }`. */
export class LeadDeleteError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const contactSelect = {
  id: true, firstName: true, lastName: true,
  leads: { select: { id: true } },
  quotations: { select: { id: true } },
  _count: { select: { projectStakeholders: true } },
} satisfies Prisma.ContactSelect;
type ContactRow = Prisma.ContactGetPayload<{ select: typeof contactSelect }>;

type Planned = {
  preview: LeadDeletePreview;
  draftIds: number[];
  /** Per removed lead: what goes with it (for its audit entry). */
  leadCounts: Map<number, { activities: number; tasks: number; draftQuotations: number; contacts: number }>;
  companyCounts: Map<number, { contacts: number; locations: number; researchRuns: number; sources: number }>;
};

/** A quotation that was never sent (status Draft, no revision frozen, no send queued, no project). */
const neverSent = (q: { status: string; projectId: number | null; sendingMessageId: number | null; _count: { revisions: number } }) =>
  q.status === 'Draft' && q._count.revisions === 0 && q.sendingMessageId === null && q.projectId === null;

const sortedUnique = (ids: (number | null)[]) => [...new Set(ids.filter((id): id is number => id !== null))].sort((a, b) => a - b);

/**
 * What deleting `ids` would do now. With `restrict` (confirm), nothing outside the preview's plan is removed: a record
 * that became removable since stays (`changed`), and a company whose contacts grew since stays too.
 */
async function planDelete(db: Db, ids: number[], restrict: LeadDeletePlan | null): Promise<Planned> {
  const allowed = restrict && {
    leads: new Set(restrict.leads), companies: new Set(restrict.companies), contacts: new Set(restrict.contacts),
  };
  const leads = await db.lead.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
    select: {
      id: true, number: true, companyName: true, companyId: true, contactId: true,
      quotations: { select: { id: true, status: true, projectId: true, sendingMessageId: true, _count: { select: { revisions: true } } } },
      _count: { select: { projects: true, tasks: true, activities: true } },
    },
  });
  const keep: Keep[] = [];
  const removeLeads: typeof leads = [];
  for (const l of leads) {
    const reason: LeadDeleteReason | null = l._count.projects ? 'projects' : l.quotations.some((q) => !neverSent(q)) ? 'quotations'
      : allowed && !allowed.leads.has(l.id) ? 'changed' : null;
    if (reason) keep.push({ kind: 'lead', id: l.id, label: `${l.number} · ${l.companyName}`, reason });
    else removeLeads.push(l);
  }
  const removing = new Set(removeLeads.map((l) => l.id));
  const draftIds = removeLeads.flatMap((l) => l.quotations.map((q) => q.id));
  const drafts = new Set(draftIds);
  /** Why a contact must stay (null: nothing but the leads and drafts removed here uses it). */
  const contactReason = (c: ContactRow): LeadDeleteReason | null =>
    c.leads.some((l) => !removing.has(l.id)) ? 'other_leads'
      : c.quotations.some((q) => !drafts.has(q.id)) ? 'quotations' : c._count.projectStakeholders ? 'projects' : null;

  const companies = await db.company.findMany({
    where: { id: { in: sortedUnique(removeLeads.map((l) => l.companyId)) } },
    orderBy: { id: 'asc' },
    select: {
      id: true, number: true, name: true,
      leads: { select: { id: true } },
      quotations: { select: { id: true } },
      contacts: { select: contactSelect, orderBy: { id: 'asc' } },
      _count: { select: { projects: true, locations: true, enrichmentRuns: true, sourceRecords: true } },
    },
  });
  const removeCompanies: typeof companies = [];
  const removeContacts = new Set<number>();
  const companyCounts: Planned['companyCounts'] = new Map();
  for (const co of companies) {
    let reason: LeadDeleteReason | null = co._count.projects ? 'projects' : co.quotations.some((q) => !drafts.has(q.id)) ? 'quotations'
      : co.leads.some((l) => !removing.has(l.id)) ? 'other_leads' : co.contacts.some((c) => contactReason(c) !== null) ? 'contact_in_use' : null;
    if (!reason && allowed && (!allowed.companies.has(co.id) || co.contacts.some((c) => !allowed.contacts.has(c.id)))) reason = 'changed';
    if (reason) {
      keep.push({ kind: 'company', id: co.id, label: `${co.number} · ${co.name}`, reason });
      continue;
    }
    removeCompanies.push(co);
    for (const c of co.contacts) removeContacts.add(c.id);
    companyCounts.set(co.id, {
      contacts: co.contacts.length, locations: co._count.locations, researchRuns: co._count.enrichmentRuns, sources: co._count.sourceRecords,
    });
  }

  // The leads' own contacts that do not go with their company.
  const own = await db.contact.findMany({
    where: { id: { in: sortedUnique(removeLeads.map((l) => l.contactId)).filter((id) => !removeContacts.has(id)) } },
    orderBy: { id: 'asc' },
    select: contactSelect,
  });
  const ownRemoved = new Set<number>();
  for (const c of own) {
    let reason = contactReason(c);
    if (!reason && allowed && !allowed.contacts.has(c.id)) reason = 'changed';
    if (reason) keep.push({ kind: 'contact', id: c.id, label: `${c.firstName} ${c.lastName}`.trim(), reason });
    else ownRemoved.add(c.id);
  }
  for (const id of ownRemoved) removeContacts.add(id);

  const leadIds = removeLeads.map((l) => l.id);
  const tasks = leadIds.length === 0 ? 0
    : await db.task.count({ where: { OR: [{ leadId: { in: leadIds } }, ...(draftIds.length ? [{ quotationId: { in: draftIds } }] : [])] } });
  const leadCounts: Planned['leadCounts'] = new Map();
  const ownCounted = new Set<number>();
  for (const l of removeLeads) {
    // A contact removed on its own is counted once, on the first lead that had it.
    const contact = l.contactId !== null && ownRemoved.has(l.contactId) && !ownCounted.has(l.contactId);
    if (contact) ownCounted.add(l.contactId!);
    leadCounts.set(l.id, { activities: l._count.activities, tasks: l._count.tasks, draftQuotations: l.quotations.length, contacts: contact ? 1 : 0 });
  }
  const contactIds = [...removeContacts].sort((a, b) => a - b);
  return {
    preview: {
      remove: {
        leads: removeLeads.map((l) => ({ id: l.id, number: l.number, companyName: l.companyName })),
        companies: removeCompanies.map((co) => ({ id: co.id, number: co.number, name: co.name })),
        contacts: contactIds.length,
        draftQuotations: draftIds.length,
        tasks,
      },
      keep,
      plan: { leads: leadIds, companies: removeCompanies.map((co) => co.id), contacts: contactIds },
    },
    draftIds, leadCounts, companyCounts,
  };
}

/** What deleting these leads would remove and keep now (nothing is changed). */
export async function deletePreview(ids: number[]): Promise<LeadDeletePreview> {
  return (await planDelete(prisma, sortedUnique(ids), null)).preview;
}

/** The companies and contacts the leads hang on (their companies' contacts and the leads' own contacts). */
async function recordsOf(tx: Db, ids: number[]) {
  const leads = await tx.lead.findMany({ where: { id: { in: ids } }, select: { companyId: true, contactId: true } });
  const companyIds = sortedUnique(leads.map((l) => l.companyId));
  const contacts = companyIds.length === 0 ? [] : await tx.contact.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  return { companyIds, contactIds: sortedUnique([...contacts.map((c) => c.id), ...leads.map((l) => l.contactId)]) };
}

/**
 * Locks companies → contacts → leads (by id), then reads again under the locks: a lead moved to another company, or a
 * contact added before its company was locked, is locked too, until nothing new turns up.
 */
async function lockAll(tx: Db, ids: number[]): Promise<void> {
  const companies = new Set<number>();
  const contacts = new Set<number>();
  const lock = async (table: 'companies' | 'contacts', all: number[], held: Set<number>) => {
    const fresh = all.filter((id) => !held.has(id));
    if (fresh.length === 0) return false;
    if (table === 'companies') await tx.$queryRaw`SELECT id FROM companies WHERE id = ANY(${fresh}::int[]) ORDER BY id FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM contacts WHERE id = ANY(${fresh}::int[]) ORDER BY id FOR UPDATE`;
    for (const id of fresh) held.add(id);
    return true;
  };
  const first = await recordsOf(tx, ids);
  await lock('companies', first.companyIds, companies);
  await lock('contacts', first.contactIds, contacts);
  await tx.$queryRaw`SELECT id FROM leads WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`;
  for (let round = 0; round < 5; round += 1) {
    const now = await recordsOf(tx, ids);
    const a = await lock('companies', now.companyIds, companies);
    const b = await lock('contacts', now.contactIds, contacts);
    if (!a && !b) return;
  }
  // Still moving after five rounds: give up without changing anything.
  throw new LeadDeleteError('try_again', 409);
}

/**
 * Deletes the leads in one transaction: locks, plans again (removing only what is safe now and was in `plan`), removes
 * Draft quotations → notifications → leads → contacts → companies, and writes one audit entry per lead and company
 * (numbers, names and counts only). Answers with what it did. A deadlock with a concurrent edit (nothing changed): 409
 * `try_again`.
 */
export async function deleteLeads(user: AuthUser, rawIds: number[], plan: LeadDeletePlan): Promise<LeadDeletePreview> {
  const ids = sortedUnique(rawIds);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockAll(tx, ids);
      const planned = await planDelete(tx, ids, plan);
      await apply(tx, user, planned);
      return planned.preview;
    }, { timeout: 120_000, maxWait: 30_000 });
  } catch (e) {
    if (isRetryable(e)) throw new LeadDeleteError('try_again', 409);
    throw e;
  }
}

async function apply(tx: Db, user: AuthUser, planned: Planned): Promise<void> {
  const { leads: leadIds, companies: companyIds, contacts: contactIds } = planned.preview.plan;
  if (planned.draftIds.length > 0) {
    await tx.task.deleteMany({ where: { quotationId: { in: planned.draftIds } } });
    await tx.quotation.deleteMany({ where: { id: { in: planned.draftIds } } });
  }
  // Notifications that open a removed lead or company (`/leads/12`, `/companies/7#ai`).
  if (leadIds.length > 0) {
    await tx.$executeRaw`DELETE FROM notifications
      WHERE substring(link from '^/leads/([0-9]{1,9})(?:[#?].*)?$')::int = ANY(${leadIds}::int[])`;
  }
  if (companyIds.length > 0) {
    await tx.$executeRaw`DELETE FROM notifications
      WHERE substring(link from '^/companies/([0-9]{1,9})(?:[#?].*)?$')::int = ANY(${companyIds}::int[])`;
  }
  await tx.lead.deleteMany({ where: { id: { in: leadIds } } });
  if (contactIds.length > 0) await tx.contact.deleteMany({ where: { id: { in: contactIds } } });
  if (companyIds.length > 0) await tx.company.deleteMany({ where: { id: { in: companyIds } } });

  const leadEntries = planned.preview.remove.leads.map((l) => ({
    entityType: 'lead', entityId: String(l.id), action: 'delete', userId: user.id,
    after: { number: l.number, companyName: l.companyName, removed: planned.leadCounts.get(l.id)! },
  }));
  const companyEntries = planned.preview.remove.companies.map((co) => ({
    entityType: 'company', entityId: String(co.id), action: 'delete', userId: user.id,
    after: { number: co.number, name: co.name, removed: planned.companyCounts.get(co.id)! },
  }));
  if (leadEntries.length + companyEntries.length > 0) await tx.auditLog.createMany({ data: [...leadEntries, ...companyEntries] });
}
