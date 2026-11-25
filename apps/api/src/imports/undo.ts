/**
 * Data manager: Undo an import (Administrators, `undo_imports`). It removes only what the batch created that nobody has
 * worked on since, listing first what goes and what stays (and why):
 *
 * - a lead: untouched since import (`updatedAt` = its stamp), status New, no activity but the import's own (created,
 *   the allocation's assign, the import's research entries), no other assignment, and no emails, tasks, quotations,
 *   projects, calendar events or Mailer recipients;
 * - a contact the batch created (on a new or an existing company): untouched, every lead linked to it removed with it,
 *   no emails, quotations, project stakeholders or Mailer recipients;
 * - a company the batch created: untouched (its stamp is refreshed by every row of the batch on it, so the batch's own
 *   later writes never count as an edit), all its leads and contacts removed with it, no quotations, projects, emails,
 *   locations or suggestions someone decided. A record kept keeps what hangs on it: its company, its contact, the leads
 *   of a company kept.
 *
 * A company that was already in the CRM is never removed; what the import wrote on it (research values accepted, with
 * their verified / AI bookkeeping, and the AI industry) goes back when it is untouched since, and the suggestions the
 * import superseded are pending again.
 */
import type { Company, ImportBatch, Prisma } from '@prisma/client';
import type { UndoPreview, UndoReason } from '@dait-crm/shared';
import { prisma } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { verificationStatus } from '../research/service.js';
import { NotFoundError } from '../validate.js';
import { ImportError } from './batches.js';
import { filledRecordIds, planFilledUndo, revertFilled, updatedRows, type FilledUndo } from './updates.js';

type Db = Prisma.TransactionClient;
type Stamps = { lead?: string; company?: string; contact?: string | null };
type Keep = UndoPreview['keep'][number];

/** The import's own lead entries (commit.ts), written with no user. */
const IMPORT_AI_TITLES = new Set(['Research found (not verified)', 'Accepted from research']);
/** A lead activity someone added, as the reason the lead stays. */
const ACTIVITY_REASON: Record<string, UndoReason> = {
  status: 'status', email: 'activity', quote: 'quotations', assign: 'reassigned', transfer: 'reassigned', created: 'edited',
};

const importTrigger = (number: string) => `Import ${number}`;
const iso = (d: Date) => d.toISOString();
const jsonMap = <T>(v: Prisma.JsonValue): Record<string, T> =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, T>) } : {};

type Plan = {
  preview: UndoPreview;
  leadIds: number[];
  contactIds: number[];
  companyIds: number[];
  /** Companies already in the CRM, untouched since, whose import writes go back. */
  revert: number[];
  /** Blanks the batch's update rows filled that go back to empty (and contacts they created, untouched). */
  filled: FilledUndo;
};

/** The batch's rows that imported something (a stamp is written with the row's links). */
async function importedRows(db: Db, batchId: number) {
  const rows = await db.importRow.findMany({
    // Never an Updated row, explicitly: its lead and company were already in the CRM and are never removed. (A row the
    // job imported but could not mark before it stopped has no outcome yet, so "not Updated" rather than "Imported".)
    where: {
      batchId,
      AND: [
        { OR: [{ outcome: null }, { outcome: { not: 'Updated' } }] },
        { OR: [{ leadId: { not: null } }, { companyId: { not: null } }, { contactId: { not: null } }] },
      ],
    },
    select: {
      id: true, leadId: true, companyId: true, contactId: true, companyCreated: true, contactCreated: true, stamps: true, importedAt: true,
    },
    orderBy: { id: 'asc' },
  });
  return rows.filter((r) => r.stamps !== null).map((r) => ({ ...r, stamps: r.stamps as Stamps }));
}

