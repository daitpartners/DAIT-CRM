import { useEffect, useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { flagDueDay, localNow, type ListSort, type MailChange, type MailChip, type MailView, type ReplyMode } from '@dait-crm/shared';
import { useToast } from '../components/Toast';
import { mailErrorText } from '../i18n/labels';
import { useT } from '../i18n/useT';
import { ApiError, api } from './client';
import { keys, type Me } from './queries';
import type { ActivityRow } from './leads';

/** Email screen folders and smart views, sorts and quick filters: one list shared with the API (packages/shared). */
export { MAIL_CHIPS, MAIL_SORTS, MAIL_VIEWS } from '@dait-crm/shared';
export type { ListSort, MailChange, MailChip, MailView } from '@dait-crm/shared';

/**
 * The list's filters. `mailOf` (web-mail release 1, `view_team_mail` only): `all` = your mail plus the team's lead mail,
 * a user id = that user's lead mail; absent = your own mailbox. Web-mail release 2: the quick filter `chip`,
 * conversation view (`conv`, on unless false), the sort, and the Filters panel (From, To, Subject, Lead, Owner = the
 * lead's assignee, Date, Has attachments). Each is sent only when set.
 */
export type MailFilter = {
  view: MailView; company?: number; lead?: number; project?: number; s?: string; mailOf?: 'all' | number;
  chip?: MailChip; conv?: boolean; sort?: ListSort; dir?: 'asc' | 'desc';
  from?: string; to?: string; subject?: string; leadQ?: string; owner?: 'me' | number;
  date?: 'today' | '7d' | '30d' | '12m' | 'custom'; since?: string; until?: string; attachments?: boolean;
};

/**
 * Messages per batch: the list loads the next 50 when scrolled near its foot (owner, 23 Nov 2026: no page numbers on
 * the Email screen).
 */
export const MAIL_BATCH = 50;

/** One batch of the list; `total` counts every message the filters leave (null on later batches, asked with count=0). */
export type MailPage = { items: MailItem[]; total: number | null; page: number; pageSize: number };

/**
 * A message in the list (release 2B-2). Your own, or (web-mail release 1, Administrators and Managers) another user's
 * lead mail: `owner` is whose mailbox it is, `viewOnly` when that is not you (read, log and tasks only).
 */
export type MailItem = {
  id: number;
  owner: { id: number; name: string };
  viewOnly: boolean;
  /** The lead is another owner's that you cannot open: only its number is shown (`leadId` and `companyId` are null). */
  leadRestricted: boolean;
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
  /** Web-mail release 2: Outlook's flag (`notFlagged`, `flagged`, `complete`) and its due day (`YYYY-MM-DD`). */
  flagStatus: string;
  flagDue: string | null;
  /** You answered it (a later message of yours in the conversation). */
  replied: boolean;
  /** Messages in its conversation in this list's scope (1 for a message on its own). */
  conversationCount: number;
  /** The linked lead's status; null without a lead or for a restricted lead. */
  leadStatus: string | null;
  /** Web-mail release 3: when a scheduled send leaves (null when it is not scheduled). */
  scheduledAt: string | null;
  /** List rows only: the conversation's messages in this view (at most BULK_MAX), which the row's actions change together. */
  conversationIds?: number[];
};

/** The reading pane's lead panel (mirror of the API's mail/leadPanel.ts LeadPanel). */
export type LeadPanel = {
  company: { id: number; name: string; site: string | null; place: string | null } | null;
  contact: { name: string; role: string | null; email: string | null; phone: string | null } | null;
  owner: string | null;
  followUp: { date: string; time: string | null; due: boolean } | null;
  lastActivity: { title: string; occurredAt: string } | null;
  value: { amount: number; currency: string } | null;
  recent: ActivityRow[];
  linkReason: { kind: 'address' | 'domain'; value: string } | null;
};

/** A message after a change (mirror of the API's mail/changes.ts ChangedMessage); `removed` when deleted for good. */
export type ChangedMessage = { id: number; folder: string; isRead: boolean; flagStatus: string; flagDue: string | null; removed: boolean };

/** A received attachment (mirror of the API's mail/attachments.ts); `reference` (a cloud link) has no Preview or Download. */
export type MailAttachment = { id: string; name: string; contentType: string; size: number; preview: boolean; kind: 'file' | 'item' | 'reference' };

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
  /** Another owner's lead (`leadRestricted`): its number and company name only; `lead`, `contact`, `company` are null. */
  restrictedLead: { number: string; companyName: string } | null;
  /**
   * Thread history, newest first, the open message included (see the API's threadHistory); web-mail release 2 adds what
   * the reading pane's conversation shows.
   */
  thread: {
    id: number; occurredAt: string; direction: 'in' | 'out'; who: string; subject: string;
    kind: 'sent' | 'reply' | 'received' | 'draft'; by: string | null; unmatched: boolean;
    fromName: string | null; fromAddress: string; toAddresses: string[]; ccAddresses: string[]; preview: string;
    hasAttachments: boolean; folder: string; isRead: boolean;
  }[];
  /** A visible linked lead's panel; null without a lead or for a restricted lead. */
  leadPanel: LeadPanel | null;
};

