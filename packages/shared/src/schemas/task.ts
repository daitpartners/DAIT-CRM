import { z } from 'zod';
import { isoDate } from './common.js';
import { PagingQuery } from './paging.js';

export const TaskCreate = z.object({
  leadId: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(200),
  dueDate: isoDate,
  assignedToId: z.number().int().positive(),
});
export type TaskCreate = z.infer<typeof TaskCreate>;

export const TaskUpdate = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  dueDate: isoDate.optional(),
  assignedToId: z.number().int().positive().optional(),
  isDone: z.boolean().optional(),
  updatedAt: z.string().datetime(),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;

export const TASK_TABS = ['today', 'overdue', 'upcoming', 'done'] as const;

/** `GET /tasks` query. */
export const TaskListQuery = PagingQuery.extend({
  tab: z.enum(TASK_TABS).default('today'),
  assignedTo: z.union([z.literal('all'), z.coerce.number().int().positive()]).optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;
