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

export const ACTIVITY_TYPES = [
  'call', 'email', 'meeting', 'note', 'research', 'status', 'assign', 'transfer', 'ai', 'created', 'quote',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export function isClosedStatus(s: string | null | undefined): s is ClosedStatus {
  return (CLOSED_STATUSES as readonly string[]).includes(s ?? '');
}