export type MailMeta = {
  mailbox: { id: number; address: string; status: string; lastSyncAt: string | null } | null;
  unread: number;
  /**
   * Web-mail release 2, by the list's own views: Inbox = unread; Drafts, Scheduled, Flagged, Awaiting reply = messages;
   * Follow-up due and My leads / Team leads (`leads`) = distinct leads.
   */
  counts: { inbox: number; drafts: number; scheduled: number; flagged: number; awaiting: number; due: number; leads: number };
  /** `isClient` marks the option "name · client" (prototype). */
  companies: { id: number; name: string; legalName: string | null; isClient: boolean }[];
  leads: { id: number; number: string; companyId: number | null; companyName: string; status: string }[];
  /** Release 3B: every project the user can see (the Project filter). */
  projects: { id: number; number: string; name: string; companyId: number }[];
  /** The "Mail of:" picker (`view_team_mail`): the other users with a mailbox, by name; empty for everyone else. */
  mailUsers: { id: number; name: string }[];
  /** The Filters panel's Owner choices (active users, by name). */
  leadOwners: { id: number; name: string }[];
};

export type MailCompose = {
  to: string; cc: string[]; subject: string; body: string; bodyHtml?: string | null; leadId?: number | null; companyId?: number | null; projectId?: number | null;
  /** A template's files: its inline pictures go with the HTML that shows them, plus the attachments kept. */
  templateId?: number | null; attachmentIds?: number[];
};

