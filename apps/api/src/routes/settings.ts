import type { FastifyPluginAsync } from 'fastify';
import { CompanySettingsUpdate } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { parseBody } from '../validate.js';
import { requireRight } from '../plugins/auth.js';
import { loadCompanySettings } from '../quotations/service.js';

/** Settings → Company details (release 3A, Administrators): the issuer on every quotation and the defaults for new ones. */
export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/settings/company', { preHandler: [requireRight('manage_users')] }, async () => loadCompanySettings(prisma));

  /** Saves row 1, creating it when missing. */
  app.put('/settings/company', { preHandler: [requireRight('manage_users')] }, async (request) => {
    const body = parseBody(CompanySettingsUpdate, request.body);
    const data = { ...body, gstin: body.gstin ?? null };
    return prisma.$transaction(async (tx) => {
      const before = await loadCompanySettings(tx);
      await tx.companySettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
      const after = await loadCompanySettings(tx);
      await audit(tx, { entityType: 'company_settings', entityId: 1, action: 'update', userId: request.user!.id, before, after });
      return after;
    });
  });
};
