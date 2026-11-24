import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './client';
import { restoreCids, showInlineImages, toBase64, type InlineImages, type UploadFile } from '../lib/templateFiles';

export type TemplateLanguage = 'en' | 'es' | 'fr';

/** A template's picture or attachment (24 Nov 2026): an inline picture the HTML shows as `cid:<contentId>`, or a file. */
export type TemplateAttachment = { id: number; name: string; contentType: string; size: number; contentId: string | null; inline: boolean };

/** A team email template (release 2A), as `GET /api/email-templates` returns it. */
export type EmailTemplate = {
  id: number;
  name: string;
  language: TemplateLanguage;
  subject: string;
  body: string;
  /** Formatted templates (24 Nov 2026): the sanitised HTML (from an .oft, or the formatted editor); null when plain. */
  bodyHtml: string | null;
  sourceType: 'manual' | 'oft';
  fileName: string | null;
  fileSize: number | null;
  /** Pictures and attachments read from its .oft. */
  attachments: TemplateAttachment[];
  createdBy: { id: number; name: string } | null;
  createdAt: string;
  updatedAt: string;
};
export type TemplateInput = Pick<EmailTemplate, 'name' | 'language' | 'subject' | 'body'> &
  Partial<Pick<EmailTemplate, 'bodyHtml' | 'sourceType' | 'fileName' | 'fileSize'>> & {
    /** An uploaded .oft's files (base64); on an update, present replaces the template's. */
    attachments?: Pick<UploadFile, 'name' | 'contentId' | 'inline' | 'data'>[];
  };

const KEY = ['email-templates'] as const;

/** Every template, the user's language first (the API orders them). */
export function useTemplates() {
  return useQuery({ queryKey: KEY, queryFn: async () => (await api<{ items: EmailTemplate[] }>('/api/email-templates')).items });
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: TemplateInput & { updatedAt?: string } }) =>
      v.id
        ? api<EmailTemplate>(`/api/email-templates/${v.id}`, { method: 'PATCH', body: v.body })
        : api<EmailTemplate>('/api/email-templates', { method: 'POST', body: v.body }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/email-templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * An uploaded .oft's HTML made safe by the server (the email reader's sanitiser) before the template editor shows it;
 * null when nothing usable is left.
 */
export async function sanitizeTemplateHtml(html: string, cids: string[] = []): Promise<string | null> {
  return (await api<{ html: string | null }>('/api/email-templates/sanitize', { method: 'POST', body: { html, cids } })).html;
}

/**
 * A template's inline pictures as data: URLs by content-id, fetched from the attachment route (signed-in users), so
 * the editing frame and previews can show them without loading anything from the CRM.
 */
async function fetchInlineImages(tpl: Pick<EmailTemplate, 'id' | 'attachments'>): Promise<InlineImages> {
  const out: InlineImages = {};
  await Promise.all(tpl.attachments.filter((a) => a.inline && a.contentId).map(async (a) => {
    const res = await fetch(`/api/email-templates/${tpl.id}/attachments/${a.id}`, { credentials: 'include' });
    if (!res.ok) return;
    out[a.contentId!.toLowerCase()] = `data:${a.contentType};base64,${toBase64(new Uint8Array(await res.arrayBuffer()))}`;
  }));
  return out;
}

const imagesKey = (tpl: Pick<EmailTemplate, 'id' | 'updatedAt'>) => [...KEY, tpl.id, tpl.updatedAt, 'images'] as const;

/** A template's inline pictures (cached per template version); none to fetch for a template without any. */
function loadImages(qc: QueryClient, tpl: Pick<EmailTemplate, 'id' | 'updatedAt' | 'attachments'>): Promise<InlineImages> {
  if (!tpl.attachments.some((a) => a.inline)) return Promise.resolve({});
  return qc.fetchQuery({ queryKey: imagesKey(tpl), queryFn: () => fetchInlineImages(tpl), staleTime: Infinity }).catch(() => ({}));
}

/** The inline pictures of a template for a preview ({} while loading, or with none). */
export function useTemplateImages(tpl: Pick<EmailTemplate, 'id' | 'updatedAt' | 'attachments'> | null | undefined): InlineImages {
  const { data } = useQuery({
    queryKey: tpl ? imagesKey(tpl) : [...KEY, 'none', 'images'],
    queryFn: () => (tpl ? fetchInlineImages(tpl) : {}),
    enabled: !!tpl && tpl.attachments.some((a) => a.inline),
    staleTime: Infinity,
  });
  return data ?? {};
}

/** What a compose box sends for a template's files: the template, and the regular attachments the sender kept. */
export type TemplateFilesSend = { templateId: number | null; attachmentIds: number[] };

/**
 * A compose box's template files (lead Email tab, Compose): picking a template loads its inline pictures and shows
 * them in the message (data: URLs), and lists its regular attachments, which the sender may remove. `apply` returns
 * the HTML to put in the editor, or `undefined` when another template was picked meanwhile; `send` gives the HTML
 * with its pictures back as cid: and what to send with it.
 */
export function useTemplateFiles() {
  const qc = useQueryClient();
  const [state, setState] = useState<{ templateId: number | null; images: InlineImages; attachments: TemplateAttachment[] }>({ templateId: null, images: {}, attachments: [] });
  const turn = useRef(0);

  const apply = useCallback(async (tpl: EmailTemplate | undefined, html: string | null): Promise<string | null | undefined> => {
    const mine = ++turn.current;
    if (!tpl || !tpl.attachments.length) {
      setState({ templateId: tpl?.id ?? null, images: {}, attachments: [] });
      return html;
    }
    const images = html ? await loadImages(qc, tpl) : {};
    if (mine !== turn.current) return undefined;
    setState({ templateId: tpl.id, images, attachments: tpl.attachments.filter((a) => !a.inline) });
    return html ? showInlineImages(html, images) : html;
  }, [qc]);

  const clear = useCallback(() => {
    turn.current += 1;
    setState({ templateId: null, images: {}, attachments: [] });
  }, []);

  const remove = useCallback((id: number) => setState((s) => ({ ...s, attachments: s.attachments.filter((a) => a.id !== id) })), []);

  const send = useCallback(
    (html: string | null): { bodyHtml: string | null } & TemplateFilesSend => ({
      bodyHtml: html === null ? null : restoreCids(html, state.images),
      templateId: state.templateId,
      attachmentIds: state.attachments.map((a) => a.id),
    }),
    [state],
  );

  return { attachments: state.attachments, apply, clear, remove, send };
}