const ROOT = ['mail'] as const;
const listPath = (f: MailFilter, page: number) => {
  const q = new URLSearchParams({ view: f.view });
  if (f.company) q.set('company', String(f.company));
  if (f.lead) q.set('lead', String(f.lead));
  if (f.project) q.set('project', String(f.project));
  if (f.s) q.set('s', f.s);
  if (f.mailOf !== undefined) q.set('mailOf', String(f.mailOf));
  if (f.chip) q.set('chip', f.chip);
  if (f.conv === false) q.set('conv', '0');
  if (f.sort) q.set('sort', f.sort);
  if (f.dir) q.set('dir', f.dir);
  for (const k of ['from', 'to', 'subject', 'leadQ', 'date', 'since', 'until'] as const) {
    if (f[k]) q.set(k, f[k]);
  }
  if (f.owner !== undefined) q.set('owner', String(f.owner));
  if (f.attachments) q.set('attachments', '1');
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

/** Counts and filter lists for the list's scope (`mailOf`, as the list); `mailbox` is always your own. */
export function useMailMeta(mailOf?: 'all' | number) {
  return useQuery({
    queryKey: [...ROOT, 'meta', mailOf ?? 'me'],
    queryFn: () => api<MailMeta>(`/api/mail/meta${mailOf !== undefined ? `?mailOf=${mailOf}` : ''}`),
    refetchInterval: 60_000,
  });
}

/** `peek`: shown without the user opening it (the first message on arrival), so it stays unread. */
export function useMailMessage(id: number | null, peek = false) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...ROOT, 'message', id, peek],
    queryFn: async () => {
      const m = await api<MailDetail>(`/api/mail/${id}${peek ? '?peek=1' : ''}`);
      // Opening marks it read: the row loses its bold at once (no list refetch), the counts change. Another user's
      // message (view only) is never marked read.
      if (!peek && !m.viewOnly) {
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

/**
 * Reply, Reply all or Forward (web-mail release 2). `mode` defaults to `reply` and `to` to none: Reply and Reply all
 * go to the recipients the server works out (shared replyRecipients), Forward to `to`.
 */
export function useReplyMail() {
  const qc = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: number; mode?: ReplyMode; to?: string[]; cc: string[]; body: string; bodyHtml?: string | null }) =>
      api<MailItem>(`/api/mail/${v.id}/reply`, {
        method: 'POST', body: { mode: v.mode ?? 'reply', to: v.to ?? [], cc: v.cc, body: v.body, bodyHtml: v.bodyHtml ?? null },
      }),
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

/* ---------- Two-way mailbox changes (web-mail release 2): optimistic, put back when Outlook refuses ---------- */

type ListCache = InfiniteData<MailPage, number>;
type Changeable = Pick<MailItem, 'folder' | 'isRead' | 'flagStatus' | 'flagDue'>;
/** What a change does to one message: its new fields, or `removed` (deleted for good). */
type Patch = Partial<Changeable> & { removed?: boolean };
/** The caches as they were before a change, for putting the changed messages back. */
type MailSnapshot = { lists: [readonly unknown[], ListCache | undefined][]; details: [readonly unknown[], MailDetail | undefined][] };

/** Whether a list of `view` still holds a message that is now in `folder` (mail/list.ts viewWhere). */
function viewHolds(view: MailView, folder: string): boolean {
  switch (view) {
    case 'inbox': case 'sent': case 'drafts': case 'archive': case 'deleted': return folder === view;
    case 'awaiting': return folder === 'sent';
    case 'scheduled': return true;
    default: return folder !== 'deleted'; // flagged, due, mine
  }
}

/** The screen's guess at a change, before Outlook answers (the server's answer replaces it). */
function predicted(change: MailChange, today: string): (m: Pick<MailItem, 'folder'>) => Patch {
  switch (change.type) {
    case 'move': return () => ({ folder: change.folder });
    // Delete moves to Deleted items; Delete inside Deleted items deletes for good.
    case 'delete': return (m) => (m.folder === 'deleted' ? { removed: true } : { folder: 'deleted' });
    case 'read': return () => ({ isRead: change.isRead });
    case 'flag':
      if (change.flag === 'complete') return () => ({ flagStatus: 'complete', flagDue: null });
      if (change.flag === 'clear') return () => ({ flagStatus: 'notFlagged', flagDue: null });
      return () => ({ flagStatus: 'flagged', flagDue: flagDueDay(change.flag as Exclude<typeof change.flag, 'complete' | 'clear'>, today) });
  }
}

const fromServer = (c: ChangedMessage): Patch => (c.removed
  ? { removed: true }
  : { folder: c.folder, isRead: c.isRead, flagStatus: c.flagStatus, flagDue: c.flagDue });

const fields = (p: Patch): Partial<Changeable> => {
  const { removed: _removed, ...rest } = p;
  return rest;
};

/** Whether a list of `f` still holds a message after patch `p` (a flag cleared or completed leaves Flagged, as in Outlook). */
function listHolds(f: MailFilter | undefined, p: Patch): boolean {
  if (p.removed) return false;
  if (p.folder !== undefined && !viewHolds(f?.view ?? 'inbox', p.folder)) return false;
  const flaggedOnly = f?.view === 'flagged' || f?.chip === 'flagged';
  return !(flaggedOnly && p.flagStatus !== undefined && p.flagStatus !== 'flagged');
}

/**
 * `patchOf` applied to every cached list batch and open message: a move or delete drops the row from lists whose view
 * no longer holds it, and a cleared or completed flag from Flagged lists (the first batch's `total` follows); read and
 * flag change it in place otherwise. `patchOf` answers null for a message the change does not touch.
 */
function applyPatches(qc: QueryClient, patchOf: (m: Pick<MailItem, 'id' | 'folder'>) => Patch | null) {
  for (const [key, data] of qc.getQueriesData<ListCache>({ queryKey: [...ROOT, 'list'] })) {
    if (!data) continue;
    const filter = key[2] as MailFilter | undefined;
    let dropped = 0;
    let touched = false;
    const pages = data.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((m) => {
        const p = patchOf(m);
        if (!p) return [m];
        touched = true;
        if (!listHolds(filter, p)) {
          dropped += 1;
          return [];
        }
        return [{ ...m, ...fields(p) }];
      }),
    }));
    if (!touched) continue;
    if (pages[0] && pages[0].total !== null) pages[0] = { ...pages[0], total: Math.max(0, pages[0].total - dropped) };
    qc.setQueryData<ListCache>(key, { ...data, pages });
  }
  for (const [key, data] of qc.getQueriesData<MailDetail>({ queryKey: [...ROOT, 'message'] })) {
    if (!data) continue;
    const own = patchOf(data);
    const thread = data.thread.flatMap((t) => {
      const p = patchOf(t);
      if (!p) return [t];
      if (p.removed) return [];
      return [{ ...t, ...(p.folder !== undefined ? { folder: p.folder } : {}), ...(p.isRead !== undefined ? { isRead: p.isRead } : {}) }];
    });
    const threadTouched = thread.length !== data.thread.length || thread.some((t, i) => t !== data.thread[i]);
    if (!own && !threadTouched) continue;
    qc.setQueryData<MailDetail>(key, { ...data, ...(own ? fields(own) : {}), thread });
  }
}