/** What Undo would do now (read inside the undo transaction, under its locks, for the real thing). */
async function planUndo(db: Db, batch: Pick<ImportBatch, 'id' | 'number'>): Promise<Plan> {
  const rows = await importedRows(db, batch.id);
  const trigger = importTrigger(batch.number);
  const leadStamp = new Map<number, string | undefined>();
  const contactStamp = new Map<number, string | null | undefined>();
  const companyStamp = new Map<number, string>();
  const createdCompanies = new Set<number>();
  const createdContacts = new Set<number>();
  /** When the batch last wrote on each company (a suggestion decided later was decided by a person). */
  const companyImportedAt = new Map<number, Date>();
  for (const r of rows) {
    if (r.companyId !== null && r.importedAt && (companyImportedAt.get(r.companyId)?.getTime() ?? 0) < r.importedAt.getTime()) {
      companyImportedAt.set(r.companyId, r.importedAt);
    }
    if (r.leadId !== null) leadStamp.set(r.leadId, r.stamps.lead);
    if (r.contactCreated && r.contactId !== null && !contactStamp.has(r.contactId)) {
      contactStamp.set(r.contactId, r.stamps.contact);
      createdContacts.add(r.contactId);
    }
    if (r.companyId !== null) {
      if (r.companyCreated) createdCompanies.add(r.companyId);
      const s = r.stamps.company;
      // Every row on a company carries its latest stamp (refreshed per row); the latest wins regardless.
      if (s && (companyStamp.get(r.companyId) ?? '') < s) companyStamp.set(r.companyId, s);
    }
  }

  const leads = await db.lead.findMany({
    where: { id: { in: [...leadStamp.keys()] } },
    orderBy: { id: 'asc' },
    select: {
      id: true, number: true, companyName: true, status: true, updatedAt: true, companyId: true, contactId: true,
      activities: { select: { activityType: true, title: true, byUserId: true }, orderBy: { id: 'asc' } },
      _count: {
        select: { emailMessages: true, tasks: true, quotations: true, projects: true, calendarEvents: true, campaignRecipients: true, assignments: true },
      },
    },
  });
  const contacts = await db.contact.findMany({
    where: { id: { in: [...createdContacts] } },
    orderBy: { id: 'asc' },
    select: {
      id: true, firstName: true, lastName: true, updatedAt: true, companyId: true, leads: { select: { id: true } },
      _count: { select: { emailMessages: true, quotations: true, projectStakeholders: true, campaignRecipients: true } },
    },
  });
  const companies = await db.company.findMany({
    where: { id: { in: [...createdCompanies] } },
    orderBy: { id: 'asc' },
    select: {
      id: true, number: true, name: true, updatedAt: true, leads: { select: { id: true } }, contacts: { select: { id: true } },
      enrichmentSuggestions: {
        where: { decision: { in: ['accepted', 'rejected'] }, run: { trigger: { not: trigger } } }, select: { id: true }, take: 1,
      },
      _count: { select: { quotations: true, projects: true, emailMessages: true, locations: true, calendarEvents: true } },
    },
  });

  // Two batched reads for every company the batch touched: research someone started (any run but this batch's own), and
  // the latest decision on a suggestion (a decision after the batch last wrote on the company was a person's).
  const touched = [...companyStamp.keys()];
  const [runs, decisions] = touched.length === 0 ? [[], []] : await Promise.all([
    db.enrichmentRun.groupBy({ by: ['companyId'], where: { companyId: { in: touched }, trigger: { not: trigger } } }),
    db.enrichmentSuggestion.groupBy({
      by: ['companyId'], where: { companyId: { in: touched }, decision: { in: ['accepted', 'rejected'] } }, _max: { decidedAt: true },
    }),
  ]);
  const researched = new Set(runs.map((r) => r.companyId));
  const lastDecision = new Map(decisions.map((d) => [d.companyId, d._max.decidedAt]));
  const decidedAfter = (companyId: number): boolean => {
    const at = lastDecision.get(companyId);
    const importedAt = companyImportedAt.get(companyId);
    return !!at && !!importedAt && at.getTime() > importedAt.getTime();
  };

  const keptLead = new Map<number, UndoReason>();
  const keptContact = new Map<number, UndoReason>();
  const keptCompany = new Map<number, UndoReason>();

  for (const l of leads) {
    const reason = leadReason(l, leadStamp.get(l.id));
    if (reason) keptLead.set(l.id, reason);
  }
  const batchLeads = new Set(leads.map((l) => l.id));
  for (const c of contacts) {
    const n = c._count;
    // Mail is checked after the visible reasons and shown only as the neutral `activity` (mail is private to its owner).
    const reason: UndoReason | null = n.quotations ? 'quotations' : n.projectStakeholders ? 'projects'
      : n.campaignRecipients ? 'mailer' : n.emailMessages ? 'activity' : iso(c.updatedAt) !== contactStamp.get(c.id) ? 'edited'
        : c.leads.some((l) => !batchLeads.has(l.id)) ? 'other_leads' : null;
    if (reason) keptContact.set(c.id, reason);
  }
  for (const co of companies) {
    const n = co._count;
    // Research someone started on the company (any run but this batch's own) is work on it.
    const research = researched.has(co.id);
    const decided = decidedAfter(co.id);
    const reason: UndoReason | null = n.quotations ? 'quotations' : n.projects ? 'projects'
      : n.emailMessages || n.calendarEvents || research ? 'activity'
        : n.locations || decided || co.enrichmentSuggestions.length > 0 || iso(co.updatedAt) !== companyStamp.get(co.id) ? 'edited'
        : co.leads.some((l) => !batchLeads.has(l.id)) ? 'other_leads'
          : co.contacts.some((c) => !createdContacts.has(c.id)) ? 'other_contacts' : null;
    if (reason) keptCompany.set(co.id, reason);
  }

  // What hangs on a record kept stays too, until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    const keep = (map: Map<number, UndoReason>, id: number, reason: UndoReason) => {
      if (map.has(id)) return;
      map.set(id, reason);
      changed = true;
    };
    for (const c of contacts) {
      if (c.leads.some((l) => keptLead.has(l.id))) keep(keptContact, c.id, 'other_leads');
      if (createdCompanies.has(c.companyId) && keptCompany.has(c.companyId)) keep(keptContact, c.id, 'other_leads');
    }
    for (const co of companies) {
      if (co.leads.some((l) => keptLead.has(l.id))) keep(keptCompany, co.id, 'other_leads');
      if (co.contacts.some((c) => keptContact.has(c.id))) keep(keptCompany, co.id, 'other_contacts');
    }
    for (const l of leads) {
      if (l.companyId !== null && createdCompanies.has(l.companyId) && keptCompany.has(l.companyId)) keep(keptLead, l.id, 'other_leads');
    }
  }

  // Companies that were already in the CRM: what the import wrote on them goes back when untouched since.
  const existingIds = [...companyStamp.keys()].filter((id) => !createdCompanies.has(id));
  const existing = existingIds.length === 0 ? [] : await db.company.findMany({
    where: { id: { in: existingIds } }, orderBy: { id: 'asc' }, select: { id: true, number: true, name: true, updatedAt: true },
  });
  const revert: number[] = [];
  const reverted: { id: number; label: string }[] = [];
  const keepExisting: Keep[] = [];
  for (const co of existing) {
    const wrote = await db.enrichmentRun.count({ where: { companyId: co.id, trigger } }) > 0
      || await importAuditCount(db, co.id, batch.number) > 0;
    if (!wrote) continue;
    const label = `${co.number} · ${co.name}`;
    const decided = decidedAfter(co.id);
    if (!decided && iso(co.updatedAt) === companyStamp.get(co.id)) {
      revert.push(co.id);
      reverted.push({ id: co.id, label });
    } else {
      keepExisting.push({ kind: 'company', id: co.id, label, reason: 'edited' });
    }
  }

  const keep: Keep[] = [
    ...leads.filter((l) => keptLead.has(l.id)).map((l): Keep => ({ kind: 'lead', id: l.id, label: `${l.number} · ${l.companyName}`, reason: keptLead.get(l.id)! })),
    ...contacts.filter((c) => keptContact.has(c.id))
      .map((c): Keep => ({ kind: 'contact', id: c.id, label: `${c.firstName} ${c.lastName}`.trim(), reason: keptContact.get(c.id)! })),
    ...companies.filter((co) => keptCompany.has(co.id))
      .map((co): Keep => ({ kind: 'company', id: co.id, label: `${co.number} · ${co.name}`, reason: keptCompany.get(co.id)! })),
    ...keepExisting,
  ];
  const filled = await planFilledUndo(db, batch.id);
  const removeLeads = leads.filter((l) => !keptLead.has(l.id));
  const contactIds = contacts.filter((c) => !keptContact.has(c.id)).map((c) => c.id);
  const companyIds = companies.filter((co) => !keptCompany.has(co.id)).map((co) => co.id);
  return {
    preview: {
      remove: { leads: removeLeads.map((l) => ({ id: l.id, number: l.number })), contacts: contactIds.length, companies: companyIds.length },
      keep,
      reverted,
      ...(filled.preview.revert + filled.preview.keep > 0 ? { filled: filled.preview } : {}),
    },
    leadIds: removeLeads.map((l) => l.id), contactIds, companyIds, revert, filled,
  };
}

