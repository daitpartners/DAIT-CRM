import { createHash } from 'node:crypto';
import type { EmailAccount, EmailMessage, Prisma } from '@prisma/client';
import { TEMPLATE_ATTACHMENTS_MAX_BYTES, TEMPLATE_ATTACHMENTS_MAX_COUNT, type DraftAttachmentUpload, type DraftTemplateApply } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { GraphError, type GraphAttachment, type GraphClient, type MailAttachment } from '../graph/client.js';
import type { AuthUser } from '../plugins/auth.js';
import { NotFoundError } from '../validate.js';
import { outlookFailure } from './changes.js';
import { DraftError, assertEditable, myAccount, onDraft } from './drafts.js';
import { AttachmentError, checkUpload, cidsShown, cleanCid, sniff, storedAttachment } from './files.js';
import { templateFiles } from './templateFiles.js';

/**
 * The files of a draft in the user's own Outlook (web-mail release 3, plan decisions 7 and 8): attachments and inline
 * pictures uploaded from the CRM, a template's files, and the files Outlook already put on the draft. They go straight
 * onto the Outlook draft and are listed in `draft_files`; the CRM never stores their bytes. (drafts.ts and this module
 * import each other; neither uses the other's bindings at load time.)
 */

/**
 * A file on the Outlook draft (plan decisions 7 and 8), listed in `email_messages.draft_files` (`attachment_names` keeps
 * the non-inline names): `id` is the Graph attachment id; an inline picture has the content-id its HTML shows as
 * `cid:`. Uploaded from the CRM, copied from a template (`fromTemplate`, replaced when another template is applied),
 * or already on the draft in Outlook (a forward's original attachments, a quote's pictures, a draft made in Outlook).
 * The bytes are never stored by the CRM.
 */
export interface DraftFile { id: string; name: string; contentType: string; size: number; inline: boolean; contentId: string | null; fromTemplate?: true }
/** A draft file as the editor gets it: `dataUrl` (`data:<type>;base64,…`) only for inline pictures, so the editor can show them. */
export type DraftFileView = Omit<DraftFile, 'contentId' | 'fromTemplate'> & { contentId: string | null; dataUrl: string | null };

export const filesOf = (m: Pick<EmailMessage, 'draftFiles'>) => (m.draftFiles as unknown as DraftFile[]) ?? [];

/** The `draft_files` and `attachment_names` (non-inline names) columns for a draft's files. */
export const filesData = (files: DraftFile[]) => ({
  draftFiles: files as unknown as Prisma.InputJsonValue,
  attachmentNames: files.filter((f) => !f.inline).map((f) => f.name),
});

/** Every content-id of the draft's files: the only `cid:` pictures its HTML keeps. */
export const cidsOf = (files: DraftFile[]) => files.flatMap((f) => (f.contentId ? [f.contentId] : []));

/** A file Graph lists on the draft as a draft file (a template file applied before keeps its mark). */
export function fileOfGraph(a: GraphAttachment, before?: DraftFile): DraftFile {
  return {
    id: a.id, name: a.name.trim() || 'attachment', contentType: a.contentType, size: a.size, inline: a.isInline, contentId: cleanCid(a.contentId),
    ...(before?.fromTemplate ? { fromTemplate: true as const } : {}),
  };
}

/** A picture's bytes as a data URL, when they are a picture sniff() knows (the type from the bytes, never Graph's). */
function pictureUrl(data: Buffer, name: string): string | null {
  const kind = sniff(data, name);
  return kind?.image ? `data:${kind.contentType};base64,${data.toString('base64')}` : null;
}

const viewOf = (f: DraftFile, dataUrl: string | null): DraftFileView => ({
  id: f.id, name: f.name, contentType: f.contentType, size: f.size, inline: f.inline, contentId: f.contentId, dataUrl: f.inline ? dataUrl : null,
});

/**
 * The draft's files for the editor: each inline picture read from the Outlook draft (capped at
 * TEMPLATE_ATTACHMENTS_MAX_BYTES) as a data URL; `dataUrl: null` when it cannot be read or is not a known picture.
 */
