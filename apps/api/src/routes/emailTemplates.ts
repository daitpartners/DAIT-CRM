import type { FastifyPluginAsync } from 'fastify';
import type { EmailTemplate, EmailTemplateAttachment, Prisma } from '@prisma/client';
import { EmailTemplateInput, EmailTemplateUpdate, TemplateHtmlCheck, type TemplateAttachmentUpload } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { isNotFound, StaleError } from '../prismaErrors.js';
import { NotFoundError, parseBody } from '../validate.js';
import { FORMATTED_BODY_LIMIT, TEMPLATE_HTML_MAX, perUser, sanitizeFormatted, templateHtml } from '../mail/formatted.js';
import { checkUploads, removeFiles, removeFolder, saveFile, readStoredFile, type CheckedFile } from '../mail/files.js';

type WithCreator = EmailTemplate & { createdBy: { id: number; name: string } | null; attachments: EmailTemplateAttachment[] };
const include = { createdBy: { select: { id: true, name: true } }, attachments: { orderBy: { id: 'asc' } } } as const;

/**
 * Request size for creating or replacing a template: its HTML (up to MESSAGE_HTML_MAX_CHARS, JSON-escaped) and its
 * files as base64 (TEMPLATE_ATTACHMENTS_MAX_BYTES, a third larger).
 */
const TEMPLATE_BODY_LIMIT = 10 * 1024 * 1024;

/** A template's file as the API lists it (the bytes come from the attachment route). */
const attachmentView = (a: EmailTemplateAttachment) => ({
  id: a.id, name: a.fileName, contentType: a.contentType, size: a.size, contentId: a.contentId, inline: a.isInline,
});

