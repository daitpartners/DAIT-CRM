/**
 * Template pictures and attachments (owner, 24 Nov 2026): the files of an uploaded .oft, checked and kept on disk.
 *
 * Uploads are untrusted: the type comes from the file's first bytes (never the name or what the browser said), each
 * file and all of a template's together are capped (TEMPLATE_ATTACHMENTS_MAX_BYTES), names are cleaned, and a
 * content-id is a short token. Files live in `<storage>/templates/<templateId>/<random>` and
 * `<storage>/campaigns/<campaignId>/<random>` (no user text in a path), folders 0700 and files 0600, every path resolved
 * and kept inside its folder (the import uploads' pattern, imports/storage.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_CID_MAX, TEMPLATE_ATTACHMENTS_MAX_BYTES, TEMPLATE_ATTACHMENTS_MAX_COUNT, type TemplateAttachmentUpload } from '@dait-crm/shared';
import { storageDir } from '../imports/storage.js';
import type { MailAttachment } from '../graph/client.js';

type Area = 'templates' | 'campaigns';

/** A refused upload, answered as `{ error: code }` with `status` (app.ts error handler). */
export class AttachmentError extends Error {
  constructor(readonly code: 'attachments_too_large' | 'attachment_type' | 'attachment_invalid' | 'template_files_missing', readonly status: number) {
    super(code);
    this.name = 'AttachmentError';
  }
}

/** Over a size cap: 413 `attachments_too_large`. */
export const tooLarge = () => new AttachmentError('attachments_too_large', 413);

/**
 * A stored file gone from disk (the template was replaced or deleted meanwhile, or storage lost it): 409
 * `template_files_missing`, never the error with its server path (security review I4).
 */
const missing = (err: unknown): never => {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new AttachmentError('template_files_missing', 409);
  throw err;
};

/**
 * Largest Graph sendMail request the CRM builds: Graph refuses one over 4 MB, so the files (base64), the HTML (as JSON)
 * and 16 KB for the rest stay under 3.9 MB (security review I1).
 */
export const GRAPH_REQUEST_MAX = 3_900_000;
const REQUEST_OVERHEAD = 16 * 1024;

/** Base64 characters of `bytes` bytes. */
export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** 413 `attachments_too_large` when files of `base64Total` characters and `html` would make too large a Graph request. */
export function checkRequestSize(base64Total: number, html: string | null | undefined): void {
  if (base64Total + Buffer.byteLength(JSON.stringify(html ?? '')) + REQUEST_OVERHEAD > GRAPH_REQUEST_MAX) throw tooLarge();
}

/** What a file is, from its bytes: the type sent and stored, and the extensions its name may have. */
type Kind = { contentType: string; exts: string[]; image: boolean };
const PNG: Kind = { contentType: 'image/png', exts: ['png'], image: true };
const JPEG: Kind = { contentType: 'image/jpeg', exts: ['jpg', 'jpeg'], image: true };
const GIF: Kind = { contentType: 'image/gif', exts: ['gif'], image: true };
const PDF: Kind = { contentType: 'application/pdf', exts: ['pdf'], image: false };
/** Office files: zip (docx, xlsx, pptx) and the older OLE2 (doc, xls) share magic bytes, so the name tells which. */
const ZIP_OFFICE: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const OLE_OFFICE: Record<string, string> = { doc: 'application/msword', xls: 'application/vnd.ms-excel' };

const starts = (b: Buffer, sig: number[]) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const extOf = (name: string) => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? '').toLowerCase();

/**
 * The file's kind from its magic bytes: PNG, JPEG, GIF, PDF, or an Office file (zip: docx / xlsx / pptx; OLE2: doc /
 * xls, told apart by the name's extension). null: not a type a template may carry.
 */
