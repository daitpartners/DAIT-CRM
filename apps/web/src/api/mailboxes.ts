import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** A personal mailbox (release 2A), as `GET /api/mailboxes` returns it; never the token. */
export type Mailbox = {
  id: number;
  address: string;
  userId: number | null;
  userName: string | null;
  provider: string;
  status: string;
  syncMail: boolean;
  syncCalendar: boolean;
  sharedMailboxes: string[];
  lastSyncAt: string | null;
  messageCount: number;
};
export type MailboxOptions = Partial<Pick<Mailbox, 'syncMail' | 'syncCalendar' | 'sharedMailboxes'>>;

/** Under the `mailboxes` prefix with the 1A system mailbox, so one invalidation refreshes both. */
export const MAILBOXES_KEY = ['mailboxes', 'personal'] as const;
const KEY = MAILBOXES_KEY;

/** Where "Connect Microsoft 365" sends the browser (a full navigation to the API, then Microsoft). */
export const CONNECT_PERSONAL_URL = '/api/auth/microsoft/connect?mode=personal';

export function useMailboxes() {
  return useQuery({ queryKey: KEY, queryFn: () => api<{ mine: Mailbox | null; all?: Mailbox[] }>('/api/mailboxes') });
}

export function useSaveMailboxOptions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; body: MailboxOptions }) => api<Mailbox>(`/api/mailboxes/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDisconnectMailbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/mailboxes/${id}/disconnect`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
