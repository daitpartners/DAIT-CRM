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
