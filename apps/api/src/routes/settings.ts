import type { FastifyPluginAsync } from 'fastify';
import { CompanySettingsUpdate, EnrichmentSettingsUpdate } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { parseBody } from '../validate.js';
import { requireRight } from '../plugins/auth.js';
import { loadCompanySettings } from '../quotations/service.js';
import { loadEnrichmentSettings, monthTotals } from '../research/service.js';
import { claudeBinaryFound, claudeCodeConfig } from '../research/providers.js';

/**
 * The enrichment engine card: the settings plus whether the Claude Code token and an executable binary and the Places
 * key are present on the server (never the token or key itself), and this month's Claude runs and Places calls.
 */
async function enrichmentView(db: Parameters<typeof loadEnrichmentSettings>[0]) {
  const claude = claudeCodeConfig(process.env);
  const [settings, totals, binaryFound] = await Promise.all([loadEnrichmentSettings(db), monthTotals(db), claudeBinaryFound(claude.bin)]);
  return {
    ...settings,
    claudeTokenPresent: Boolean(claude.token),
    claudeBinaryFound: binaryFound,
    placesKeyPresent: Boolean(process.env.GOOGLE_PLACES_API_KEY),
    claudeRunsThisMonth: totals.claudeRuns,
    placesCallsThisMonth: totals.placesCalls,
  };
}

/** Settings → Company details (release 3A) and the enrichment engine (release 4); Administrators only. */
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

  /** Enrichment engine (release 4, Administrators): daily run limit, Claude on / cap, web search, Places on / call cap. */
  app.get('/settings/enrichment', { preHandler: [requireRight('manage_users')] }, async () => enrichmentView(prisma));

  app.put('/settings/enrichment', { preHandler: [requireRight('manage_users')] }, async (request) => {
    const body = parseBody(EnrichmentSettingsUpdate, request.body);
    return prisma.$transaction(async (tx) => {
      const before = await loadEnrichmentSettings(tx);
      await tx.enrichmentSettings.upsert({ where: { id: 1 }, create: { id: 1, ...body }, update: body });
      const after = await loadEnrichmentSettings(tx);
      await audit(tx, { entityType: 'enrichment_settings', entityId: 1, action: 'update', userId: request.user!.id, before, after });
      return enrichmentView(tx);
    });
  });
};