export async function fileViews(graph: GraphClient | undefined, user: AuthUser, m: EmailMessage): Promise<DraftFileView[]> {
  const files = filesOf(m);
  const graphId = m.graphId;
  if (!graph || !graphId || !files.some((f) => f.inline)) return files.map((f) => viewOf(f, null));
  const account = await prisma.emailAccount.findFirst({ where: { kind: 'personal', userId: user.id, status: 'connected' } });
  return Promise.all(files.map(async (f) => {
    if (!f.inline || !account) return viewOf(f, null);
    try {
      return viewOf(f, pictureUrl(await graph.attachmentContent(account, graphId, f.id, TEMPLATE_ATTACHMENTS_MAX_BYTES), f.name));
    } catch {
      return viewOf(f, null);
    }
  }));
}

/**
 * Inline pictures the saved draft showed and its new HTML no longer shows (removed in the editor) are taken off the
 * Outlook draft and out of its files. Only pictures shown before go: one uploaded while this save was on its way is
 * kept. A removal Outlook refuses leaves the file listed (the save itself has landed).
 */
export async function detachRemovedPictures(graph: GraphClient, account: EmailAccount, m: EmailMessage, files: DraftFile[], html: string): Promise<void> {
  const before = cidsShown(`${m.bodyHtml ?? ''}${m.quotedHtml ?? ''}`);
  const now = cidsShown(html);
  const gone = files.filter((f) => f.inline && f.contentId && before.has(f.contentId.toLowerCase()) && !now.has(f.contentId.toLowerCase()));
  if (!gone.length) return;
  const removed = new Set<string>();
  for (const f of gone) {
    try {
      await graph.removeAttachment(account, m.graphId!, f.id);
      removed.add(f.id);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) removed.add(f.id);
    }
  }
  if (removed.size) await changeFiles(m.id, (list) => list.filter((f) => !removed.has(f.id)));
}

/**
 * Changes the draft's file list under a row lock (an upload, a removal and a save can overlap), keeping
 * `attachment_names` in step; returns the new list.
 */
