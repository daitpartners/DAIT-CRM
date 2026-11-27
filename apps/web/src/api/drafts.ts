import { useCallback, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { DraftKind, SendFollowUp } from '@dait-crm/shared';
import { toBase64 } from '../lib/templateFiles';
import { ApiError, api } from './client';
import { keys } from './queries';
import type { LeadPanel } from './mail';

/**
 * Writing in the user's own Outlook (web-mail release 3, routes/mailDrafts.ts): start a draft (new, reply, reply all,
 * forward), open it, auto-save it, discard it, its files, send it (after the Undo window, or scheduled), take a send
 * back (Undo, Cancel, Edit) or send a scheduled one now, and the To / Cc / Bcc suggestions. Only the caller's own
 * mailbox: another user's draft answers 403 view_only.
 */

export type { SendFollowUp } from '@dait-crm/shared';

/** One recipient chip: the address, and who it is when the CRM knows (a contact's or lead's name, the lead's number). */
export type Recipient = { address: string; name: string | null; leadNumber: string | null };

/** A file on the draft (mirror of the API's DraftFileView); an inline picture's `dataUrl` shows it in the editor. */
export type DraftFileView = { id: string; name: string; contentType: string; size: number; inline: boolean; contentId: string | null; dataUrl: string | null };

/** What the editor opens (mirror of the API's mail/drafts.ts DraftView). */
export type DraftView = {
  id: number;
  replyToId: number | null;
  from: string;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  subject: string;
  /** The user's part of the message (a reply's folded quote is `quotedHtml`, kept by the server). */
  bodyHtml: string;
  quotedHtml: string | null;
  files: DraftFileView[];
  leadId: number | null;
  projectId: number | null;
  lead: LeadPanel | null;
  /** The lead's time zone when it is not the sender's (`label`: its city). */
  recipientZone: { zone: string; label: string } | null;
  savedAt: string;
  status: string;
  scheduledAt: string | null;
};

/** The draft as the editor holds it: what auto-save and Send send. */
export type DraftFields = { to: string[]; cc: string[]; bcc: string[]; subject: string; bodyHtml: string; leadId?: number | null; projectId?: number | null };

/** Starting a draft: a new message, or a reply / reply all / forward of `replyToId`. */
export type DraftStart = { kind?: DraftKind; replyToId?: number; leadId?: number; projectId?: number };

/** A send queued (mirror of the API's mail/send.ts QueuedSend). */
export type SendResult = {
  id: number;
  sendAt: string;
  /** The end of the Undo window (a send now); null for a scheduled send (Cancel instead). */
  undoUntil: string | null;
  /** The follow-up filed when the mail leaves; null when none was asked or the server dropped it. */
  followUp: { date: string; time: string } | null;
};

/** Outside the `['mail']` prefix: a mail change refreshing the screen must not reload a draft being written. */
const draftKey = (id: number | null) => ['mail-draft', id] as const;

/** Auto-save is quiet this long after the last change. */
export const AUTO_SAVE_MS = 2000;
/** Recipient suggestions wait this long after the last key. */
export const SUGGEST_MS = 250;

/** Codes after which saving again cannot succeed: auto-save stops until another draft is opened. */
const FINAL = new Set(['draft_gone', 'mailbox_changed', 'not_draft', 'already_sent', 'view_only', 'not_found', 'forbidden', 'no_mailbox']);

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : 'try_again');

/** After a send, Undo, Cancel or Send now: the mail screen, the sidebar badges and, with one, the lead page. */
function refreshAfterSend(qc: QueryClient, leadId: number | null | undefined) {
  void qc.invalidateQueries({ queryKey: ['mail'] });
  void qc.invalidateQueries({ queryKey: keys.navCounts });
  if (leadId) void qc.invalidateQueries({ queryKey: keys.lead(leadId) });
}

/** The mailbox was disconnected meanwhile: refresh it so the screen shows the connect note. */
function onMailboxGone(qc: QueryClient) {
  return (err: unknown) => {
    if (err instanceof ApiError && err.code === 'no_mailbox') {
      void qc.invalidateQueries({ queryKey: ['mailboxes'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'meta'] });
    }
  };
}