type LeadForUndo = {
  status: string; updatedAt: Date;
  activities: { activityType: string; title: string; byUserId: number | null }[];
  _count: { emailMessages: number; tasks: number; quotations: number; projects: number; calendarEvents: number; campaignRecipients: number; assignments: number };
};

/** Why a lead the batch created stays (null: it can go). */
function leadReason(l: LeadForUndo, stamp: string | undefined): UndoReason | null {
  const n = l._count;
  if (n.quotations) return 'quotations';
  if (n.projects) return 'projects';
  if (n.campaignRecipients) return 'mailer';
  // Emails, tasks and calendar events: one neutral reason, so mail is never singled out.
  if (n.emailMessages || n.tasks || n.calendarEvents) return 'activity';
  if (l.status !== 'New') return 'status';
  let created = 0;
  let assigned = 0;
  for (const a of l.activities) {
    if (a.activityType === 'created' && created++ === 0) continue;
    if (a.activityType === 'assign' && assigned++ === 0) continue;
    if (a.activityType === 'ai' && a.byUserId === null && IMPORT_AI_TITLES.has(a.title)) continue;
    return ACTIVITY_REASON[a.activityType] ?? 'activity';
  }
  if (n.assignments > 1) return 'reassigned';
  if (!stamp || iso(l.updatedAt) !== stamp) return 'edited';
  return null;
}

