import type { EmailAccount, EmailMessage } from '@prisma/client';
import { GraphError, type GraphClient } from '../graph/client.js';
import { attachmentHeader } from '../imports/exports.js';
import { NotFoundError } from '../validate.js';
import { MailChangeError, ownMailbox, outlookFailure } from './changes.js';
import { sniff } from './files.js';

/**
 * Received attachments (web-mail release 2): listed, previewed and downloaded from Outlook on demand, never stored.
 * Always read server-side with the message OWNER's mailbox (the row's own account, while it is still its owner's
 * connected personal one), so a token never reaches the browser. Callers pass a message from `messageFor(…, 'read')`:
 * your own, or (Administrator / Manager) another user's team-readable one, view only.
 *
 * Kinds: a file attachment can be previewed (a real PDF or image, its bytes sniffed) or downloaded; an attached
 * message or event (`item`) downloads only (Graph gives its MIME content); a cloud link (`reference`) has no bytes, so
 * it is listed with no Preview or Download. Inline pictures (the body's `cid:` images) are not listed.
 */

/** Largest attachment the server fetches and passes on; Graph's bytes are read no further (413 attachment_too_large). */
export const ATTACHMENT_PROXY_MAX_BYTES = 25_000_000;
/** The only types ever served inline, and only when the bytes are that type. */
export const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif'] as const;
export type PreviewType = (typeof PREVIEW_TYPES)[number];

/** An attachment as the Email screen lists it. `kind: 'reference'` (a cloud link) has no Preview or Download. */
export interface AttachmentItem {
  id: string;
  name: string;
  contentType: string;
  size: number;
  preview: boolean;
  kind: 'file' | 'item' | 'reference';
}

/** Too large to pass on: 413 `attachment_too_large`. */
export class AttachmentTooLargeError extends Error {
  readonly status = 413 as const;
  readonly code = 'attachment_too_large' as const;
  constructor() {
    super('attachment_too_large');
    this.name = 'AttachmentTooLargeError';
  }
}

const PREVIEW_EXT = /\.(pdf|png|jpe?g|gif)$/i;

/** Runs a Graph call on the owner's mailbox; a failure becomes a MailChangeError (409 / 502 / 503) or 413. */
async function fromOutlook<T>(account: EmailAccount, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof GraphError && err.status === 413) throw new AttachmentTooLargeError();
    return outlookFailure(account, err);
  }
}

/**
 * The message's attachments, inline pictures left out. `preview` comes from the name's extension (pdf, png, jpg, jpeg,
 * gif) on a file attachment; serving checks the bytes again. A CRM-only row (no Graph id), or one whose mailbox is no
 * longer its owner's connected one → `{ available: false, items: [] }` (Graph is not asked).
 */
export async function attachmentsOf(graph: GraphClient, m: EmailMessage): Promise<{ available: boolean; items: AttachmentItem[] }> {
  const account = m.graphId ? await ownMailbox(m) : null;
  if (!m.graphId || !account) return { available: false, items: [] };
  const graphId = m.graphId;
  const all = await fromOutlook(account, () => graph.listAttachments(account, graphId));
  const items = all
    .filter((a) => !a.isInline)
    .map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, preview: a.kind === 'file' && PREVIEW_EXT.test(a.name), kind: a.kind }));
  return { available: true, items };
}

/**
 * One attachment's bytes, from the owner's mailbox. Listed first, for its name and kind: an id the message does not
 * have, or a cloud link (no bytes), is 404 and its bytes are never asked for; so is a CRM-only row; a mailbox no longer
 * connected is 409 mailbox_not_connected. More than
 * ATTACHMENT_PROXY_MAX_BYTES is 413. `previewType` is the type its bytes show (PDF, PNG, JPEG, GIF), never the name's
 * or Graph's; anything else is null (download only).
 */
export async function attachmentFile(
  graph: GraphClient, m: EmailMessage, attachmentId: string,
): Promise<{ name: string; data: Buffer; previewType: PreviewType | null }> {
  if (!m.graphId) throw new NotFoundError();
  const graphId = m.graphId;
  const account = await ownMailbox(m);
  if (!account) throw new MailChangeError('mailbox_not_connected', 409);
  const listed = await fromOutlook(account, () => graph.listAttachments(account, graphId));
  const item = listed.find((a) => a.id === attachmentId);
  if (!item || item.kind === 'reference') throw new NotFoundError();
  const data = await fromOutlook(account, () => graph.attachmentContent(account, graphId, attachmentId, ATTACHMENT_PROXY_MAX_BYTES));
  const sniffed = sniff(data, item.name)?.contentType;
  const previewType = item.kind === 'file' && (PREVIEW_TYPES as readonly string[]).includes(sniffed ?? '') ? (sniffed as PreviewType) : null;
  return { name: item.name, data, previewType };
}

/** The headers that serve an attachment's bytes: inline only for a sniffed preview type when asked; else a download. */
export function attachmentHeaders(name: string, previewType: PreviewType | null, inline: boolean): Record<string, string> {
  const base = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' };
  if (inline && previewType) {
    return {
      ...base,
      'Content-Type': previewType,
      'Content-Disposition': `inline${attachmentHeader(name).slice('attachment'.length)}`,
      ...(previewType.startsWith('image/') ? { 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox" } : {}),
    };
  }
  return {
    ...base,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': attachmentHeader(name),
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}
