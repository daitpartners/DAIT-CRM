import { prisma } from '../db.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { AttachmentError, filesToSend, type StoredFile } from './files.js';
import { outgoingBody, type Formatted } from './formatted.js';
import type { MailAttachment } from '../graph/client.js';

/**
 * A message filled from a template with files (template pictures and attachments, owner 24 Nov 2026): the template's
 * inline pictures (always offered; sent when the HTML still shows them) and the regular attachments the sender kept,
 * each of which must still be one of that template's (409 `template_files_missing` otherwise: the template's files
 * were replaced since it was picked). No template: no files (attachment ids without one are a 400).
 */
export async function templateFiles(templateId: number | null | undefined, attachmentIds: number[]): Promise<StoredFile[]> {
  if (!templateId) {
    if (attachmentIds.length) throw new ValidationError([{ path: ['attachmentIds'], message: 'Not attachments of a template' }]);
    return [];
  }
  const template = await prisma.emailTemplate.findUnique({ where: { id: templateId }, include: { attachments: { orderBy: { id: 'asc' } } } });
  if (!template) throw new NotFoundError();
  const regular = new Map(template.attachments.filter((a) => !a.isInline).map((a) => [a.id, a]));
  if (attachmentIds.some((id) => !regular.has(id))) throw new AttachmentError('template_files_missing', 409);
  const keep = new Set(attachmentIds);
  return template.attachments.filter((a) => a.isInline || keep.has(a.id));
}

/**
 * The message to queue with its files: the body sanitised (outgoingBody) keeping only cid: pictures of the template's
 * inline files, then the files it sends read from disk (filesToSend: 413 `attachments_too_large` past the cap).
 */
export async function outgoingWithFiles(
  body: string | undefined, bodyHtml: string | null | undefined, templateId: number | null | undefined, attachmentIds: number[],
): Promise<{ body: string; formatted: Formatted | null; attachments: MailAttachment[] }> {
  const stored = await templateFiles(templateId, attachmentIds);
  const cids = stored.filter((f) => f.isInline && f.contentId).map((f) => f.contentId!);
  const message = await outgoingBody(body, bodyHtml, cids);
  return { ...message, attachments: await filesToSend(stored, message.formatted?.html) };
}
