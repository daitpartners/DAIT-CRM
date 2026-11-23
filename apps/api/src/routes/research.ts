import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { EnrichmentRun, EnrichmentSuggestion, SourceRecord } from '@prisma/client';
import { ManualSourceCreate, can } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { parseBody } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import {
  ResearchError, acceptAllHigh, addManualSource, currentValue, decideSuggestion, isLocked, markProfileVerified, startResearch,
} from '../research/service.js';

/** History rows shown on the AI Intelligence tab. */
const RUNS_SHOWN = 50;

const runRow = (r: EnrichmentRun) => ({
  id: r.id, createdAt: r.createdAt, trigger: r.trigger, engine: r.engine, sources: r.sources, result: r.result,
  appliedCount: r.appliedCount, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
});

const sourceRow = (s: SourceRecord) => ({
  id: s.id, title: s.title, url: s.url, sourceType: s.sourceType, collectedAt: s.collectedAt, collectedBy: s.collectedBy,
  fieldsPopulated: s.fieldsPopulated, confidence: s.confidence, snapshot: s.snapshot,
});

async function refused(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ResearchError) return reply.code(e.status).send({ error: e.code });
    throw e;
  }
}

/** AI research (release 4): see = users who see the company; run / decide / add source / verify = company edit rights. */
export const researchRoutes: FastifyPluginAsync = async (app) => {
  const edit = { preHandler: [requireRight('manage_companies')] };

  app.get<{ Params: { id: string } }>('/companies/:id/research', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const company = await assertCompanyVisible(prisma, user, Number(request.params.id));
    const [pending, runs] = await Promise.all([
      prisma.enrichmentSuggestion.findMany({ where: { companyId: company.id, decision: 'pending' }, orderBy: [{ confidence: 'desc' }, { id: 'asc' }] }),
      prisma.enrichmentRun.findMany({ where: { companyId: company.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: RUNS_SHOWN }),
    ]);
    return {
      company: {
        aiSummary: company.aiSummary, aiIndustry: company.aiIndustry, aiBusinessCategory: company.aiBusinessCategory,
        aiPotentialServices: company.aiPotentialServices, aiOpportunityScore: company.aiOpportunityScore, aiConfidence: company.aiConfidence,
        aiResearchStatus: company.aiResearchStatus, aiLastResearchAt: company.aiLastResearchAt,
        verificationStatus: company.verificationStatus, verifiedFields: company.verifiedFields,
      },
      pending: pending.map((s: EnrichmentSuggestion) => ({
        id: s.id, runId: s.runId, field: s.field, label: s.label, value: s.value, display: s.display, confidence: s.confidence,
        sourceUrl: s.sourceUrl, sourceLabel: s.sourceLabel, currentValue: currentValue(company, s.field), locked: isLocked(company, s.field),
      })),
      runs: runs.map(runRow),
      canEdit: can(user.role, 'manage_companies'),
    };
  });

  app.post<{ Params: { id: string } }>('/companies/:id/research', edit, async (request, reply) => {
    const user = request.user!;
    const company = await assertCompanyVisible(prisma, user, Number(request.params.id));
    return refused(reply, async () => {
      const runId = await startResearch({ companyId: company.id, trigger: `Manual · ${user.name}`, userId: user.id });
      return reply.code(202).send({ runId });
    });
  });

  for (const action of ['accept', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(`/research/suggestions/:id/${action}`, edit, async (request, reply) =>
      refused(reply, () => decideSuggestion(request.user!, Number(request.params.id), action === 'accept')));
  }

  app.post<{ Params: { id: string } }>('/companies/:id/research/accept-high', edit, async (request, reply) =>
    refused(reply, () => acceptAllHigh(request.user!, Number(request.params.id))));

  app.post<{ Params: { id: string } }>('/companies/:id/verify-profile', edit, async (request, reply) =>
    refused(reply, async () => {
      await markProfileVerified(request.user!, Number(request.params.id));
      return { ok: true };
    }));

  app.get<{ Params: { id: string } }>('/companies/:id/sources', { preHandler: [requireUser] }, async (request) => {
    const company = await assertCompanyVisible(prisma, request.user!, Number(request.params.id));
    const rows = await prisma.sourceRecord.findMany({ where: { companyId: company.id }, orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }] });
    return { items: rows.map(sourceRow) };
  });

  app.post<{ Params: { id: string } }>('/companies/:id/sources', edit, async (request, reply) => {
    const body = parseBody(ManualSourceCreate, request.body);
    return refused(reply, async () => reply.code(201).send(sourceRow(await addManualSource(request.user!, Number(request.params.id), body))));
  });
};