export function sniff(data: Buffer, name: string): Kind | null {
  if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (starts(data, [0xff, 0xd8, 0xff])) return JPEG;
  if (data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a') return GIF;
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return PDF;
  const ext = extOf(name);
  if (starts(data, [0x50, 0x4b, 0x03, 0x04]) && ZIP_OFFICE[ext]) return { contentType: ZIP_OFFICE[ext]!, exts: [ext], image: false };
  if (starts(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && OLE_OFFICE[ext]) return { contentType: OLE_OFFICE[ext]!, exts: [ext], image: false };
  return null;
}

/**
 * A file name safe to store, show and send: the last path part only, no control or reserved characters
 * (`<>:"/\|?*`), no leading dots, spaces collapsed, at most 120 characters, ending in an extension of its kind (the
 * kind's own one is added when it has another).
 */
export function cleanFileName(raw: string, kind: Kind): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  // Control, format (bidi marks, zero-width: \p{Cf}) and line / paragraph separator characters go, with reserved ones.
  // eslint-disable-next-line no-control-regex
  let name = last.replace(/[\u0000-\u001f\u007f<>:"|?*\u2028\u2029]|\p{Cf}/gu, '').replace(/\s+/g, ' ').replace(/^[\s.]+/, '').trim();
  if (!kind.exts.includes(extOf(name))) name = `${name.replace(/\.+$/, '') || 'attachment'}.${kind.exts[0]}`;
  // A Windows device name (CON.pdf, lpt1.docx) cannot be saved on the recipient's PC: prefixed.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = `.${extOf(name)}`;
    name = name.slice(0, 120 - ext.length).trimEnd() + ext;
  }
  return name;
}

/** A content-id the HTML may refer to: a short token of letters, digits and `._@+-` (no quotes, spaces or slashes). */
export function cleanCid(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^<|>$/g, '');
  return v && v.length <= ATTACHMENT_CID_MAX && /^[A-Za-z0-9._@+-]+$/.test(v) ? v : null;
}

/** A checked upload, ready to store. */
export interface CheckedFile {
  fileName: string;
  contentType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
  sha256: string;
  data: Buffer;
}

/**
 * The template's uploaded files checked: base64 that decodes, a known type (an inline file must be a picture), each
 * and all together within TEMPLATE_ATTACHMENTS_MAX_BYTES (413 `attachments_too_large`), at most
 * TEMPLATE_ATTACHMENTS_MAX_COUNT, and a valid content-id unique to the template on each inline one (422 otherwise).
 */
export function checkUploads(files: TemplateAttachmentUpload[]): CheckedFile[] {
  if (files.length > TEMPLATE_ATTACHMENTS_MAX_COUNT) throw new AttachmentError('attachment_invalid', 422);
  const cids = new Set<string>();
  let total = 0;
  return files.map((f) => {
    const data = Buffer.from(f.data, 'base64');
    if (!data.length) throw new AttachmentError('attachment_invalid', 422);
    total += data.length;
    if (data.length > TEMPLATE_ATTACHMENTS_MAX_BYTES || total > TEMPLATE_ATTACHMENTS_MAX_BYTES) throw tooLarge();
    const kind = sniff(data, f.name);
    if (!kind || (f.inline && !kind.image)) throw new AttachmentError('attachment_type', 422);
    let contentId: string | null = null;
    if (f.inline) {
      contentId = cleanCid(f.contentId);
      if (!contentId || cids.has(contentId.toLowerCase())) throw new AttachmentError('attachment_invalid', 422);
      cids.add(contentId.toLowerCase());
    }
    return {
      fileName: cleanFileName(f.name, kind), contentType: kind.contentType, size: data.length, contentId, isInline: f.inline,
      sha256: createHash('sha256').update(data).digest('hex'), data,
    };
  });
}

/** The absolute path of a stored file; refuses anything that would leave `<storage>/<area>`. */
function resolveInside(area: Area, rel: string): string {
  const root = path.resolve(storageDir(), area);
  const full = path.resolve(storageDir(), rel);
  if (!full.startsWith(root + path.sep)) throw new Error('attachment path outside storage');
  return full;
}

/** The area a stored path claims (resolveInside then checks it stays there). */
const areaOf = (rel: string): Area => (rel.startsWith('campaigns/') ? 'campaigns' : 'templates');

const folder = (area: Area, id: number) => {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('bad attachment folder id');
  return `${area}/${id}`;
};

/** Saves a file under `<area>/<id>/` with a random name; returns its storage path (relative to the storage folder). */
export async function saveFile(area: Area, id: number, data: Buffer): Promise<string> {
  const rel = `${folder(area, id)}/${randomUUID()}`;
  const full = resolveInside(area, rel);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, data, { mode: 0o600, flag: 'wx' });
  return rel;
}

/** Copies a stored file into `<area>/<id>/` (a Mailer campaign's copy of its template's files). */
export async function copyFileTo(fromRel: string, area: Area, id: number): Promise<string> {
  const rel = `${folder(area, id)}/${randomUUID()}`;
  const full = resolveInside(area, rel);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await copyFile(resolveInside(areaOf(fromRel), fromRel), full).catch(missing);
  return rel;
}

export async function readStoredFile(rel: string): Promise<Buffer> {
  return readFile(resolveInside(areaOf(rel), rel)).catch(missing);
}

/** Removes stored files (nothing happens for one already gone). */
export async function removeFiles(rels: string[]): Promise<void> {
  await Promise.all(rels.map((rel) => rm(resolveInside(areaOf(rel), rel), { force: true })));
}

/** Removes a template's or campaign's folder and every file in it. */
export async function removeFolder(area: Area, id: number): Promise<void> {
  await rm(resolveInside(area, folder(area, id)), { recursive: true, force: true });
}

/** A stored file as it is described (template rows and campaign copies alike). */
export interface StoredFile {
  fileName: string;
  contentType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
  storagePath: string;
}

/** `src="cid:…"` (or single-quoted) in sanitised HTML: the content-ids a message actually shows. */
export function cidsShown(html: string | null | undefined): Set<string> {
  return new Set([...(html ?? '').matchAll(/\bsrc\s*=\s*["']\s*cid:([^"'\s]+)["']/gi)].map((m) => m[1]!.toLowerCase()));
}

/**
 * The files to send with a message: the inline pictures its HTML shows (Graph `isInline` with their content-id) and
 * the regular attachments given, read from disk; all together within TEMPLATE_ATTACHMENTS_MAX_BYTES (413
 * `attachments_too_large`, as is a Graph request over GRAPH_REQUEST_MAX). An inline picture the HTML no longer shows
 * (removed in the editor) is not sent; a file gone from disk is 409 `template_files_missing`.
 */
export async function filesToSend(stored: StoredFile[], html: string | null | undefined): Promise<MailAttachment[]> {
  const shown = cidsShown(html);
  const picked = stored.filter((f) => (f.isInline ? !!f.contentId && shown.has(f.contentId.toLowerCase()) : true));
  if (picked.reduce((n, f) => n + f.size, 0) > TEMPLATE_ATTACHMENTS_MAX_BYTES) throw tooLarge();
  // The whole Graph request must fit (security review I1): checked before anything is read or queued.
  if (picked.length) checkRequestSize(picked.reduce((n, f) => n + base64Length(f.size), 0), html);
  return Promise.all(picked.map(async (f) => ({
    name: f.fileName,
    contentType: f.contentType,
    contentBase64: (await readStoredFile(f.storagePath)).toString('base64'),
    ...(f.isInline && f.contentId ? { isInline: true, contentId: f.contentId } : {}),
  })));
}
