import { z } from 'zod';
import { isoDate } from './common.js';
import { PagingQuery } from './paging.js';
import { TASK_KINDS } from '../leads.js';

/** Wall-clock time of day `HH:MM`, stored as entered (no time-zone shift). */
const dueTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * `timeline: true` (planned from the Calendar) also writes a lead timeline entry; the Add task dialogs
 * leave it off. Calls and meetings need a time.
 */
export const TaskCreate = z.object({
  leadId: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(200),
  dueDate: isoDate,
  assignedToId: z.number().int().positive(),
  kind: z.enum(TASK_KINDS).default('followup'),
  dueTime: dueTime.optional(),
  timeline: z.boolean().optional(),
}).refine((t) => t.kind === 'followup' || t.dueTime !== undefined, { path: ['dueTime'], message: 'time_required' });
export type TaskCreate = z.infer<typeof TaskCreate>;

export const TaskUpdate = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  dueDate: isoDate.optional(),
  assignedToId: z.number().int().positive().optional(),
  isDone: z.boolean().optional(),
  kind: z.enum(TASK_KINDS).optional(),
  dueTime: dueTime.nullable().optional(),
  updatedAt: z.string().datetime(),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;

export const TASK_TABS = ['today', 'overdue', 'upcoming', 'done'] as const;

/**
 * `GET /tasks` query. `tab=open` returns every open task grouped by section (`overdue`, `today`,
 * `upcoming`), each section capped at `pageSize`, instead of one paged tab.
 */
export const TaskListQuery = PagingQuery.extend({
  tab: z.enum([...TASK_TABS, 'open']).default('today'),
  assignedTo: z.union([z.literal('all'), z.coerce.number().int().positive()]).optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

/** `GET /notifications` query: `unread=1` lists only unread rows. */
export const NotificationListQuery = PagingQuery.pick({ page: true, pageSize: true }).extend({
  unread: z.enum(['0', '1']).optional(),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;
