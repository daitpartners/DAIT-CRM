import type { FastifyPluginAsync } from 'fastify';
import type { EmailTemplate } from '@prisma/client';
import { EmailTemplateInput, EmailTemplateUpdate, TemplateHtmlCheck } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { isNotFound, StaleError } from '../prismaErrors.js';
import { NotFoundError, parseBody } from '../validate.js';
import { FORMATTED_BODY_LIMIT, sanitizeFormatted } from '../mail/formatted.js';

type WithCreator = EmailTemplate & { createdBy: { id: number; name: string } | null };
const include = { createdBy: { select: { id: true, name: true } } } as const;

function templateView(t: WithCreator) {
  return {
    id: t.id, name: t.name, language: t.language, subject: t.subject, body: t.body, bodyHtml: t.bodyHtml, sourceType: t.sourceType,
    fileName: t.fileName, fileSize: t.fileSize, createdBy: t.createdBy, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

/** The audit record: the HTML itself is left out (it can be large), only whether the template is formatted. */
function auditView(t: WithCreator) {
  const { bodyHtml, ...rest } = templateView(t);
  return { ...rest, formatted: bodyHtml !== null };
}

/** The HTML to store: sanitised here whatever the browser sent (null keeps the template plain text). */
async function storedHtml(html: string | null | undefined): Promise<string | null> {
  return (await sanitizeFormatted(html))?.html ?? null;
}

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

  const manage = { preHandler: [requireRight('manage_leads')], bodyLimit: FORMATTED_BODY_LIMIT };

  app.post('/email-templates', manage, async (request, reply) => {
    const body = parseBody(EmailTemplateInput, request.body);
    const user = request.user!;
    // Sanitised before the transaction: the worker thread may take up to its time limit.
    const bodyHtml = await storedHtml(body.bodyHtml);
    const created = await prisma.$transaction(async (tx) => {
      const t = await tx.emailTemplate.create({
        data: { ...body, bodyHtml, fileName: body.fileName ?? null, fileSize: body.fileSize ?? null, createdById: user.id }, include,
      });
      await audit(tx, { entityType: 'email_template', entityId: t.id, action: 'create', userId: user.id, after: auditView(t) });
      return t;
    });
    return reply.code(201).send(templateView(created));
  });

  // An uploaded .oft is read in the browser; its HTML comes back sanitised before the editor shows it (it is sanitised
  // again when the template is saved). null: nothing usable (the template stays plain text).
  app.post('/email-templates/sanitize', manage, async (request) => {
    const { html } = parseBody(TemplateHtmlCheck, request.body);
    const formatted = await sanitizeFormatted(html);
    return { html: formatted?.html ?? null, text: formatted?.text ?? '' };
  });

  app.patch<{ Params: { id: string } }>('/email-templates/:id', manage, async (request, reply) => {
    const { updatedAt, bodyHtml: html, ...rest } = parseBody(EmailTemplateUpdate, request.body);
    const user = request.user!;
    const id = Number(request.params.id);
    // Absent: the HTML stays as it is; null or empty: the template becomes plain text.
    const body = html === undefined ? rest : { ...rest, bodyHtml: await storedHtml(html) };
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const before = Number.isInteger(id) ? await tx.emailTemplate.findUnique({ where: { id }, include }) : null;
        if (!before) throw new NotFoundError();
        if (new Date(updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        const after = await tx.emailTemplate.update({ where: { id, updatedAt: before.updatedAt }, data: body, include });
        await audit(tx, { entityType: 'email_template', entityId: id, action: 'update', userId: user.id, before: auditView(before), after: auditView(after) });
        return after;
      });
      return templateView(updated);
    } catch (e) {
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
    return reply.code(204).send();
  });
};
