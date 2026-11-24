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

/** Content-id (lower case) → the picture's data: URL. */
export type InlineImages = Record<string, string>;

/** Bytes as base64 (in slices: a spread of a megabyte of bytes would overflow the call stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What a picture may be shown as (the server checks the bytes again). */
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
/** What a template may carry: pictures, PDF and Office documents. */
const DOC_EXTS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls']);
const extOf = (name: string) => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? '').toLowerCase();

/** The type a picture is shown as, from its first bytes (null: not a PNG, JPEG or GIF). */
function imageType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  return null;
}

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
    const image = imageType(f.data);
    const ok = f.inline ? !!image : !!image || DOC_EXTS.has(extOf(f.name));
    if (!ok || !f.data.length) {
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
      name: f.name, contentId: f.inline ? f.contentId : null, inline: f.inline, contentType: image ?? IMAGE_TYPES[extOf(f.name)] ?? f.contentType,
      size: f.data.length, data: toBase64(f.data),
    });
  }
  return { keep, skipped, tooLarge };
}

/** The inline pictures of uploaded files as data: URLs, by content-id. */
export function uploadImages(files: UploadFile[]): InlineImages {
  const out: InlineImages = {};
  for (const f of files) if (f.inline && f.contentId) out[f.contentId.toLowerCase()] = `data:${f.contentType};base64,${f.data}`;
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
      img.setAttribute('src', images[cid]!);
      img.setAttribute('data-cid', cid);
    }
  });
}

/** The editor's HTML with each shown picture back as its `cid:` (what is saved and sent). */
export function restoreCids(html: string, images: InlineImages): string {
  const entries = Object.entries(images);
  if (!entries.length || !/data:/i.test(html)) return html;
  const byUrl = new Map(entries.map(([cid, url]) => [url, cid]));
  return eachImage(html, (img) => {
    const marked = img.getAttribute('data-cid');
    const cid = (marked && images[marked] === img.getAttribute('src') ? marked : null) ?? byUrl.get(img.getAttribute('src') ?? '');
    if (cid) img.setAttribute('src', `cid:${cid}`);
    img.removeAttribute('data-cid');
  });
}
