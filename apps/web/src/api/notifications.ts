import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { keys } from './queries';

export type NotificationRow = {
  id: number;
  text: string;
  detail: string | null;
  /** An in-app path such as `/leads/12`, or null. */
  link: string | null;
  isRead: boolean;
  createdAt: string;
};

export type NotificationPage = { items: NotificationRow[]; total: number; unread: number };

export const NOTIFICATION_PAGE_SIZE = 25;

/** One page of notifications, newest first; `unreadOnly` lists only unread ones (the Unread tab). */
export function useNotifications(page: number, unreadOnly = false) {
  return useQuery({
    queryKey: [...keys.notifications(page), unreadOnly ? 'unread' : 'all'] as const,
    queryFn: () =>
      api<NotificationPage>(`/api/notifications?page=${page}&pageSize=${NOTIFICATION_PAGE_SIZE}${unreadOnly ? '&unread=1' : ''}`),
    placeholderData: keepPreviousData,
  });
}

/** Sidebar badges (visible leads, my overdue tasks, unread notifications), polled every 60 seconds. */
export function useNavCounts() {
  return useQuery({
    queryKey: keys.navCounts,
    queryFn: () => api<{ leads: number; overdueTasks: number; unread: number }>('/api/nav-counts'),
    refetchInterval: 60_000,
  });
}

/** Read state shows in the notification lists, the sidebar badge and the Dashboard's bell and recent notifications. */
function invalidateAfterRead(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.notificationsAll }),
    qc.invalidateQueries({ queryKey: keys.dashboard }),
    qc.invalidateQueries({ queryKey: keys.navCounts }),
  ]);
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<{ unread: number }>(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => invalidateAfterRead(qc),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ unread: number }>('/api/notifications/read-all', { method: 'POST' }),
    onSuccess: () => invalidateAfterRead(qc),
  });
}