async function changeFiles(id: number, change: (files: DraftFile[]) => DraftFile[]): Promise<DraftFile[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM email_messages WHERE id = ${id} FOR UPDATE`;
    const row = await tx.emailMessage.findUniqueOrThrow({ where: { id }, select: { draftFiles: true } });
    const files = change(filesOf(row));
    await tx.emailMessage.update({ where: { id }, data: filesData(files) });
    return files;
  });
}

/** Too many files on a draft: 422 attachment_invalid. */
const tooMany = () => new AttachmentError('attachment_invalid', 422);

/** The caller's own editable draft with its Outlook id and mailbox, for a file change. */
async function draftInOutlook(user: AuthUser, m: EmailMessage): Promise<{ account: EmailAccount; graphId: string }> {
  assertEditable(m);
  const account = await myAccount(user.id);
  if (!m.graphId) throw new DraftError('draft_gone', 409);
  return { account, graphId: m.graphId };
}

/** Puts one file on the Outlook draft and lists it (at most TEMPLATE_ATTACHMENTS_MAX_COUNT; past it the upload is taken off again). */
async function attach(graph: GraphClient, account: EmailAccount, m: EmailMessage, graphId: string, a: MailAttachment, file: Omit<DraftFile, 'id'>): Promise<DraftFile> {
  const { id } = await onDraft(account, () => graph.addAttachment(account, graphId, a));
  const added: DraftFile = { id, ...file };
  let over = false;
  await changeFiles(m.id, (list) => {
    over = list.length >= TEMPLATE_ATTACHMENTS_MAX_COUNT;
    return over ? list : [...list, added];
  });
  if (over) {
    await graph.removeAttachment(account, graphId, id).catch(() => undefined);
    throw tooMany();
  }
  return added;
}

/**
 * Uploads a file to the caller's own Outlook draft (plan decision 7): checked by its bytes (checkUpload: a known type,
 * an inline one a picture, at most TEMPLATE_ATTACHMENTS_MAX_BYTES), at most TEMPLATE_ATTACHMENTS_MAX_COUNT files per
 * draft. An inline picture (decision 8) gets the content-id `img-<first 16 hex of its sha256>@dait`; the same picture
 * again is the file already there.
 */
export async function addDraftFile(graph: GraphClient, user: AuthUser, m: EmailMessage, upload: DraftAttachmentUpload): Promise<DraftFileView> {
  const { account, graphId } = await draftInOutlook(user, m);
  const checked = checkUpload(upload);
  const dataUrl = upload.inline ? `data:${checked.contentType};base64,${checked.data.toString('base64')}` : null;
  const contentId = upload.inline ? `img-${createHash('sha256').update(checked.data).digest('hex').slice(0, 16)}@dait` : null;
  const files = filesOf(m);
  const same = contentId ? files.find((f) => f.inline && f.contentId === contentId) : undefined;
  if (same) return viewOf(same, dataUrl);
  if (files.length >= TEMPLATE_ATTACHMENTS_MAX_COUNT) throw tooMany();
  const contentBase64 = checked.data.toString('base64');
  const added = await attach(
    graph, account, m, graphId,
    { name: checked.fileName, contentType: checked.contentType, contentBase64, ...(contentId ? { isInline: true, contentId } : {}) },
    { name: checked.fileName, contentType: checked.contentType, size: checked.size, inline: upload.inline, contentId },
  );
  return viewOf(added, dataUrl);
}

/** Takes a file off the caller's own Outlook draft (already gone there is fine); a file the draft does not list is 404. */
export async function removeDraftFile(graph: GraphClient, user: AuthUser, m: EmailMessage, fileId: string): Promise<void> {
  const { account, graphId } = await draftInOutlook(user, m);
  if (!filesOf(m).some((f) => f.id === fileId)) throw new NotFoundError();
  await removeFromOutlook(graph, account, graphId, fileId);
  await changeFiles(m.id, (list) => list.filter((f) => f.id !== fileId));
}

/** Removes an attachment from the Outlook draft: 404 (already gone, or the draft is) is fine; any other failure → outlookFailure. */
async function removeFromOutlook(graph: GraphClient, account: EmailAccount, graphId: string, fileId: string): Promise<void> {
  try {
    await graph.removeAttachment(account, graphId, fileId);
  } catch (err) {
    if (!(err instanceof GraphError && err.status === 404)) await outlookFailure(account, err);
  }
}

/**
 * Copies a template's files onto the caller's own Outlook draft: its inline pictures (with the template's own
 * content-ids, which the template's HTML shows) and the attachments the sender kept (templateFiles: one no longer of
 * the template is 409 template_files_missing). Every file is read before the draft changes; the files of a template
 * applied before are taken off first. At most TEMPLATE_ATTACHMENTS_MAX_COUNT files on the draft (422).
 */
export async function applyTemplateFiles(graph: GraphClient, user: AuthUser, m: EmailMessage, body: DraftTemplateApply): Promise<DraftFileView[]> {
  const { account, graphId } = await draftInOutlook(user, m);
  const stored = await templateFiles(body.templateId, body.attachmentIds);
  const read = await Promise.all(stored.map(async (f) => ({ f, a: await storedAttachment(f) })));
  const previous = filesOf(m).filter((f) => f.fromTemplate);
  if (filesOf(m).length - previous.length + read.length > TEMPLATE_ATTACHMENTS_MAX_COUNT) throw tooMany();
  for (const f of previous) await removeFromOutlook(graph, account, graphId, f.id);
  const old = new Set(previous.map((f) => f.id));
  if (old.size) await changeFiles(m.id, (list) => list.filter((f) => !old.has(f.id)));
  const views: DraftFileView[] = [];
  for (const { f, a } of read) {
    const inline = f.isInline && !!f.contentId;
    const added = await attach(graph, account, m, graphId, a, {
      name: f.fileName, contentType: f.contentType, size: f.size, inline, contentId: inline ? f.contentId : null, fromTemplate: true,
    });
    views.push(viewOf(added, inline ? pictureUrl(Buffer.from(a.contentBase64, 'base64'), f.fileName) : null));
  }
  return views;
}