/**
 * `snap`'s rows `ids` put back into `current`: where still listed, as they were; where dropped, at their old place
 * (after the nearest row before them that is still there). Other rows keep what happened since (another change, a
 * refresh), so putting one change back never undoes another.
 */
function restoreRows(current: ListCache, snap: ListCache, ids: Set<number>): ListCache {
  const before = new Map(snap.pages.flatMap((p) => p.items).filter((m) => ids.has(m.id)).map((m) => [m.id, m]));
  const pages = current.pages.map((p) => ({ ...p, items: p.items.map((m) => before.get(m.id) ?? m) }));
  if (pages.length === 0) return current;
  const present = new Set(pages.flatMap((p) => p.items.map((m) => m.id)));
  let restored = 0;
  snap.pages.forEach((sp, pi) => {
    const at = Math.min(pi, pages.length - 1);
    sp.items.forEach((m, i) => {
      if (!ids.has(m.id) || present.has(m.id)) return;
      const items = [...pages[at]!.items];
      let pos = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = items.findIndex((x) => x.id === sp.items[j]!.id);
        if (k >= 0) {
          pos = k + 1;
          break;
        }
      }
      items.splice(pos, 0, m);
      pages[at] = { ...pages[at]!, items };
      present.add(m.id);
      restored += 1;
    });
  });
  if (restored && pages[0]!.total !== null) pages[0] = { ...pages[0]!, total: pages[0]!.total + restored };
  return { ...current, pages };
}

