import { prisma } from '../db.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { AttachmentError, type StoredFile } from './files.js';

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
