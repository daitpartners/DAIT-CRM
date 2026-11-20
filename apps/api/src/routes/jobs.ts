import type { FastifyPluginAsync } from 'fastify';
import type { Job, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight } from '../plugins/auth.js';
import { JOB_STATUSES, JOB_TYPES, type JobStatus, type JobType } from '../jobs/types.js';
import { staleRunningWhere } from '../jobs/queue.js';

/** `stale` = running but locked for over 15 minutes (interrupted mid-send). */
const LIST_STATUSES: readonly string[] = [...JOB_STATUSES, 'stale'];

const LIST_LIMIT = 200;

/** Recipients and subject only: message bodies never leave the queue through the API. */
function payloadSummary(job: Job): { to: string[]; subject: string } | Record<string, never> {
  const p = job.payload as { to?: unknown; subject?: unknown } | null;
  if (job.type !== 'send_email' || !p || typeof p !== 'object') return {};
  return {
    to: Array.isArray(p.to) ? p.to.filter((x): x is string => typeof x === 'string') : [],
    subject: typeof p.subject === 'string' ? p.subject : '',
  };
}

function view(job: Job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    runAt: job.runAt,
    createdAt: job.createdAt,
    payloadSummary: payloadSummary(job),
  };
}

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { status?: string; type?: string } }>(
    '/jobs',
    { preHandler: [requireRight('view_admin_settings')] },
    async (request, reply) => {
      const { status, type } = request.query;
      if (status !== undefined && !LIST_STATUSES.includes(status)) {
        return reply.code(400).send({ error: 'validation', issues: [{ path: ['status'], message: 'Unknown status' }] });
      }
      if (type !== undefined && !JOB_TYPES.includes(type as JobType)) {
        return reply.code(400).send({ error: 'validation', issues: [{ path: ['type'], message: 'Unknown type' }] });
      }
      const where: Prisma.JobWhereInput = {
        ...(status === 'stale' ? staleRunningWhere() : status ? { status: status as JobStatus } : {}),
        ...(type ? { type } : {}),
      };
      const jobs = await prisma.job.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: LIST_LIMIT });
      return { items: jobs.map(view) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/jobs/:id/retry',
    { preHandler: [requireRight('manage_users')] },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
      const result = await prisma.$transaction(async (tx) => {
        const before = await tx.job.findUnique({ where: { id } });
        if (!before) return 'not_found' as const;
        // Single conditional UPDATE: only failed or interrupted jobs, so a concurrent worker claim
        // (which needs status='queued') or a live send can never be duplicated.
        const { count } = await tx.job.updateMany({
          where: { id, OR: [{ status: 'failed' }, staleRunningWhere()] },
          data: { status: 'queued', attempts: 0, runAt: new Date(), lockedAt: null },
        });
        if (count === 0) return 'not_retryable' as const;
        const after = await tx.job.findUniqueOrThrow({ where: { id } });
        await audit(tx, {
          entityType: 'job',
          entityId: id,
          action: 'update',
          userId: request.user!.id,
          before: { status: before.status, attempts: before.attempts },
          after: { status: after.status, attempts: after.attempts },
        });
        return after;
      });
      if (result === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (result === 'not_retryable') return reply.code(409).send({ error: 'job_not_retryable' });
      const updated = result;
      return view(updated);
    },
  );
};
