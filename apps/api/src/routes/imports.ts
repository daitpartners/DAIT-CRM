import type { FastifyPluginAsync } from 'fastify';
import { CsvImport, CsvPreview } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { parseBody } from '../validate.js';
import { requireRight } from '../plugins/auth.js';
import { importCsvLeads, parseCsv, sampleRows, suggestMapping } from '../leads/csv.js';
import { assertAssignable, guard } from './leads.js';

/** CSV bodies arrive as JSON `{ csv }`; 5 MB instead of Fastify's 1 MB default. */
const bodyLimit = 5 * 1024 * 1024;

export const importRoutes: FastifyPluginAsync = async (app) => {
  app.post('/imports/leads/preview', { bodyLimit, preHandler: [requireRight('manage_leads')] }, async (request) => {
    const { csv } = parseBody(CsvPreview, request.body);
    const parsed = parseCsv(csv);
    return {
      headers: parsed.headers,
      sample: sampleRows(parsed),
      rowCount: parsed.rows.length,
      suggestedMapping: suggestMapping(parsed.headers),
    };
  });

  app.post('/imports/leads', { bodyLimit, preHandler: [requireRight('manage_leads')] }, async (request, reply) => {
    const body = parseBody(CsvImport, request.body);
    const user = request.user!;
    return guard(reply, async () => {
      if (body.assignedToId != null) await assertAssignable(prisma, user, body.assignedToId);
      return importCsvLeads(prisma, user, body, (e, row) => request.log.error({ err: e, row }, 'csv import row failed'));
    });
  });
};
