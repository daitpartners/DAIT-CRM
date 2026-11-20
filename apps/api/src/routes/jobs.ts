import type { FastifyPluginAsync } from 'fastify';
import type { Job, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { requireRight } from '../plugins/auth.js';
import { JOB_STATUSES, JOB_TYPES, type JobStatus, type JobType } from '../jobs/types.js';

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
      if (status !== undefined && !JOB_STATUSES.includes(status as JobStatus)) {
        return reply.code(400).send({ error: 'validation', issues: [{ path: ['status'], message: 'Unknown status' }] });
      }
      if (type !== undefined && !JOB_TYPES.includes(type as JobType)) {
        return reply.code(400).send({ error: 'validation', issues: [{ path: ['type'], message: 'Unknown type' }] });
      }
      const where: Prisma.JobWhereInput = { ...(status ? { status } : {}), ...(type ? { type } : {}) };
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
      const job = await prisma.job.findUnique({ where: { id } });
      if (!job) return reply.code(404).send({ error: 'not_found' });
      if (job.status === 'running') return reply.code(409).send({ error: 'job_running' });
      const updated = await prisma.$transaction(async (tx) => {
        const after = await tx.job.update({
          where: { id },
          data: { status: 'queued', attempts: 0, runAt: new Date(), lockedAt: null },
        });
        await audit(tx, {
          entityType: 'job',
          entityId: id,
          action: 'update',
          userId: request.user!.id,
          before: { status: job.status, attempts: job.attempts },
          after: { status: after.status, attempts: after.attempts },
        });
        return after;
      });
      return view(updated);
    },
  );
};
