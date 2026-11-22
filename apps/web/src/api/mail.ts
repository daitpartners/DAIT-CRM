import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';
import { keys } from './queries';

/** Email screen views (prototype folders and smart views). */
export const MAIL_VIEWS = ['inbox', 'sent', 'drafts', 'archive', 'unlinked', 'awaiting', 'mine'] as const;
export type MailView = (typeof MAIL_VIEWS)[number];

export type MailFilter = { view: MailView; company?: number; lead?: number; project?: number; s?: string; page?: number; pageSize?: number };

/** Rows per page offered by the list's pager, as Leads and Companies (owner, 22 Nov 2026: the synced list had grown too long). */
export const MAIL_PAGE_SIZES = [25, 50, 100] as const;
export const MAIL_PAGE_SIZE = 50;

/** One page of the list; `total` counts every message the filters leave. */
export type MailPage = { items: MailItem[]; total: number; page: number; pageSize: number };

/** A message in the list (release 2B-2): only ever the signed-in user's own. */
export type MailItem = {
  id: number;
  folder: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'received' | 'draft';
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string;
  preview: string;
  occurredAt: string;
  isRead: boolean;
  leadId: number | null;
  leadNumber: string | null;
  companyId: number | null;
  hasAttachments: boolean;
  /** Release 3B: the project the message is tagged with (null when none, or one the viewer cannot see). */
  projectId: number | null;
  projectNumber: string | null;
};

export type MailDetail = MailItem & {
  ccAddresses: string[];
  bodyText: string;
  attachmentNames: string[];
  loggedAt: string | null;
  lead: { id: number; number: string; status: string; priority: string; nextFollowUp: string | null; companyId: number | null } | null;
  contact: { id: number; name: string } | null;
  company: { id: number; name: string } | null;
  /** Thread history, newest first, the open message included (see the API's threadHistory). */
  thread: {
    id: number; occurredAt: string; direction: 'in' | 'out'; who: string; subject: string;
    kind: 'sent' | 'reply' | 'received' | 'draft'; by: string | null; unmatched: boolean;
  }[];
};

export type MailMeta = {
  mailbox: { id: number; address: string; status: string; lastSyncAt: string | null } | null;
  unread: number;
  unlinked: number;
  companies: { id: number; name: string }[];
  leads: { id: number; number: string; companyId: number | null; companyName: string; status: string }[];
  /** Release 3B: every project the user can see (the Project filter). */
  projects: { id: number; number: string; name: string; companyId: number }[];
};

export type MailCompose = {
  to: string; cc: string[]; subject: string; body: string; leadId?: number | null; companyId?: number | null; projectId?: number | null;
};

const ROOT = ['mail'] as const;
const listPath = (f: MailFilter) => {
  const q = new URLSearchParams({ view: f.view });
  if (f.company) q.set('company', String(f.company));
  if (f.lead) q.set('lead', String(f.lead));
  if (f.project) q.set('project', String(f.project));
  if (f.s) q.set('s', f.s);
  if (f.page && f.page > 1) q.set('page', String(f.page));
  q.set('pageSize', String(f.pageSize ?? MAIL_PAGE_SIZE));
  return `/api/mail?${q.toString()}`;
};

export function useMailList(f: MailFilter, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, 'list', f],
    queryFn: () => api<MailPage>(listPath(f)),
    placeholderData: keepPreviousData,
    enabled,
    // New mail arrives with each 5-minute sync; a queued message turns Sent within seconds.
    refetchInterval: (q) => (q.state.data?.items.some((m) => m.status === 'queued' || m.status === 'sending') ? 5000 : 60_000),
  });
}

export function useMailMeta() {
  return useQuery({ queryKey: [...ROOT, 'meta'], queryFn: () => api<MailMeta>('/api/mail/meta'), refetchInterval: 60_000 });
}

/** `peek`: shown without the user opening it (the first message on arrival), so it stays unread. */
export function useMailMessage(id: number | null, peek = false) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...ROOT, 'message', id, peek],
    queryFn: async () => {
      const m = await api<MailDetail>(`/api/mail/${id}${peek ? '?peek=1' : ''}`);
      // Opening marks it read: the row loses its bold at once (no list refetch), the counts change.
      if (!peek) {
        // Every cached page of every list: the message is on whichever page holds it.
        qc.setQueriesData<MailPage>({ queryKey: [...ROOT, 'list'] }, (data) =>
          data?.items.some((x) => x.id === id && !x.isRead)
            ? { ...data, items: data.items.map((x) => (x.id === id ? { ...x, isRead: true } : x)) }
            : data,
        );
      }
      void qc.invalidateQueries({ queryKey: [...ROOT, 'meta'] });
      void qc.invalidateQueries({ queryKey: keys.navCounts });
      return m;
    },
    enabled: id !== null,
  });
}

/** After any change: the mail screen, the sidebar badge, and leads (history lines, status, tasks). */
function useRefresh() {
  const qc = useQueryClient();
  return (withLeads = false) => {
    void qc.invalidateQueries({ queryKey: ROOT });
    void qc.invalidateQueries({ queryKey: keys.navCounts });
    if (withLeads) void qc.invalidateQueries({ queryKey: keys.leadsAll });
    if (withLeads) void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
}

/** The mailbox was disconnected meanwhile: refresh it so the screen shows the connect note. */
function onMailboxError(qc: ReturnType<typeof useQueryClient>) {
  return (err: unknown) => {
    if (err instanceof ApiError && err.code === 'no_mailbox') {
      void qc.invalidateQueries({ queryKey: ['mailboxes'] });
      void qc.invalidateQueries({ queryKey: [...ROOT, 'meta'] });
    }
  };
}

export function useComposeMail() {
  const qc = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: MailCompose) => api<MailItem>('/api/mail', { method: 'POST', body }),
    onSuccess: () => refresh(true),
    onError: onMailboxError(qc),
  });
}

export function useReplyMail() {
  const qc = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: number; cc: string[]; body: string }) => api<MailItem>(`/api/mail/${v.id}/reply`, { method: 'POST', body: { cc: v.cc, body: v.body } }),
    onSuccess: () => refresh(true),
    onError: onMailboxError(qc),
  });
}

/** Mark read / unread, archive, log, link, create lead, add task: one mutation per action on a message. */
export function useMailAction() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: number; action: 'read' | 'archive' | 'log' | 'link' | 'create-lead' | 'task'; body?: unknown }) =>
      api<{ id: number; leadId?: number | null }>(`/api/mail/${v.id}/${v.action}`, { method: 'POST', body: v.body }),
    onSuccess: (_r, v) => refresh(v.action !== 'read' && v.action !== 'archive'),
  });
}

export function useSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: number) => api<{ queued: boolean }>(`/api/mailboxes/${accountId}/sync`, { method: 'POST' }),
    onSuccess: () => {
      // The run takes a few seconds; look again shortly.
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ROOT });
        void qc.invalidateQueries({ queryKey: ['mailboxes'] });
      }, 8000);
    },
  });
}