/** The `aiIndustry` audit entries the import wrote on a company (commit.ts: after.importBatch = the batch number). */
function importAudits(db: Db, companyId: number, number: string) {
  return db.auditLog.findMany({
    where: { entityType: 'company', entityId: String(companyId), action: 'update', after: { path: ['importBatch'], equals: number } },
    orderBy: { id: 'asc' },
  });
}
const importAuditCount = (db: Db, companyId: number, number: string) =>
  db.auditLog.count({ where: { entityType: 'company', entityId: String(companyId), action: 'update', after: { path: ['importBatch'], equals: number } } });

/**
 * Puts back what the import wrote on a company that was already in the CRM: the research values it accepted (only
 * where the field still carries this run's acceptance), the AI industry (only while it still holds the import's
 * value), the suggestions it superseded (pending again while the field is open), and removes its research run.
 */
async function revertCompany(tx: Db, user: AuthUser, companyId: number, number: string): Promise<void> {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
  const run = await tx.enrichmentRun.findFirst({ where: { companyId, trigger: importTrigger(number) }, include: { suggestions: true } });
  const verified = jsonMap<boolean>(company.verifiedFields);
  const aiFields = jsonMap<{ runId?: number } | null>(company.aiFields);
  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const record = company as unknown as Record<string, unknown>;
  for (const s of run?.suggestions ?? []) {
    if (s.decision !== 'accepted' || aiFields[s.field]?.runId !== run!.id) continue;
    before[s.field] = record[s.field] ?? null;
    data[s.field] = null;
    delete verified[s.field];
    delete aiFields[s.field];
  }
  for (const a of await importAudits(tx, companyId, number)) {
    const after = jsonMap<unknown>(a.after);
    const was = jsonMap<unknown>(a.before);
    if (company.aiIndustry !== null && company.aiIndustry === after.aiIndustry) {
      before.aiIndustry = company.aiIndustry;
      data.aiIndustry = (was.aiIndustry as string | null | undefined) ?? null;
    }
  }
  if (run) {
    // Suggestions the import superseded: the previous run's for each field it suggested, when nothing came after it.
    const fields = new Map<string, number>();
    for (const s of run.suggestions) fields.set(s.field, Math.min(fields.get(s.field) ?? s.id, s.id));
    const written = { ...company, ...data } as Company;
    for (const [field, firstId] of fields) {
      const value = (written as unknown as Record<string, unknown>)[field];
      if (verified[field] === true || (value !== null && value !== undefined && value !== '')) continue;
      const later = await tx.enrichmentSuggestion.count({ where: { companyId, field, id: { gt: firstId }, runId: { not: run.id } } });
      if (later > 0) continue;
      const prior = await tx.enrichmentSuggestion.findFirst({
        where: { companyId, field, id: { lt: firstId }, runId: { not: run.id } }, orderBy: { id: 'desc' }, select: { runId: true, decision: true },
      });
      if (prior?.decision !== 'superseded') continue;
      await tx.enrichmentSuggestion.updateMany({
        where: { companyId, field, runId: prior.runId, decision: 'superseded' }, data: { decision: 'pending', decidedById: null, decidedAt: null },
      });
    }
    await tx.enrichmentRun.delete({ where: { id: run.id } });
  }
  if (Object.keys(data).length === 0) return;
  const written = { ...company, ...data } as Company;
  await tx.company.update({
    where: { id: companyId },
    data: {
      ...data,
      verifiedFields: verified, aiFields: aiFields as Prisma.InputJsonValue, verificationStatus: verificationStatus(written, verified),
    },
  });
  await tx.auditLog.create({
    data: {
      entityType: 'company', entityId: String(companyId), action: 'update', userId: user.id,
      before: before as Prisma.InputJsonValue, after: { ...data, undoneImport: number } as Prisma.InputJsonValue,
    },
  });
}

