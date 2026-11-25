import { TEMPLATE_ATTACHMENTS_MAX_BYTES } from '@dait-crm/shared';
import type { OftAttachment } from './oft';

/**
 * Template pictures and attachments (owner, 24 Nov 2026). A template's HTML refers to its inline pictures as
 * `cid:<content-id>` (as Outlook does); the editing frame cannot load those (and loads nothing from the CRM itself), so
 * for display each one becomes a `data:` URL of the picture, and before the message is saved or sent the data: URLs go
 * back to their cid: (the server keeps a cid: only for an inline picture of that template).
 */

/** A file read from an uploaded .oft, ready to upload with the template (base64) and to show (data: URL). */
export type UploadFile = { name: string; contentId: string | null; inline: boolean; contentType: string; size: number; data: string };

/**
 * Content-id (lower case) → the picture's data: URL and its content-id as the file has it (restored in that exact case:
 * a client may match a cid case-sensitively; security review I2).
 */
export type InlineImages = Record<string, { url: string; cid: string }>;

/** Bytes as base64 (in slices: a spread of a megabyte of bytes would overflow the call stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The file's type from its first bytes, by the server's own rules (apps/api/src/mail/files.ts `sniff`), so a file the
 * server would refuse is left out here with a notice rather than failing the whole save (review M5). null: refused.
 */
export function sniffType(b: Uint8Array, name: string): { contentType: string; image: boolean } | null {
  const starts = (sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
  const text = (n: number) => String.fromCharCode(...b.subarray(0, n));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', image: true };
  if (starts([0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', image: true };
  if (text(6) === 'GIF87a' || text(6) === 'GIF89a') return { contentType: 'image/gif', image: true };
  if (text(5) === '%PDF-') return { contentType: 'application/pdf', image: false };
  const ext = extOf(name);
  if (starts([0x50, 0x4b, 0x03, 0x04]) && ZIP_OFFICE[ext]) return { contentType: ZIP_OFFICE[ext]!, image: false };
  if (starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && OLE_OFFICE[ext]) return { contentType: OLE_OFFICE[ext]!, image: false };
  return null;
}

const ZIP_OFFICE: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const OLE_OFFICE: Record<string, string> = { doc: 'application/msword', xls: 'application/vnd.ms-excel' };
const extOf = (name: string) => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? '').toLowerCase();

/**
 * The .oft's files a template can keep: inline pictures that are PNG, JPEG or GIF, and regular attachments that are
 * pictures, PDF or Office documents; together within the server's cap (inline pictures first). `skipped`: the names
 * left out (a type the CRM does not take, or no room left).
 */
export function uploadFiles(files: OftAttachment[]): { keep: UploadFile[]; skipped: string[]; tooLarge: boolean } {
  const keep: UploadFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  let tooLarge = false;
  // Inline pictures first: the message needs them more than an attachment.
  for (const f of [...files.filter((x) => x.inline), ...files.filter((x) => !x.inline)]) {
    const kind = sniffType(f.data, f.name);
    if (!kind || (f.inline && !kind.image) || !f.data.length) {
      skipped.push(f.name);
      continue;
    }
    if (total + f.data.length > TEMPLATE_ATTACHMENTS_MAX_BYTES) {
      skipped.push(f.name);
      tooLarge = true;
      continue;
    }
    total += f.data.length;
    keep.push({
      name: f.name, contentId: f.inline ? f.contentId : null, inline: f.inline, contentType: kind.contentType,
      size: f.data.length, data: toBase64(f.data),
    });
  }
  return { keep, skipped, tooLarge };
}

/** The inline pictures of uploaded files as data: URLs, by content-id. */
export function uploadImages(files: UploadFile[]): InlineImages {
  const out: InlineImages = {};
  for (const f of files) if (f.inline && f.contentId) out[f.contentId.toLowerCase()] = { url: `data:${f.contentType};base64,${f.data}`, cid: f.contentId };
  return out;
}

/** HTML parsed inertly (a <template> loads no pictures and runs nothing), each <img> given to `fn`, written back. */
function eachImage(html: string, fn: (img: HTMLImageElement) => void): string {
  const holder = document.createElement('template');
  holder.innerHTML = html;
  holder.content.querySelectorAll('img').forEach(fn);
  return holder.innerHTML;
}

const CID = /^\s*cid:(\S+)\s*$/i;

/** The HTML with each `cid:` picture it has an image for shown as that data: URL (for the editor and previews). */
export function showInlineImages(html: string, images: InlineImages): string {
  if (!Object.keys(images).length || !/cid:/i.test(html)) return html;
  return eachImage(html, (img) => {
    const cid = CID.exec(img.getAttribute('src') ?? '')?.[1]?.toLowerCase();
    if (cid && images[cid]) {
      img.setAttribute('src', images[cid]!.url);
      img.setAttribute('data-cid', cid);
    }
  });
}

/** The editor's HTML with each shown picture back as its `cid:` (what is saved and sent). */
export function restoreCids(html: string, images: InlineImages): string {
  const entries = Object.entries(images);
  if (!entries.length || !/data:/i.test(html)) return html;
  const byUrl = new Map(entries.map(([, v]) => [v.url, v.cid]));
  return eachImage(html, (img) => {
    const marked = img.getAttribute('data-cid')?.toLowerCase();
    const src = img.getAttribute('src') ?? '';
    const cid = (marked && images[marked]?.url === src ? images[marked]!.cid : null) ?? byUrl.get(src);
    if (cid) img.setAttribute('src', `cid:${cid}`);
    img.removeAttribute('data-cid');
  });
}
