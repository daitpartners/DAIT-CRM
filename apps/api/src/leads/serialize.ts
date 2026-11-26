import type { Prisma } from '@prisma/client';
import { CLOSED_STATUSES, isClosedStatus } from '@dait-crm/shared';
import { ymd } from './dates.js';
import { contactProfile, contactSummaryInclude } from '../companies/serialize.js';

/*
 * Serializers take `today` (YYYY-MM-DD in the viewer's timezone: `todayIn(user.timezone)`) so
 * overdue / today flags match the user's calendar. Compute it once per request.
 */

const person = { select: { id: true, name: true } } as const;

export const leadSummaryInclude = {
  company: { select: { id: true, number: true, name: true } },
  contact: { select: { id: true, firstName: true, lastName: true, businessEmail: true, linkedinUrl: true } },
  assignedTo: person,
} satisfies Prisma.LeadInclude;

export const leadDetailInclude = {
  company: {
    select: {
      id: true, number: true, name: true, industry: true, city: true, country: true, employeeRange: true,
      isClient: true, verificationStatus: true, legalName: true, website: true, domain: true, businessCategory: true, timezone: true,
      aiResearchStatus: true, aiSummary: true, aiConfidence: true,
      _count: {
        select: {
          contacts: true,
          leads: { where: { archivedAt: null, status: { notIn: [...CLOSED_STATUSES] } } },
        },
      },
    },
  },
  contact: { include: contactSummaryInclude },
  assignedTo: person,
  createdBy: person,
} satisfies Prisma.LeadInclude;

export const activityInclude = { byUser: person } satisfies Prisma.LeadActivityInclude;
export const assignmentInclude = {
  fromUser: person, toUser: person, byUser: person, rule: { select: { id: true, name: true } },
} satisfies Prisma.LeadAssignmentInclude;
export const taskInclude = {
  lead: { select: { id: true, number: true, companyName: true } },
  assignedTo: person,
} satisfies Prisma.TaskInclude;

type LeadSummaryRow = Prisma.LeadGetPayload<{ include: typeof leadSummaryInclude }>;
type LeadDetailRow = Prisma.LeadGetPayload<{ include: typeof leadDetailInclude }>;
type ActivityRow = Prisma.LeadActivityGetPayload<{ include: typeof activityInclude }>;
type AssignmentRow = Prisma.LeadAssignmentGetPayload<{ include: typeof assignmentInclude }>;
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();
const ref = (u: { id: number; name: string } | null) => (u ? { id: u.id, name: u.name } : null);

/** Follow-up date before today on a lead that is still open. */
function leadOverdue(l: { nextFollowUp: Date | null; status: string }, today: string): boolean {
  const d = ymd(l.nextFollowUp);
  return d !== null && d < today && !isClosedStatus(l.status);
}

/**
 * A row in the lead list. `batchIds` maps an import batch number to its Data manager batch id (only for viewers who may
 * open the Data manager): the Created cell links the batch number to that batch.
 */
export function leadSummary(l: LeadSummaryRow, today: string, batchIds?: ReadonlyMap<string, number>) {
  return {
    id: l.id,
    number: l.number,
    leadType: l.leadType,
    companyName: l.companyName,
    companyId: l.companyId,
    company: l.company ? { id: l.company.id, number: l.company.number, name: l.company.name } : null,
    contact: l.contact
      ? { id: l.contact.id, name: fullName(l.contact), email: l.contact.businessEmail, linkedinUrl: l.contact.linkedinUrl }
      : null,
    country: l.country,
    outreachLanguage: l.outreachLanguage,
    city: l.city,
    leadSource: l.leadSource,
    status: l.status,
    priority: l.priority,
    assignedTo: ref(l.assignedTo),
    nextFollowUp: ymd(l.nextFollowUp),
    isOverdue: leadOverdue(l, today),
    archivedAt: l.archivedAt,
    createdAt: l.createdAt,
    // The upload it came from (Import leads wizard: IMPORT-…; older CSV import: CSV-…); null for a lead made by hand.
    importBatch: l.importBatch,
    importBatchId: (l.importBatch && batchIds?.get(l.importBatch.toUpperCase())) ?? null,
    updatedAt: l.updatedAt,
  };
}

