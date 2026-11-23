import type { FastifyError, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_ROWS, ImportBatchCreate, ImportBatchUpdate, ImportColumnAnswer,
  ImportIncludeAll, ImportRowUpdate, ImportRowsQuery, OUTREACH_LANGUAGES,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { NotFoundError, parseBody, parseQuery } from '../validate.js';
import { requireRight } from '../plugins/auth.js';
import { ImportError, addFile, createBatch, listFiles, updateBatch } from '../imports/batches.js';
import { answerColumn, includeAll, listRows, rematchBatch, sortBatch, updateRow } from '../imports/stage.js';
import { loadEnrichmentSettings, monthTotals } from '../research/service.js';
import { claudeCodeConfig, claudeCodeReady } from '../research/providers.js';
import { pauseResearch, researchView, resumeResearch, startBatchResearch } from '../imports/research.js';

const idOf = (raw: string) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError();
  return id;
};

const FileQuery = z.object({ name: z.string().trim().min(1).max(255) });
const ResearchQuery = z.object({ page: z.coerce.number().int().min(1).default(1) });

const batchView = (b: { id: number; number: string; status: string; language: string; leadType: string }) =>
  ({ id: b.id, number: b.number, status: b.status, language: b.language, leadType: b.leadType });

async function guard<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ImportError) return reply.code(e.status).send({ error: e.code });
    throw e;
  }
}

/** First names of the given user ids, in the rule's order (unknown ids left out). */
async function firstNames(ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const byId = new Map(users.map((u) => [u.id, u.name.trim().split(/\s+/)[0] ?? '']));
  return ids.map((id) => byId.get(id)).filter((n): n is string => Boolean(n));
}

/**
 * Import leads (steps 1 to 3): options, batches, file uploads, the staged rows (list, edit, tick, column questions,
 * re-matching) and AI research (start, progress, pause, resume). Administrators and Managers (`import_leads`). Changes are refused (409 `batch_locked`) once
 * the batch is Importing or later.
 */
export const importBatchRoutes: FastifyPluginAsync = async (app) => {
  const canImport = { preHandler: [requireRight('import_leads')] };

  // Uploads arrive as raw bytes, one file per request (this plugin only; the rest of the API stays JSON-only).
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: IMPORT_MAX_FILE_BYTES }, (_req, body, done) => {
    done(null, body);
  });
  // Fastify's own "body too large" (413) is the upload's 20 MB limit.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(400).send({ error: 'file_size' });
    throw error;
  });

  /** What step 1 shows: the language allocation rules, whether Claude will help, and the upload limits. */
  app.get('/imports/options', canImport, async () => {
    const claudeConfig = claudeCodeConfig(process.env);
    const [rules, settings, totals, ready] = await Promise.all([
      prisma.allocationRule.findMany({
        where: { isActive: true, matchLanguage: { in: [...OUTREACH_LANGUAGES] } },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
        select: { name: true, matchLanguage: true, assignTo: true },
      }),
      loadEnrichmentSettings(prisma),
      monthTotals(prisma),
      claudeCodeReady(claudeConfig),
    ]);
    const languages = await Promise.all(OUTREACH_LANGUAGES.map(async (value) => ({
      value,
      rules: await Promise.all(rules.filter((r) => r.matchLanguage === value).map(async (r) => {
        const assignTo = r.assignTo as number | number[];
        return { name: r.name, people: await firstNames(Array.isArray(assignTo) ? assignTo : [assignTo]) };
      })),
    })));
    return {
      languages,
      claude: {
        on: settings.claudeEnabled && settings.claudeMonthlyRunCap > 0 && ready,
        runsThisMonth: totals.claudeRuns,
        cap: settings.claudeMonthlyRunCap,
        webSearch: settings.webSearchEnabled,
      },
      limits: { maxFiles: IMPORT_MAX_FILES, maxBytes: IMPORT_MAX_FILE_BYTES, maxRows: IMPORT_MAX_ROWS },
    };
  });

  app.post('/imports/batches', canImport, async (request, reply) => {
    const body = parseBody(ImportBatchCreate, request.body);
    const batch = await createBatch(request.user!, body);
    return reply.code(201).send({ id: batch.id, number: batch.number, status: batch.status });
  });

  app.patch<{ Params: { id: string } }>('/imports/batches/:id', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    const body = parseBody(ImportBatchUpdate, request.body);
    return guard(reply, async () => batchView(await updateBatch(id, body)));
  });

  app.post<{ Params: { id: string } }>(
    '/imports/batches/:id/files',
    { ...canImport, bodyLimit: IMPORT_MAX_FILE_BYTES },
    async (request, reply) => {
      const id = idOf(request.params.id);
      const { name } = parseQuery(FileQuery, request.query);
      const data = request.body === undefined || request.body === null ? Buffer.alloc(0) : request.body;
      if (!Buffer.isBuffer(data)) return reply.code(415).send({ error: 'unsupported_media_type' });
      return guard(reply, async () => {
        const file = await addFile(request.user!, id, name, data);
        return reply.code(201).send({ id: file.id, name: file.name, ext: file.ext, size: file.size, status: file.status });
      });
    },
  );

  app.get<{ Params: { id: string } }>('/imports/batches/:id/files', canImport, async (request) => {
    return { items: await listFiles(idOf(request.params.id)) };
  });

  /** Step 1 → step 2 (Uploading → Sorting): every file read, at least one row staged. */
  app.post<{ Params: { id: string } }>('/imports/batches/:id/sort', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    return guard(reply, async () => batchView(await sortBatch(id)));
  });

  app.get<{ Params: { id: string } }>('/imports/batches/:id/rows', canImport, async (request) => {
    return listRows(idOf(request.params.id), parseQuery(ImportRowsQuery, request.query));
  });

  app.patch<{ Params: { id: string } }>('/imports/rows/:id', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    const body = parseBody(ImportRowUpdate, request.body);
    return guard(reply, () => updateRow(id, body));
  });

  app.post<{ Params: { id: string } }>('/imports/batches/:id/include', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    const body = parseBody(ImportIncludeAll, request.body);
    return guard(reply, () => includeAll(id, body));
  });

  app.post<{ Params: { id: string } }>('/imports/files/:id/columns', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    const body = parseBody(ImportColumnAnswer, request.body);
    return guard(reply, () => answerColumn(id, body));
  });

  /** Country and company matching again for the whole batch (e.g. after "Add these countries"). */
  app.post<{ Params: { id: string } }>('/imports/batches/:id/rematch', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    return guard(reply, async () => ({ tiles: await rematchBatch(id) }));
  });

  /** Step 3: research the ticked rows with missing details, one at a time on the research lane. */
  app.post<{ Params: { id: string } }>('/imports/batches/:id/research', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    return guard(reply, () => startBatchResearch(id));
  });

  app.post<{ Params: { id: string } }>('/imports/batches/:id/research/pause', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    return guard(reply, () => pauseResearch(id));
  });

  app.post<{ Params: { id: string } }>('/imports/batches/:id/research/resume', canImport, async (request, reply) => {
    const id = idOf(request.params.id);
    return guard(reply, () => resumeResearch(id));
  });

  app.get<{ Params: { id: string } }>('/imports/batches/:id/research', canImport, async (request) => {
    const id = idOf(request.params.id);
    const { page } = parseQuery(ResearchQuery, request.query);
    return researchView(id, page);
  });
};
