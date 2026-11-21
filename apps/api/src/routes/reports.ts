import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.js';

/**
 * The prototype's Reports view (prototype/js/app.js `reports()`): leads by source over every non-archived lead (the
 * prototype counts all leads, not the viewer's), largest first; and enquiry conversion. There is no enquiry table
 * until the contact form (1D), so those counts are 0, as the prototype's formulas give with no enquiries.
 */
export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/reports', { preHandler: [requireUser] }, async () => {
    const groups = await prisma.lead.groupBy({ by: ['leadSource'], where: { archivedAt: null }, _count: { _all: true } });
    const bySource = groups
      .map((g) => ({ source: g.leadSource, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
    return { bySource, enquiries: { received: 0, spamBlocked: 0, leadsCreated: 0, awaitingReview: 0, matchedExisting: 0 } };
  });
};
