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

export function useNotifications(page: number) {
  return useQuery({
    queryKey: keys.notifications(page),
    queryFn: () => api<NotificationPage>(`/api/notifications?page=${page}&pageSize=${NOTIFICATION_PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });
}

/** Unread count for the sidebar badge, polled every 60 seconds. */
export function useNotificationCount() {
  return useQuery({
    queryKey: keys.notificationCount,
    queryFn: () => api<{ unread: number }>('/api/notifications/count'),
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<{ unread: number }>(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notificationsAll }),
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ unread: number }>('/api/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notificationsAll }),
  });
}