function templateView(t: WithCreator) {
  return {
    id: t.id, name: t.name, language: t.language, subject: t.subject, body: t.body, bodyHtml: t.bodyHtml, sourceType: t.sourceType,
    fileName: t.fileName, fileSize: t.fileSize, attachments: t.attachments.map(attachmentView), createdBy: t.createdBy,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

/** The audit record: the HTML itself is left out (it can be large), only whether the template is formatted. */
function auditView(t: WithCreator) {
  const { bodyHtml, attachments, ...rest } = templateView(t);
  return { ...rest, formatted: bodyHtml !== null, attachments: attachments.map((a) => ({ name: a.name, size: a.size, inline: a.inline })) };
}

/** Lower-cased content-ids of the inline pictures among `files`: the only `cid:` pictures the template's HTML keeps. */
const inlineCids = (files: { contentId: string | null; isInline: boolean }[]) => files.filter((f) => f.isInline && f.contentId).map((f) => f.contentId!.toLowerCase());

/**
 * Writes a template's checked files to disk and lists them (inside the transaction that creates or replaces them).
 * `written` collects the paths, so the caller removes them when the transaction fails.
 */
async function storeFiles(tx: Prisma.TransactionClient, templateId: number, files: CheckedFile[], written: string[]): Promise<void> {
  for (const f of files) {
    const storagePath = await saveFile('templates', templateId, f.data);
    written.push(storagePath);
    await tx.emailTemplateAttachment.create({
      data: { templateId, fileName: f.fileName, contentType: f.contentType, size: f.size, contentId: f.contentId, isInline: f.isInline, storagePath, sha256: f.sha256 },
    });
  }
}

const checked = (files: TemplateAttachmentUpload[] | undefined) => (files ? checkUploads(files) : undefined);


/**
 * The team's email templates (prototype Settings → Email templates; release 2A): read by every signed-in user (every
 * compose box offers them), maintained by anyone who works on leads, as the prototype lets every user do.
 */
export const emailTemplateRoutes: FastifyPluginAsync = async (app) => {
  app.get('/email-templates', { preHandler: [requireUser] }, async (request) => {
    const lang = request.user!.language;
    const rows = await prisma.emailTemplate.findMany({ include, orderBy: [{ language: 'asc' }, { name: 'asc' }, { id: 'asc' }] });
    // The user's language first, then the others in language order (prototype templatesFor).
    rows.sort((a, b) => Number(b.language === lang) - Number(a.language === lang));
    return { items: rows.map(templateView) };
  });

  const manage = { preHandler: [requireRight('manage_leads')], bodyLimit: TEMPLATE_BODY_LIMIT, config: perUser(30) };

  app.post('/email-templates', manage, async (request, reply) => {
    const { attachments, ...body } = parseBody(EmailTemplateInput, request.body);
    const user = request.user!;
    // Files checked and HTML sanitised before the transaction (the worker thread may take up to its time limit); with
    // HTML, the plain body is the text derived from it, and only cid: pictures of its own inline files are kept.
    const files = checked(attachments) ?? [];
    const formatted = await templateHtml(body.bodyHtml, inlineCids(files));
    const written: string[] = [];
    try {
      const created = await prisma.$transaction(async (tx) => {
        const t = await tx.emailTemplate.create({
          data: { ...body, body: formatted ? formatted.text : body.body, bodyHtml: formatted?.html ?? null, fileName: body.fileName ?? null, fileSize: body.fileSize ?? null, createdById: user.id },
        });
        await storeFiles(tx, t.id, files, written);
        const full = await tx.emailTemplate.findUniqueOrThrow({ where: { id: t.id }, include });
        await audit(tx, { entityType: 'email_template', entityId: t.id, action: 'create', userId: user.id, after: auditView(full) });
        return full;
      });
      return reply.code(201).send(templateView(created));
    } catch (e) {
      await removeFiles(written);
      throw e;
    }
  });

  // An uploaded .oft is read in the browser; its HTML comes back sanitised before the editor shows it (it is sanitised
  // again when the template is saved), keeping the cid: pictures of the inline files read with it. null: nothing
  // usable (the template stays plain text).
  app.post('/email-templates/sanitize', { ...manage, bodyLimit: FORMATTED_BODY_LIMIT, config: perUser(20) }, async (request) => {
    const { html, cids } = parseBody(TemplateHtmlCheck, request.body);
    const r = await sanitizeFormatted(html, TEMPLATE_HTML_MAX, cids);
    return r.kind === 'html' ? { html: r.html, text: r.text } : { html: null, text: r.kind === 'fallback' ? r.text : '' };
  });

  app.patch<{ Params: { id: string } }>('/email-templates/:id', manage, async (request, reply) => {
    const { updatedAt, bodyHtml: html, attachments, ...rest } = parseBody(EmailTemplateUpdate, request.body);
    const user = request.user!;
    const id = Number(request.params.id);
    // Files present replace the template's (absent: they stay). The HTML keeps only cid: pictures of the inline files
    // it will have; when only the files change, the stored HTML is sanitised again against the new ones.
    const files = checked(attachments);
    const current = files || html !== undefined ? (Number.isInteger(id) ? await prisma.emailTemplate.findUnique({ where: { id }, include }) : null) : null;
    const cids = files ? inlineCids(files) : inlineCids(current?.attachments ?? []);
    // Absent: the HTML stays as it is; null or empty: the template becomes plain text. With HTML, the plain body is
    // the text derived from it.
    const source = html !== undefined ? html : files && current?.bodyHtml ? current.bodyHtml : undefined;
    const formatted = source === undefined ? undefined : await templateHtml(source, cids);
    const body = formatted === undefined ? rest : formatted ? { ...rest, body: formatted.text, bodyHtml: formatted.html } : { ...rest, bodyHtml: null };
    const written: string[] = [];
    try {
      const { updated, removed } = await prisma.$transaction(async (tx) => {
        const before = Number.isInteger(id) ? await tx.emailTemplate.findUnique({ where: { id }, include }) : null;
        if (!before) throw new NotFoundError();
        if (new Date(updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        await tx.emailTemplate.update({ where: { id, updatedAt: before.updatedAt }, data: body });
        if (files) {
          await tx.emailTemplateAttachment.deleteMany({ where: { templateId: id } });
          await storeFiles(tx, id, files, written);
        }
        const after = await tx.emailTemplate.findUniqueOrThrow({ where: { id }, include });
        await audit(tx, { entityType: 'email_template', entityId: id, action: 'update', userId: user.id, before: auditView(before), after: auditView(after) });
        return { updated: after, removed: files ? before.attachments.map((a) => a.storagePath) : [] };
      });
      // The replaced files go once the change is saved.
      await removeFiles(removed);
      return templateView(updated);
    } catch (e) {
      await removeFiles(written);
      if (e instanceof StaleError || isNotFound(e)) return reply.code(409).send({ error: 'stale' });
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>('/email-templates/:id', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const user = request.user!;
    const id = Number(request.params.id);
    await prisma.$transaction(async (tx) => {
      const before = Number.isInteger(id) ? await tx.emailTemplate.findUnique({ where: { id }, include }) : null;
      if (!before) throw new NotFoundError();
      await tx.emailTemplate.delete({ where: { id } });
      await audit(tx, { entityType: 'email_template', entityId: id, action: 'delete', userId: user.id, before: auditView(before) });
    });
    // Its files go with it (a Mailer campaign keeps its own copies).
    await removeFolder('templates', id);
    return reply.code(204).send();
  });

  /**
   * One of a template's files, for whoever can use templates (every signed-in user: the compose boxes show inline
   * pictures as data: URLs made from this). Always a download (Content-Disposition attachment, nosniff, a sandbox CSP),
   * with the type worked out from the bytes when it was uploaded.
   */
  app.get<{ Params: { id: string; attachmentId: string } }>(
    '/email-templates/:id/attachments/:attachmentId',
    { preHandler: [requireUser], config: perUser(240) },
    async (request, reply) => {
      const id = Number(request.params.id);
      const attachmentId = Number(request.params.attachmentId);
      if (!Number.isInteger(id) || !Number.isInteger(attachmentId)) throw new NotFoundError();
      const a = await prisma.emailTemplateAttachment.findFirst({ where: { id: attachmentId, templateId: id } });
      if (!a) throw new NotFoundError();
      const data = await readStoredFile(a.storagePath);
      const ascii = a.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      return reply
        .header('Content-Type', a.contentType)
        .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, no-store')
        .send(data);
    },
  );
};
