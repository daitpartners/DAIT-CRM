import { useEffect, useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ApiError, api } from './client';
import { keys } from './queries';

/** Email screen views (prototype folders and smart views). */
export const MAIL_VIEWS = ['inbox', 'sent', 'drafts', 'archive', 'unlinked', 'awaiting', 'mine'] as const;
export type MailView = (typeof MAIL_VIEWS)[number];

export type MailFilter = { view: MailView; company?: number; lead?: number; project?: number; s?: string };

/**
 * Messages per batch: the list loads the next 50 when scrolled near its foot (owner, 23 Nov 2026: no page numbers on
 * the Email screen).
 */
export const MAIL_BATCH = 50;

/** One batch of the list; `total` counts every message the filters leave (null on later batches, asked with count=0). */
export type MailPage = { items: MailItem[]; total: number | null; page: number; pageSize: number };

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
  /** Sanitised HTML (shown in the reader's sandboxed frame); null for plain text. */
  bodyHtml: string | null;
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
  /** `isClient` marks the option "name · client" (prototype). */
  companies: { id: number; name: string; legalName: string | null; isClient: boolean }[];
  leads: { id: number; number: string; companyId: number | null; companyName: string; status: string }[];
  /** Release 3B: every project the user can see (the Project filter). */
  projects: { id: number; number: string; name: string; companyId: number }[];
};

export type MailCompose = {
  to: string; cc: string[]; subject: string; body: string; leadId?: number | null; companyId?: number | null; projectId?: number | null;
};

const ROOT = ['mail'] as const;
const listPath = (f: MailFilter, page: number) => {
  const q = new URLSearchParams({ view: f.view });
  if (f.company) q.set('company', String(f.company));
  if (f.lead) q.set('lead', String(f.lead));
  if (f.project) q.set('project', String(f.project));
  if (f.s) q.set('s', f.s);
  // Later batches need no total: the first batch (and its refresh) carries it.
  if (page > 1) {
    q.set('page', String(page));
    q.set('count', '0');
  }
  q.set('pageSize', String(MAIL_BATCH));
  return `/api/mail?${q.toString()}`;
};

type MailBatches = InfiniteData<MailPage, number>;

/** `a` is listed after `b` (the list's order: newest first, then higher id first). */
const isAfter = (a: MailItem, b: MailItem) => a.occurredAt < b.occurredAt || (a.occurredAt === b.occurredAt && a.id < b.id);

/**
 * A fresh first batch merged into the loaded list: its rows replace what was loaded up to its last row (new mail
 * appears, changed rows update, rows archived or moved meanwhile go); rows loaded beyond it stay as they were. When the
 * first batch is the whole list, nothing else stays.
 */
export function mergeHead(data: MailBatches, head: MailPage): MailBatches {
  const ids = new Set(head.items.map((m) => m.id));
  const last = head.items.at(-1);
  const whole = head.items.length < head.pageSize;
  const keep = (m: MailItem) => !whole && !ids.has(m.id) && !!last && isAfter(m, last);
  const [first, ...rest] = data.pages;
  return {
    ...data,
    pages: [
      { ...head, items: [...head.items, ...(first?.items.filter(keep) ?? [])] },
      ...rest.map((p) => ({ ...p, items: p.items.filter(keep) })),
    ],
  };
}

/**
 * The list, one batch of 50 at a time (`fetchNextPage` loads the next). `items` are the batches loaded so far, once each
 * (mail arriving between two batches shifts the later one; a message already shown is not repeated). Kept fresh by
 * asking again for the first batch only (every 60 s, every 5 s while one of yours is sending) and merging it in, never
 * every loaded batch (security review M5).
 */
export function useMailList(f: MailFilter, enabled = true) {
  const qc = useQueryClient();
  const queryKey = [...ROOT, 'list', f];
  const q = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => api<MailPage>(listPath(f, pageParam)),
    initialPageParam: 1,
    // Distinct messages: offsets shift when mail arrives, so a batch can repeat a few rows already loaded.
    getNextPageParam: (last, pages) =>
      (new Set(pages.flatMap((p) => p.items.map((m) => m.id))).size < (pages[0]?.total ?? 0) && last.items.length > 0 ? last.page + 1 : undefined),
    placeholderData: keepPreviousData,
    enabled,
  });
  const pages = q.data?.pages;
  const items = useMemo(() => {
    const seen = new Set<number>();
    return (pages ?? []).flatMap((p) => p.items).filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [pages]);
  const sending = items.some((m) => m.status === 'queued' || m.status === 'sending');
  const live = enabled && !!pages && !q.isPlaceholderData;
  const keyText = JSON.stringify(queryKey);
  useEffect(() => {
    if (!live) return;
    // Never alongside a batch being loaded (or another refresh): the merge would be written over when that batch lands,
    // so this tick is skipped and the next one merges (security review N3).
    const busy = () => qc.isFetching({ queryKey, exact: true }) > 0;
    let asking = false;
    const timer = setInterval(() => {
      if (asking || busy()) return;
      asking = true;
      api<MailPage>(listPath(f, 1))
        .then((head) => {
          if (!busy()) qc.setQueryData<MailBatches>(queryKey, (data) => (data ? mergeHead(data, head) : data));
        })
        .catch(() => undefined) // the next tick tries again
        .finally(() => {
          asking = false;
        });
    }, sending ? 5000 : 60_000);
    return () => clearInterval(timer);
    // The filter is in keyText.
  }, [keyText, live, sending, qc]);
  return { ...q, items, total: pages?.[0]?.total ?? 0 };
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
        // Every loaded batch of every list: the message is in whichever batch holds it.
        qc.setQueriesData<InfiniteData<MailPage, number>>({ queryKey: [...ROOT, 'list'] }, (data) =>
          data?.pages.some((p) => p.items.some((x) => x.id === id && !x.isRead))
            ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === id ? { ...x, isRead: true } : x)) })) }
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
