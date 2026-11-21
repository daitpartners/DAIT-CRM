import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TASK_TABS, TaskCreate, TaskOrigin, TaskUpdate } from '@dait-crm/shared';
import { api } from './client';
import { keys } from './queries';

export type TaskTab = (typeof TASK_TABS)[number];

/** A task (`taskRow` in apps/api/src/leads/serialize.ts). */
export type TaskRow = {
  id: number;
  leadId: number | null;
  lead: { id: number; number: string; companyName: string } | null;
  title: string;
  /** YYYY-MM-DD */
  dueDate: string;
  assignedTo: { id: number; name: string };
  isDone: boolean;
  doneAt: string | null;
  origin: TaskOrigin;
  closedReason: string | null;
  isOverdue: boolean;
  isToday: boolean;
  updatedAt: string;
};

/** `GET /api/tasks` parameters. `assignedTo` defaults to the signed-in user; 'all' needs view_all_leads. */
export type TaskListQuery = { tab: TaskTab; page?: number; pageSize?: number; assignedTo?: number | 'all' };

export type TaskPage = { items: TaskRow[]; total: number; page: number; pageSize: number; counts: Record<TaskTab, number> };

export function useTasks(query: TaskListQuery) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  return useQuery({
    queryKey: keys.tasks(query),
    queryFn: () => api<TaskPage>(`/api/tasks?${params.toString()}`),
    placeholderData: keepPreviousData,
  });
}

/** A task write can move a lead's follow-up date, so leads are refreshed too. */
function useRefresh() {
  const qc = useQueryClient();
  return () =>
    Promise.all([qc.invalidateQueries({ queryKey: keys.tasksAll }), qc.invalidateQueries({ queryKey: keys.leadsAll })]);
}

/** Create (no `id`) or update a task. */
export function useSaveTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id?: number; body: TaskCreate | TaskUpdate }) =>
      v.id
        ? api<TaskRow>(`/api/tasks/${v.id}`, { method: 'PATCH', body: v.body })
        : api<TaskRow>('/api/tasks', { method: 'POST', body: v.body }),
    onSuccess: refresh,
  });
}

/** Moves an open task to tomorrow. */
export function useSnoozeTask() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (task: Pick<TaskRow, 'id' | 'updatedAt'>) =>
      api<TaskRow>(`/api/tasks/${task.id}/snooze`, { method: 'POST', body: { updatedAt: task.updatedAt } }),
    onSuccess: refresh,
  });
}