/** Undo applies to an Imported batch, or a Failed one that imported some rows and has no import job left. */
async function canUndoNow(db: Db, batch: Pick<ImportBatch, 'id' | 'status'>): Promise<boolean> {
  if (batch.status === 'Imported') return true;
  if (batch.status !== 'Failed') return false;
  const alive = await db.job.count({
    where: { type: 'import_commit', status: { in: ['queued', 'running'] }, payload: { path: ['batchId'], equals: batch.id } },
  });
  return alive === 0 && ((await importedRows(db, batch.id)).length > 0 || (await updatedRows(db, batch.id)).length > 0);
}

/** Whether the Data manager offers Undo for this batch (the right is checked by the route). */
export async function canUndo(batch: Pick<ImportBatch, 'id' | 'status'>): Promise<boolean> {
  return canUndoNow(prisma, batch);
}

/** What Undo would remove and keep now; 409 `batch_locked` for a batch that cannot be undone (an Undone one included). */
export async function undoPreview(batchId: number): Promise<UndoPreview> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { id: true, number: true, status: true } });
  if (!batch) throw new NotFoundError();
  if (!await canUndoNow(prisma, batch)) throw new ImportError('batch_locked', 409);
  return (await planUndo(prisma, batch)).preview;
}

/** A deadlock or serialization failure (Postgres 40P01 / 40001, Prisma P2034): nothing was changed, try again. */
export function isRetryable(e: unknown): boolean {
  const err = e as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'P2034') return true;
  const pg = err.meta?.code ?? err.code;
  if (pg === '40P01' || pg === '40001') return true;
  return typeof err.message === 'string' && /\b(40P01|40001)\b|deadlock detected|could not serialize/.test(err.message);
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