/** Which of a lead's addresses are on the do-not-email list (`email_suppressions`): its own, its contact's. */
export type ListedAddresses = { lead: boolean; contact: boolean };

/**
 * The full lead: every column, its company summary, contact, assignee and creator. `listed`: the address the Mailer
 * uses, when it is on the do-not-email list, shows Do not email ticked even when the stored flag is not set (an import
 * update row, an old row): the contact's address → `contactUnsubscribed`, else the lead's own → `doNotEmail`.
 */
export function leadDetail(l: LeadDetailRow, today: string, listed: ListedAddresses = { lead: false, contact: false }) {
  const { company, contact, assignedTo, createdBy, nextFollowUp, ...fields } = l;
  return {
    ...fields,
    doNotEmail: fields.doNotEmail || listed.lead,
    nextFollowUp: ymd(nextFollowUp),
    isOverdue: leadOverdue(l, today),
    company: company
      ? {
          id: company.id, number: company.number, name: company.name, industry: company.industry, city: company.city,
          country: company.country, employeeRange: company.employeeRange, isClient: company.isClient,
          verificationStatus: company.verificationStatus, contactCount: company._count.contacts,
          openLeadCount: company._count.leads,
          // The lead page's company card and facts grid (legal name, website, segment, time zone).
          legalName: company.legalName, website: company.website, domain: company.domain,
          businessCategory: company.businessCategory, timezone: company.timezone,
          // The lead page's AI line (release 4).
          aiResearchStatus: company.aiResearchStatus, aiSummary: company.aiSummary, aiConfidence: company.aiConfidence,
        }
      : null,
    // The full contact profile; `name` and `email` kept for the existing lead screens.
    contact: contact ? { ...contactProfile(contact), name: fullName(contact), email: contact.businessEmail } : null,
    // The contact unsubscribed (through this or another lead): Do not email shows as ticked = doNotEmail || this.
    contactUnsubscribed: !!contact?.unsubscribedAt || listed.contact,
    assignedTo: ref(assignedTo),
    createdBy: ref(createdBy),
  };
}

/**
 * A timeline entry. `by: null` = system. Privacy (owner, 22 Nov 2026): an email sent from the CRM shows its subject
 * only to its sender (`viewerId`); everyone else sees "Email sent" / "Email received" with no subject or body.
 */
export function activityRow(a: ActivityRow, viewerId?: number) {
  const hidden = viewerId !== undefined && a.activityType === 'email' && a.relatedType === 'email_message' && a.byUserId !== viewerId;
  return {
    id: a.id,
    leadId: a.leadId,
    activityType: a.activityType,
    title: hidden ? (a.title.startsWith('Email received') ? 'Email received' : 'Email sent') : a.title,
    body: hidden ? null : a.body,
    url: hidden ? null : a.url,
    statusFrom: a.statusFrom,
    statusTo: a.statusTo,
    relatedType: a.relatedType,
    relatedId: a.relatedId,
    by: ref(a.byUser),
    occurredAt: a.occurredAt,
  };
}

/** An assignment history row. `to: null` = unassigned; `by: null` = allocation rule / system. */
export function assignmentRow(r: AssignmentRow) {
  return {
    id: r.id,
    leadId: r.leadId,
    from: ref(r.fromUser),
    to: ref(r.toUser),
    by: ref(r.byUser),
    rule: r.rule ? { id: r.rule.id, name: r.rule.name } : null,
    note: r.note,
    assignedAt: r.assignedAt,
  };
}

/** A task (list row and detail). */
export function taskRow(t: TaskRow, today: string) {
  const due = ymd(t.dueDate)!;
  return {
    id: t.id,
    leadId: t.leadId,
    lead: t.lead ? { id: t.lead.id, number: t.lead.number, companyName: t.lead.companyName } : null,
    title: t.title,
    dueDate: due,
    kind: t.kind,
    dueTime: t.dueTime,
    durationMinutes: t.durationMinutes,
    assignedTo: { id: t.assignedTo.id, name: t.assignedTo.name },
    isDone: t.isDone,
    doneAt: t.doneAt,
    origin: t.origin,
    closedReason: t.closedReason,
    isOverdue: !t.isDone && due < today,
    isToday: due === today,
    updatedAt: t.updatedAt,
  };
}
