import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { CalendarResponse } from '@dait-crm/shared';
import { api } from './client';

/**
 * `GET /api/calendar` for `from`..`to` (inclusive). The key sits under the tasks prefix, so every task and lead write
 * (which invalidates `keys.tasksAll`) refreshes the calendar too.
 */
export function useCalendar(from: string, to: string, who: 'mine' | 'all') {
  return useQuery({
    queryKey: ['tasks', 'calendar', from, to, who] as const,
    queryFn: () => api<CalendarResponse>(`/api/calendar?${new URLSearchParams({ from, to, who }).toString()}`),
    placeholderData: keepPreviousData,
  });
}
