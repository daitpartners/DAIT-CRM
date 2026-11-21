import type { Lead, Prisma } from '@prisma/client';
import { checkDomain, isClosedStatus, normaliseCompanyName, normalisePhone, type LeadCreate } from '@dait-crm/shared';
import { pickAllocation } from '../allocation/pick.js';
import { findCompanyMatches } from '../companies/match.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import type { AuthUser } from '../plugins/auth.js';
import { ValidationError } from '../validate.js';
import { dateOnly, todayIn } from './dates.js';
import { notifyUser } from './notify.js';

type Tx = Prisma.TransactionClient;

/**
 * A business rule refused the change. `code` is the API error code (`invalid_status`,
 * `reason_required`, `unknown_user`); routes map it to 400/409.
 */
export class RuleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const REASON_REQUIRED = new Set(['Lost', 'Not Relevant']);

async function assertStatus(tx: Tx, value: string): Promise<void> {
  const row = await tx.lookupValue.findFirst({ where: { group: 'lead_status', value, isActive: true }, select: { id: true } });
  if (!row) throw new RuleError('invalid_status');
}

/** Marks the lead's open tasks done with `closedReason`; returns how many were closed. */
export async function closeOpenTasks(tx: Tx, leadId: number, closedReason: string): Promise<number> {
  const { count } = await tx.task.updateMany({
    where: { leadId, isDone: false },
    data: { isDone: true, doneAt: new Date(), closedReason },
  });
  return count;
}

/**
 * Keeps the lead's single open follow-up task in step with `nextFollowUp` and the assignee:
 * re-dated / re-assigned when both are set, deleted otherwise.
 */
export async function syncFollowUpTask(tx: Tx, lead: Lead): Promise<void> {
  const where = { leadId: lead.id, origin: 'follow_up', isDone: false };
  if (!lead.nextFollowUp || lead.assignedToId === null) {
    await tx.task.deleteMany({ where });
    return;
  }
  const data = { title: `Follow up · ${lead.companyName}`, dueDate: lead.nextFollowUp, assignedToId: lead.assignedToId };
  const open = await tx.task.findMany({ where, orderBy: { id: 'asc' }, select: { id: true } });
  if (open.length === 0) {
    await tx.task.create({ data: { ...data, leadId: lead.id, origin: 'follow_up' } });
    return;
  }
  await tx.task.update({ where: { id: open[0].id }, data });
  // Heal any duplicates left by an earlier race: one open follow-up task per lead.
  if (open.length > 1) await tx.task.deleteMany({ where: { id: { in: open.slice(1).map((t) => t.id) } } });
}

/**
 * Moves the lead to status `to`. No-op when unchanged. Lost / Not Relevant need a reason. Won
 * converts the lead and flags its company as a client. Any closed status clears the follow-up
 * and closes the open tasks. Used by every path that changes status (stepper, Log call, close).
 */
export async function applyStatusChange(
  tx: Tx, lead: Lead, to: string, by: { userId: number | null }, opts: { reason?: string; sourceTitle?: string } = {},
): Promise<Lead> {
  await assertStatus(tx, to);
  if (to === lead.status) return lead;
  const reason = opts.reason?.trim() || undefined;
  if (REASON_REQUIRED.has(to) && !reason) throw new RuleError('reason_required');
  const from = lead.status;
  const closed = isClosedStatus(to);

  const data: Prisma.LeadUncheckedUpdateInput = { status: to };
  if (to === 'Won') data.convertedTo = 'client';
  if (closed) data.nextFollowUp = null;
  const updated = await tx.lead.update({ where: { id: lead.id }, data });

  await tx.leadActivity.create({
    data: {
      leadId: lead.id, activityType: 'status', title: `Status changed to ${to}`, statusFrom: from, statusTo: to,
      body: reason ?? opts.sourceTitle ?? null, byUserId: by.userId,
    },
  });

  if (to === 'Won') {
    let body = `Previous status ${from}.`;
    if (lead.companyId !== null) {
      const company = await tx.company.update({ where: { id: lead.companyId }, data: { isClient: true }, select: { number: true } });
      body += ` Company ${company.number} flagged as Client.`;
    }
    await tx.leadActivity.create({
      data: { leadId: lead.id, activityType: 'status', title: 'Converted to client', body, byUserId: by.userId },
    });
  }

  if (closed) {
    const n = await closeOpenTasks(tx, lead.id, `Lead closed as ${to}`);
    if (n > 0) {
      await tx.leadActivity.create({
        data: { leadId: lead.id, activityType: 'note', title: `${n} open task(s) closed`, byUserId: null },
      });
    }
  }
  return updated;
}