/** The shared machinery of useMailChange and useBulkMailChange. */
function useOptimisticMail() {
  const qc = useQueryClient();
  return {
    /** Stops refetches that would overwrite the guess, keeps the caches as they were, and applies the guess. */
    async begin(ids: number[], change: MailChange): Promise<MailSnapshot> {
      // Only queries already showing something: a first load cancelled would leave its screen empty.
      const shown = { predicate: (q: { state: { data: unknown } }) => q.state.data !== undefined };
      await Promise.all([qc.cancelQueries({ queryKey: [...ROOT, 'list'], ...shown }), qc.cancelQueries({ queryKey: [...ROOT, 'message'], ...shown })]);
      const snapshot: MailSnapshot = {
        lists: qc.getQueriesData<ListCache>({ queryKey: [...ROOT, 'list'] }),
        details: qc.getQueriesData<MailDetail>({ queryKey: [...ROOT, 'message'] }),
      };
      const today = localNow(qc.getQueryData<Me>(keys.me)?.timezone ?? 'UTC').day;
      const guess = predicted(change, today);
      const set = new Set(ids);
      applyPatches(qc, (m) => (set.has(m.id) ? guess(m) : null));
      return snapshot;
    },
    /** Puts the messages `ids` back as they were in `snapshot`. */
    restore(snapshot: MailSnapshot, ids: number[]) {
      const set = new Set(ids);
      for (const [key, snap] of snapshot.lists) {
        const current = qc.getQueryData<ListCache>(key);
        if (snap && current) qc.setQueryData<ListCache>(key, restoreRows(current, snap, set));
      }
      for (const [key, snap] of snapshot.details) {
        const current = qc.getQueryData<MailDetail>(key);
        if (!snap || !current) continue;
        const own = set.has(current.id) ? { folder: snap.folder, isRead: snap.isRead, flagStatus: snap.flagStatus, flagDue: snap.flagDue } : {};
        // Newest first, as the API sends it: the changed entries as they were, the others as they are now.
        const thread = [...current.thread.filter((c) => !set.has(c.id)), ...snap.thread.filter((t) => set.has(t.id))]
          .sort((a, b) => (a.occurredAt === b.occurredAt ? b.id - a.id : a.occurredAt < b.occurredAt ? 1 : -1));
        qc.setQueryData<MailDetail>(key, { ...current, ...own, thread });
      }
    },
    /** The server's answer (exact flag day, a delete for good) replaces the guess. */
    confirm(done: ChangedMessage[]) {
      const byId = new Map(done.map((c) => [c.id, fromServer(c)]));
      applyPatches(qc, (m) => byId.get(m.id) ?? null);
    },
    /**
     * Counts on the folders and the sidebar badge; after a move or delete, the lists of the folder the messages went to
     * are marked stale, so that folder shows them when opened (loaded again then, not now).
     */
    settle(change: MailChange) {
      void qc.invalidateQueries({ queryKey: [...ROOT, 'meta'] });
      void qc.invalidateQueries({ queryKey: keys.navCounts });
      const to = change.type === 'move' ? change.folder : change.type === 'delete' ? 'deleted' : null;
      if (to) {
        void qc.invalidateQueries({
          queryKey: [...ROOT, 'list'],
          predicate: (q) => viewHolds((q.queryKey[2] as MailFilter | undefined)?.view ?? 'inbox', to),
          refetchType: 'none',
        });
      }
    },
  };
}

/** Why a change failed, worded for a toast (mailErrorText). */
function useChangeToast() {
  const t = useT();
  const toast = useToast();
  return (err: unknown) => toast(mailErrorText(t, err instanceof ApiError ? err.code : ''), 'warn');
}

/**
 * One change to one message (`POST /api/mail/:id/change`): Delete, Archive, Move to, Mark read / unread, Flag. The
 * screen changes at once; when Outlook refuses (outlook_refused, outlook_busy, mailbox_not_connected, view_only…) the
 * message goes back where it was and a toast says why (Review Focus 1).
 */
export function useMailChange() {
  const optimistic = useOptimisticMail();
  const failed = useChangeToast();
  return useMutation<ChangedMessage, unknown, { id: number; change: MailChange }, MailSnapshot>({
    mutationFn: (v) => api<ChangedMessage>(`/api/mail/${v.id}/change`, { method: 'POST', body: v.change }),
    onMutate: (v) => optimistic.begin([v.id], v.change),
    onSuccess: (changed) => optimistic.confirm([changed]),
    onError: (err, v, snapshot) => {
      if (snapshot) optimistic.restore(snapshot, [v.id]);
      failed(err);
    },
    onSettled: (_r, _e, v) => optimistic.settle(v.change),
  });
}