/**
 * Opens draft `id` (off while null). Read again each time an editor mounts, never in the background while it is open
 * (no refetch on focus or reconnect), so what the editor is writing is never replaced.
 */
export function useDraft(id: number | null) {
  return useQuery({
    queryKey: draftKey(id),
    queryFn: () => api<DraftView>(`/api/mail/drafts/${id}`),
    enabled: id !== null,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

/** Starts a draft in the user's Outlook; the answer is cached as that draft, and the Drafts folder refreshes. */
export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DraftStart) => api<DraftView>('/api/mail/drafts', { method: 'POST', body }),
    onSuccess: (view) => {
      qc.setQueryData(draftKey(view.id), view);
      void qc.invalidateQueries({ queryKey: ['mail'] });
    },
    onError: onMailboxGone(qc),
  });
}

/** Discards draft `id` (in Outlook too). */
export function useDiscardDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/mail/drafts/${id}`, { method: 'DELETE' }),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: draftKey(id) });
      void qc.invalidateQueries({ queryKey: ['mail'] });
      void qc.invalidateQueries({ queryKey: keys.navCounts });
    },
  });
}

/**
 * Auto-save of draft `id` while `enabled`: the whole draft is saved AUTO_SAVE_MS after the last change, one request at
 * a time (a change while one is saving is saved once it answers), and `flush()` saves now (resolving once everything
 * held is saved, or the save failed). `savedAt` is the server's time of the last save; `error` the code of the last
 * failure (`draft_gone`, `outlook_busy`…), cleared by the next save. After a final code (the draft is gone in Outlook,
 * already sent, from another mailbox) nothing more is saved. Opening another draft (`id`) starts afresh, taking the
 * fields at that moment as saved.
 */
export function useAutoSave(id: number | null, fields: DraftFields, opts: { enabled: boolean }) {
  const [state, setState] = useState<{ savedAt: string | null; saving: boolean; error: string | null }>({ savedAt: null, saving: false, error: null });
  const text = JSON.stringify(fields);
  const latest = useRef({ fields, text });
  latest.current = { fields, text };
  const draftId = useRef(id);
  /** The fields as the server last saved them (JSON). */
  const saved = useRef(text);
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const stopped = useRef(false);
  const enabled = useRef(opts.enabled);
  enabled.current = opts.enabled;

  useEffect(() => {
    draftId.current = id;
    saved.current = latest.current.text;
    again.current = false;
    stopped.current = false;
    running.current = null;
    setState({ savedAt: null, saving: false, error: null });
  }, [id]);

  const loop = useCallback(async () => {
    const forId = draftId.current;
    do {
      again.current = false;
      const { fields: body, text: bodyText } = latest.current;
      if (forId === null || stopped.current || bodyText === saved.current) return;
      setState((s) => ({ ...s, saving: true }));
      try {
        const r = await api<{ savedAt: string }>(`/api/mail/drafts/${forId}`, { method: 'PATCH', body });
        if (draftId.current !== forId) return;
        saved.current = bodyText;
        setState({ savedAt: r.savedAt, saving: false, error: null });
      } catch (err) {
        if (draftId.current !== forId) return;
        const code = codeOf(err);
        if (FINAL.has(code)) stopped.current = true;
        setState((s) => ({ ...s, saving: false, error: code }));
        return;
      }
    } while (again.current);
  }, []);

  const save = useCallback((): Promise<void> => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const run: Promise<void> = loop().finally(() => {
      if (running.current === run) running.current = null;
    });
    running.current = run;
    return run;
  }, [loop]);

  useEffect(() => {
    if (!opts.enabled || id === null || stopped.current || text === saved.current) return;
    const timer = setTimeout(() => void save(), AUTO_SAVE_MS);
    return () => clearTimeout(timer);
  }, [text, id, opts.enabled, save]);

  const flush = useCallback(async () => {
    if (!enabled.current || draftId.current === null) return;
    await save();
  }, [save]);

  return { ...state, flush };
}

/** A file's bytes as base64 (no `data:` prefix), as the upload takes them. */
function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(toBase64(new Uint8Array(reader.result as ArrayBuffer)));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Files on draft `id`, straight onto the Outlook draft: `add` uploads one (an attachment, or an inline picture when
 * `inline`) and answers it as listed; `remove` takes one off. The editor keeps its own list from the answers.
 */
export function useDraftFile(id: number | null) {
  const adding = useMutation({
    mutationFn: async (v: { file: File; inline: boolean }) =>
      api<DraftFileView>(`/api/mail/drafts/${id}/files`, { method: 'POST', body: { name: v.file.name, data: await fileBase64(v.file), inline: v.inline } }),
  });
  const removing = useMutation({
    mutationFn: (fileId: string) => api<void>(`/api/mail/drafts/${id}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }),
  });
  const { mutateAsync: addAsync } = adding;
  const { mutateAsync: removeAsync } = removing;
  const add = useCallback((file: File, inline: boolean) => addAsync({ file, inline }), [addAsync]);
  const remove = useCallback((fileId: string) => removeAsync(fileId), [removeAsync]);
  return { add, remove, busy: adding.isPending || removing.isPending };
}

