import { z } from 'zod';
import { isoDate } from './common.js';

/** The longest range one calendar request may cover (a month view with its leading and trailing weeks fits). */
export const CALENDAR_MAX_DAYS = 62;

const DAY_MS = 86_400_000;

/**
 * `GET /calendar` query: `from`..`to` inclusive (YYYY-MM-DD, at most CALENDAR_MAX_DAYS days). `who=all` (Everyone) is
 * honoured for administrators only; for anyone else it means `mine`.
 */
export const CalendarQuery = z.object({
  from: isoDate,
  to: isoDate,
  who: z.enum(['mine', 'all']).default('mine'),
}).refine((q) => q.from <= q.to, { path: ['to'], message: 'Invalid range' })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / DAY_MS + 1 <= CALENDAR_MAX_DAYS, { path: ['to'], message: 'range_too_long' });
export type CalendarQuery = z.infer<typeof CalendarQuery>;

/** Calendar chip type: a task's kind, or for an Outlook event `meeting` (someone outside) / `internal`. */
export type CalendarItemType = 'followup' | 'call' | 'meeting' | 'internal';

/**
 * One entry on the calendar: a CRM task or one of the viewer's own Outlook events, in one shape (prototype items()).
 * `date`/`time`/`end` are in the viewer's time zone (task times as entered); `time` null = untimed or all day.
 * `organizer` and `attendees` are present on events only.
 */
export interface CalendarItem {
  kind: 'task' | 'event';
  id: number;
  date: string;
  time: string | null;
  end: string | null;
  title: string;
  type: CalendarItemType;
  done: boolean;
  overdue: boolean;
  leadId: number | null;
  leadNumber: string | null;
  company: string | null;
  ownerId: number;
  ownerName: string;
  where: string | null;
  organizer?: string | null;
  attendees?: string[];
}

export interface CalendarResponse {
  items: CalendarItem[];
  /** Open tasks due before today (any date), same Mine / Everyone scope. */
  overdue: CalendarItem[];
  outlook: { syncOn: boolean };
}
