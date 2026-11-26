/** Lead vocabularies shared by the API and the web app (docs/data-model.md Module 1). */

export const LEAD_TYPES = ['Lead', 'Prospect'] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

export const PRIORITIES = ['High', 'Medium', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Statuses that end a lead: follow-up cleared, open tasks closed. */
export const CLOSED_STATUSES = ['Won', 'Lost', 'Not Relevant'] as const;
export type ClosedStatus = (typeof CLOSED_STATUSES)[number];

export const TASK_ORIGINS = ['follow_up', 'new_assignment', 'transfer', 'manual', 'quotation'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/** A task is a follow-up (default), or a call or meeting, which always has a time of day. */
export const TASK_KINDS = ['followup', 'call', 'meeting'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
/** Minutes a call or meeting lasts (set when the type is chosen). */
export const TASK_DURATION: Record<'call' | 'meeting', number> = { call: 30, meeting: 60 };

/** A task's end time: `HH:MM` plus `minutes`, capped at 23:59 (an entry never runs past midnight). */
export function taskEndTime(start: string, minutes: number): string {
  const [h, m] = start.split(':').map(Number) as [number, number];
  const end = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

export const ACTIVITY_TYPES = [
  'call', 'email', 'meeting', 'note', 'research', 'status', 'assign', 'transfer', 'ai', 'created', 'quote',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export function isClosedStatus(s: string | null | undefined): s is ClosedStatus {
  return (CLOSED_STATUSES as readonly string[]).includes(s ?? '');
}

/* ------------------------------------------------------------------ delete leads (Administrators, `delete_leads`) */

/** At most this many leads are deleted at once (Leads list bulk bar). */
export const LEAD_DELETE_MAX = 500;

/**
 * Why Delete keeps a record: a lead with a sent quotation or a project (archive it instead); a company that still has
 * other leads, projects or quotations, or a contact another lead, a quotation or a project still uses; `changed`: it
 * changed after the preview, so it is kept rather than removed unseen.
 */
export const LEAD_DELETE_REASONS = ['quotations', 'projects', 'other_leads', 'contact_in_use', 'changed'] as const;
export type LeadDeleteReason = (typeof LEAD_DELETE_REASONS)[number];

/** The records a preview offers to remove; sent back on confirm, which never removes anything outside it. */
export type LeadDeletePlan = { leads: number[]; companies: number[]; contacts: number[]; quotations: number[] };

/**
 * What Delete removes and keeps (`POST /leads/delete/preview` lists it; `POST /leads/delete` does it and answers with
 * what it actually did). Emails and calendar events are never counted or removed: they are only unlinked. The address of a
 * removed lead marked Do not email, or of a removed contact that unsubscribed, goes on the suppression list.
 */
export type LeadDeletePreview = {
  remove: {
    leads: { id: number; number: string; companyName: string }[];
    companies: { id: number; number: string; name: string }[];
    /** The removed companies' contacts (a company kept keeps all its contacts). */
    contacts: { id: number; name: string }[];
    /** Draft quotations of the leads (never sent), removed with them. */
    draftQuotations: number;
    tasks: number;
  };
  keep: { kind: 'lead' | 'company' | 'contact'; id: number; label: string; reason: LeadDeleteReason }[];
  /** Chosen ids that are not (or no longer) in the CRM. */
  notFound: number;
  plan: LeadDeletePlan;
};
