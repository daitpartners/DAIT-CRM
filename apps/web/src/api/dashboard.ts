import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { NotificationRow } from './notifications';
import { keys } from './queries';
import type { TaskRow } from './tasks';

/** `GET /api/dashboard`: the signed-in user's own numbers (apps/api/src/routes/dashboard.ts). */
export type Dashboard = {
  /** Full name and today's date (YYYY-MM-DD) in the user's time zone; the greeting word is chosen here. */
  greeting: { name: string; date: string };
  tiles: {
    myOpenLeads: number;
    newSinceYesterday: number;
    tasksDueToday: number;
    overdue: number;
    upcoming: number;
    openTasks: number;
    unreadNotifications: number;
  };
  /** Open tasks assigned to the user, by due date (first six). */
  tasks: TaskRow[];
  /** Today's agenda: the user's own timed tasks for today (calls, meetings, timed follow-ups; done ones too), by time. */
  agenda: TaskRow[];
  /** Latest five notifications. */
  notifications: NotificationRow[];
  /** Open leads assigned to the user per status, first seven open statuses in lookup order. */
  pipeline: { status: string; count: number }[];
  closed: { won: number; lost: number };
};

export function useDashboard() {
  return useQuery({ queryKey: keys.dashboard, queryFn: () => api<Dashboard>('/api/dashboard') });
}
