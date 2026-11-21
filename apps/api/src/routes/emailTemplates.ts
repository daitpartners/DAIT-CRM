import type { FastifyPluginAsync } from 'fastify';
import type { EmailTemplate } from '@prisma/client';
import { EmailTemplateInput, EmailTemplateUpdate } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { isNotFound, StaleError } from '../prismaErrors.js';
import { NotFoundError, parseBody } from '../validate.js';

type WithCreator = EmailTemplate & { createdBy: { id: number; name: string } | null };
const include = { createdBy: { select: { id: true, name: true } } } as const;

function templateView(t: WithCreator) {
  return {
    id: t.id, name: t.name, language: t.language, subject: t.subject, body: t.body, sourceType: t.sourceType,
    fileName: t.fileName, fileSize: t.fileSize, createdBy: t.createdBy, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
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

  app.post('/email-templates', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(EmailTemplateInput, request.body);
    const user = request.user!;
    const created = await prisma.$transaction(async (tx) => {
      const t = await tx.emailTemplate.create({
        data: { ...body, fileName: body.fileName ?? null, fileSize: body.fileSize ?? null, createdById: user.id }, include,
      });
      await audit(tx, { entityType: 'email_template', entityId: t.id, action: 'create', userId: user.id, after: templateView(t) });
      return t;
    });
    return reply.code(201).send(templateView(created));
  });

  app.patch<{ Params: { id: string } }>('/email-templates/:id', { preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const { updatedAt, ...body } = parseBody(EmailTemplateUpdate, request.body);
    const user = request.user!;
    const id = Number(request.params.id);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const before = Number.isInteger(id) ? await tx.emailTemplate.findUnique({ where: { id }, include }) : null;
        if (!before) throw new NotFoundError();
        if (new Date(updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        const after = await tx.emailTemplate.update({ where: { id, updatedAt: before.updatedAt }, data: body, include });
        await audit(tx, { entityType: 'email_template', entityId: id, action: 'update', userId: user.id, before: templateView(before), after: templateView(after) });
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
      await audit(tx, { entityType: 'email_template', entityId: id, action: 'delete', userId: user.id, before: templateView(before) });
    });
    return reply.code(204).send();
  });
};