/**
 * The same change to several messages (`POST /api/mail/bulk`, at most BULK_MAX: a selection or a conversation's
 * messages), optimistic as useMailChange. The ids Outlook refused go back, with the toast "{n} could not be changed in
 * Outlook"; a refused request puts every one back with its reason.
 */
export function useBulkMailChange() {
  const optimistic = useOptimisticMail();
  const failed = useChangeToast();
  const t = useT();
  const toast = useToast();
  return useMutation<{ done: ChangedMessage[]; failed: { id: number; error: string }[] }, unknown, { ids: number[]; change: MailChange }, MailSnapshot>({
    mutationFn: (v) => api(`/api/mail/bulk`, { method: 'POST', body: { ids: v.ids, change: v.change } }),
    onMutate: (v) => optimistic.begin(v.ids, v.change),
    onSuccess: (result, _v, snapshot) => {
      if (result.failed.length && snapshot) {
        optimistic.restore(snapshot, result.failed.map((f) => f.id));
        toast(t('{n} could not be changed in Outlook', { n: result.failed.length }), 'warn');
      }
      optimistic.confirm(result.done);
    },
    onError: (err, v, snapshot) => {
      if (snapshot) optimistic.restore(snapshot, v.ids);
      failed(err);
    },
    onSettled: (_r, _e, v) => optimistic.settle(v.change),
  });
}

/**
 * Follow-up ▾ (`POST /api/mail/:id/follow-up`): the linked lead's next follow-up day and the time on its follow-up
 * task, or `clear`. A CRM change (allowed in team view). Toasts its own failure.
 */
export function useMailFollowUp() {
  const refresh = useRefresh();
  const failed = useChangeToast();
  return useMutation({
    mutationFn: (v: { id: number; date: string; time: string } | { id: number; clear: true }) => {
      const { id, ...body } = v;
      return api<{ leadId: number; nextFollowUp: string | null; taskId: number | null }>(`/api/mail/${id}/follow-up`, { method: 'POST', body });
    },
    onSuccess: () => refresh(true),
    onError: failed,
  });
}

/** Unlink (`POST /api/mail/:id/unlink`): this message loses its lead, contact and company. Toasts its own failure. */
export function useUnlinkMail() {
  const refresh = useRefresh();
  const failed = useChangeToast();
  return useMutation({
    mutationFn: (id: number) => api<{ id: number; leadId: null }>(`/api/mail/${id}/unlink`, { method: 'POST' }),
    onSuccess: () => refresh(true),
    onError: failed,
  });
}

/** Link to lead suggestions for message `id` (leads matched on its addresses and domains); off while `id` is null. */
export function useLeadSuggestions(id: number | null) {
  return useQuery({
    queryKey: [...ROOT, 'lead-suggestions', id],
    queryFn: () => api<{ items: { id: number; number: string; companyName: string; status: string }[] }>(`/api/mail/${id}/lead-suggestions`),
    enabled: id !== null,
  });
}

/**
 * Message `id`'s received attachments, read from Outlook on demand (only while `enabled`: the message has some).
 * `available: false` when its mailbox is no longer connected.
 */
export function useMailAttachments(id: number | null, enabled: boolean) {
  return useQuery({
    queryKey: [...ROOT, 'attachments', id],
    queryFn: () => api<{ available: boolean; items: MailAttachment[] }>(`/api/mail/${id}/attachments`),
    enabled: id !== null && enabled,
  });
}

/** Preview (`inline`, a real PDF or image only) or Download of attachment `att`; Graph's base64 id is encoded (F13). */
export function attachmentUrl(id: number, att: string, inline: boolean): string {
  return `/api/mail/${id}/attachment?att=${encodeURIComponent(att)}${inline ? '&inline=1' : ''}`;
}