/**
 * Assigns the lead to `toUserId` (null = unassign) and records it: a `lead_assignments` row, an
 * `assign` / `transfer` activity, open tasks moved to the receiver (left alone on unassign), and
 * a notification to the receiver unless they assigned it to themselves. `by.isNew` marks the
 * assignment made while creating the lead: the receiver also gets a "Review new lead" task due
 * today in their timezone. `by.userId: null` = system (allocation rule `by.ruleId`).
 * No-op when the assignee is unchanged. Refuses an unknown or inactive receiver (`unknown_user`).
 */
export async function recordAssignment(
  tx: Tx, lead: Lead, toUserId: number | null,
  by: { userId: number | null; ruleId?: number | null; note?: string; isNew?: boolean },
): Promise<Lead> {
  const receiver = toUserId === null
    ? null
    : await tx.user.findFirst({ where: { id: toUserId, isActive: true }, select: { id: true, name: true, timezone: true } });
  if (toUserId !== null && !receiver) throw new RuleError('unknown_user');
  const fromUserId = lead.assignedToId;
  if (fromUserId === toUserId) return lead;
  const note = by.note?.trim() || null;

  await tx.leadAssignment.create({
    data: { leadId: lead.id, fromUserId, toUserId, byUserId: by.userId, ruleId: by.ruleId ?? null, note },
  });
  const updated = await tx.lead.update({ where: { id: lead.id }, data: { assignedToId: toUserId } });

  const isTransfer = fromUserId !== null && receiver !== null;
  const title = receiver === null ? 'Unassigned' : isTransfer ? `Transferred to ${receiver.name}` : `Assigned to ${receiver.name}`;
  await tx.leadActivity.create({
    data: { leadId: lead.id, activityType: isTransfer ? 'transfer' : 'assign', title, body: note, byUserId: by.userId },
  });

  if (receiver) {
    await tx.task.updateMany({ where: { leadId: lead.id, isDone: false }, data: { assignedToId: receiver.id } });
    await syncFollowUpTask(tx, updated);
    if (by.isNew) {
      await tx.task.create({
        data: {
          leadId: lead.id, title: `Review new lead · ${lead.companyName}`, dueDate: dateOnly(todayIn(receiver.timezone)),
          assignedToId: receiver.id, origin: 'new_assignment',
        },
      });
    }
    if (receiver.id !== by.userId) {
      const text = isTransfer ? `Lead ${lead.number} transferred to you` : `Lead ${lead.number} assigned to you`;
      const detail = note ? `${lead.companyName} · ${note}` : lead.companyName;
      await notifyUser(tx, receiver.id, text, detail, `/leads/${lead.id}`);
    }
  }
  return updated;
}

/**
 * Extra fields a caller may pass when creating a lead: the contact person's name, used for the
 * primary contact of a newly created company (the lead form has none; the CSV import does).
 */
export type LeadCreateExtras = { contactFirstName?: string | null; contactLastName?: string | null };