/** Copies a template's files (its inline pictures, the attachments kept) onto draft `id`, replacing a template's before. */
export function useApplyTemplateFiles(id: number | null) {
  return useMutation({
    mutationFn: (v: { templateId: number; attachmentIds: number[] }) =>
      api<{ files: DraftFileView[] }>(`/api/mail/drafts/${id}/template`, { method: 'POST', body: v }).then((r) => r.files),
  });
}

/**
 * Sends draft `id` as `fields` hold it (saved first by the server): after the Undo window (`at` null) or at `at` (an
 * ISO instant), with an optional follow-up.
 */
export function useSendDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; fields: DraftFields; at: string | null; followUp: SendFollowUp | null }) =>
      api<SendResult>(`/api/mail/drafts/${v.id}/send`, { method: 'POST', body: { ...v.fields, at: v.at, followUp: v.followUp } }),
    onSuccess: (_r, v) => refreshAfterSend(qc, v.fields.leadId),
    onError: onMailboxGone(qc),
  });
}

/** Undo, a scheduled send's Cancel, and Edit: the draft back in Drafts, answered (and cached) as the editor opens it. */
export function useUnsend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<DraftView>(`/api/mail/${id}/unsend`, { method: 'POST' }),
    onSuccess: (view) => {
      qc.setQueryData(draftKey(view.id), view);
      refreshAfterSend(qc, view.leadId);
    },
  });
}

/** A scheduled send sent now (still through the queue). `leadId`: the draft's lead, refreshed with it. */
export function useSendNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; leadId?: number | null }) => api<void>(`/api/mail/${v.id}/send-now`, { method: 'POST' }),
    onSuccess: (_r, v) => refreshAfterSend(qc, v.leadId),
  });
}

/** `value`, once it has not changed for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** To / Cc / Bcc suggestions for what is being typed: asked SUGGEST_MS after the last key, from 2 characters. */
export function useRecipientSuggestions(q: string) {
  const term = useDebounced(q.trim(), SUGGEST_MS);
  return useQuery({
    queryKey: ['mail-recipients', term],
    queryFn: async () => (await api<{ items: Recipient[] }>(`/api/mail/recipients?q=${encodeURIComponent(term)}`)).items,
    enabled: term.length >= 2,
    // The last answer stays while the next is asked; nothing is suggested under 2 characters.
    placeholderData: term.length >= 2 ? keepPreviousData : undefined,
    staleTime: 30_000,
  });
}

/** Who these addresses are (lead, contact, user), for the recipient chips; none asked, none answered. */
export async function resolveRecipients(addresses: string[]): Promise<Recipient[]> {
  if (addresses.length === 0) return [];
  return (await api<{ items: Recipient[] }>('/api/mail/recipients/resolve', { method: 'POST', body: { addresses } })).items;
}