/**
 * Undoes the batch in one transaction: 409 `batch_locked` unless it can be undone; the batch's records are locked and
 * the rules checked again; then activities → assignments → leads → contacts → companies are deleted (research rows go
 * with their company), each removal audited, the existing companies' import writes put back, and the batch is Undone
 * with what was removed and kept. A deadlock with a concurrent edit (nothing changed) answers 409 `try_again`.
 */
export async function undoBatch(user: AuthUser, batchId: number): Promise<UndoPreview> {
  try {
    return await undoInTransaction(user, batchId);
  } catch (e) {
    if (isRetryable(e)) throw new ImportError('try_again', 409);
    throw e;
  }
}

async function undoInTransaction(user: AuthUser, batchId: number): Promise<UndoPreview> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM import_batches WHERE id = ${batchId} FOR UPDATE`;
    if (!locked) throw new NotFoundError();
    const batch = await tx.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (!await canUndoNow(tx, batch)) throw new ImportError('batch_locked', 409);

    // Lock what the batch touched, so nobody's edit lands between the check and the delete.
    const rows = await importedRows(tx, batchId);
    const ids = (pick: (r: (typeof rows)[number]) => number | null) =>
      [...new Set(rows.map(pick).filter((id): id is number => id !== null))].sort((a, b) => a - b);
    // With the records the batch's update rows filled.
    const touched = await filledRecordIds(tx, batchId);
    const merge = (a: number[], b: number[]) => [...new Set([...a, ...b])].sort((x, y) => x - y);
    const companyIds = merge(ids((r) => r.companyId), touched.companies);
    const contactIds = merge(ids((r) => (r.contactCreated ? r.contactId : null)), touched.contacts);
    const leadIds = merge(ids((r) => r.leadId), touched.leads);
    if (companyIds.length > 0) await tx.$queryRaw`SELECT id FROM companies WHERE id = ANY(${companyIds}::int[]) ORDER BY id FOR UPDATE`;
    if (contactIds.length > 0) await tx.$queryRaw`SELECT id FROM contacts WHERE id = ANY(${contactIds}::int[]) ORDER BY id FOR UPDATE`;
    if (leadIds.length > 0) await tx.$queryRaw`SELECT id FROM leads WHERE id = ANY(${leadIds}::int[]) ORDER BY id FOR UPDATE`;

    const plan = await planUndo(tx, batch);
    const [leads, contacts, companies] = await Promise.all([
      tx.lead.findMany({ where: { id: { in: plan.leadIds } } }),
      tx.contact.findMany({ where: { id: { in: plan.contactIds } } }),
      tx.company.findMany({ where: { id: { in: plan.companyIds } } }),
    ]);
    await tx.leadActivity.deleteMany({ where: { leadId: { in: plan.leadIds } } });
    await tx.leadAssignment.deleteMany({ where: { leadId: { in: plan.leadIds } } });
    await tx.lead.deleteMany({ where: { id: { in: plan.leadIds } } });
    await tx.contact.deleteMany({ where: { id: { in: plan.contactIds } } });
    await tx.company.deleteMany({ where: { id: { in: plan.companyIds } } });
    const audit = (entityType: string, list: { id: number }[]) => list.map((r) => ({
      entityType, entityId: String(r.id), action: 'delete', userId: user.id, before: plain(r), after: { undoneImport: batch.number },
    }));
    await tx.auditLog.createMany({ data: [...audit('lead', leads), ...audit('contact', contacts), ...audit('company', companies)] });
    for (const id of plan.revert) await revertCompany(tx, user, id, batch.number);
    await revertFilled(tx, user, batch.number, plan.filled);

    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: 'Undone', undoneAt: new Date(), undoneById: user.id, undo: plain(plan.preview) },
    });
    return plan.preview;
  }, { timeout: 120_000, maxWait: 30_000 });
}