/** Resolves the company for a new lead: explicit link, else an automatic duplicate hit, else a new one. */
async function resolveCompany(
  tx: Tx, input: LeadCreate & LeadCreateExtras, user: AuthUser,
): Promise<{ companyId: number | null; createdCompanyId: number | null; createdContactId: number | null }> {
  const linkId = input.linkCompanyId ?? input.companyId;
  const none = { createdCompanyId: null, createdContactId: null };
  if (linkId !== undefined) return { companyId: (await assertCompanyVisible(tx, user, linkId)).id, ...none };

  const matches = await findCompanyMatches(tx, {
    name: input.companyName, website: input.website ?? undefined, businessEmail: input.businessEmail ?? undefined,
    country: input.country,
  });
  if (matches.auto) return { companyId: matches.auto.id, ...none };
  if (!input.createCompany) return { companyId: null, ...none };

  const company = await tx.company.create({
    data: {
      name: input.companyName,
      nameNormalised: normaliseCompanyName(input.companyName),
      website: input.website ?? null,
      businessEmail: input.businessEmail ?? null,
      domain: checkDomain({ website: input.website ?? undefined, businessEmail: input.businessEmail ?? undefined }),
      country: input.country,
      city: input.city ?? null,
      createdById: user.id,
    },
  });
  const firstName = input.contactFirstName?.trim();
  let createdContactId: number | null = null;
  if (firstName && (input.businessEmail || input.phone)) {
    ({ id: createdContactId } = await tx.contact.create({
      data: {
        companyId: company.id,
        firstName,
        lastName: input.contactLastName?.trim() ?? '',
        businessEmail: input.businessEmail?.toLowerCase() ?? null,
        phone: input.phone ?? null,
        phoneNormalised: normalisePhone(input.phone) || null,
        isPrimary: true,
      },
      select: { id: true },
    }));
  }
  return { companyId: company.id, createdCompanyId: company.id, createdContactId };
}

/** The new lead plus the company / contact rows this call created (null when it linked existing ones). */
export type CreatedLead = { lead: Lead; createdCompanyId: number | null; createdContactId: number | null };

/**
 * Creates a lead: resolves its company (link → automatic match → new company with a primary
 * contact), picks the contact (given, else the company's primary), assigns it (given assignee,
 * else the allocation rule for its country), and writes the "Lead created" activity and the
 * follow-up task. Runs inside the caller's transaction.
 */
export async function createLeadWithCompany(tx: Tx, input: LeadCreate & LeadCreateExtras, user: AuthUser): Promise<CreatedLead> {
  await assertStatus(tx, input.status);
  const { companyId, createdCompanyId, createdContactId } = await resolveCompany(tx, input, user);

  let contactId: number | null = null;
  if (input.contactId !== undefined) {
    const ok = companyId !== null && (await tx.contact.count({ where: { id: input.contactId, companyId } })) > 0;
    if (!ok) throw new ValidationError([{ path: ['contactId'], message: 'Contact does not belong to the company' }]);
    contactId = input.contactId;
  } else if (companyId !== null) {
    contactId = (await tx.contact.findFirst({ where: { companyId, isPrimary: true }, select: { id: true } }))?.id ?? null;
  }

  const lead = await tx.lead.create({
    data: {
      leadType: input.leadType,
      companyName: input.companyName,
      companyId,
      contactId,
      website: input.website ?? null,
      businessEmail: input.businessEmail ?? null,
      phone: input.phone ?? null,
      country: input.country,
      city: input.city ?? null,
      leadSource: input.leadSource,
      sourceUrl: input.sourceUrl ?? null,
      priority: input.priority,
      status: input.status,
      nextFollowUp: input.nextFollowUp ? dateOnly(input.nextFollowUp) : null,
      notes: input.notes ?? null,
      enrichmentStatus: 'Pending',
      createdById: user.id,
    },
  });
  await tx.leadActivity.create({ data: { leadId: lead.id, activityType: 'created', title: 'Lead created', byUserId: user.id } });

  let current = lead;
  if (input.assignedToId != null) {
    current = await recordAssignment(tx, current, input.assignedToId, { userId: user.id, isNew: true });
  } else {
    const pick = await pickAllocation(tx, input.country);
    // A rule naming a deactivated user leaves the lead unassigned rather than failing the create.
    const active = pick && (await tx.user.count({ where: { id: pick.userId, isActive: true } })) > 0;
    if (pick && active) current = await recordAssignment(tx, current, pick.userId, { userId: null, ruleId: pick.ruleId, isNew: true });
  }
  await syncFollowUpTask(tx, current);
  return { lead: current, createdCompanyId, createdContactId };
}
