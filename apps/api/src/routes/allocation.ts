import type { FastifyPluginAsync } from 'fastify';
import type { AllocationRule } from '@prisma/client';
import { AllocationRuleCreate, AllocationRuleUpdate } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { parseBody } from '../validate.js';
import { requireRight } from '../plugins/auth.js';

function view(r: AllocationRule) {
  return {
    id: r.id,
    name: r.name,
    matchCountries: r.matchCountries as string[],
    assignTo: r.assignTo as number | number[],
    priority: r.priority,
    isActive: r.isActive,
    roundRobinPos: r.roundRobinPos,
  };
}

const ids = (assignTo: number | number[]) => (Array.isArray(assignTo) ? assignTo : [assignTo]);

async function allActive(userIds: number[]): Promise<boolean> {
  const unique = [...new Set(userIds)];
  return (await prisma.user.count({ where: { id: { in: unique }, isActive: true } })) === unique.length;
}

export const allocationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/allocation-rules', { preHandler: [requireRight('view_admin_settings')] }, async () => {
    const rules = await prisma.allocationRule.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
    return { items: rules.map(view) };
  });

  app.post('/allocation-rules', { preHandler: [requireRight('manage_allocation')] }, async (request, reply) => {
    const body = parseBody(AllocationRuleCreate, request.body);
    if (!(await allActive(ids(body.assignTo)))) return reply.code(400).send({ error: 'unknown_user' });
    const created = await prisma.$transaction(async (tx) => {
      const rule = await tx.allocationRule.create({ data: body });
      await audit(tx, { entityType: 'allocation_rule', entityId: rule.id, action: 'create', userId: request.user!.id, after: rule });
      return rule;
    });
    return reply.code(201).send(view(created));
  });

  app.patch<{ Params: { id: string } }>('/allocation-rules/:id', { preHandler: [requireRight('manage_allocation')] }, async (request, reply) => {
    const body = parseBody(AllocationRuleUpdate, request.body);
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    if (body.assignTo !== undefined && !(await allActive(ids(body.assignTo)))) return reply.code(400).send({ error: 'unknown_user' });
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.allocationRule.findUnique({ where: { id } });
      if (!before) return null;
      const after = await tx.allocationRule.update({ where: { id }, data: body });
      await audit(tx, { entityType: 'allocation_rule', entityId: id, action: 'update', userId: request.user!.id, before, after });
      return after;
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return view(updated);
  });

  app.delete<{ Params: { id: string } }>('/allocation-rules/:id', { preHandler: [requireRight('manage_allocation')] }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const found = await prisma.$transaction(async (tx) => {
      const before = await tx.allocationRule.findUnique({ where: { id } });
      if (!before) return false;
      await tx.allocationRule.delete({ where: { id } });
      await audit(tx, { entityType: 'allocation_rule', entityId: id, action: 'delete', userId: request.user!.id, before });
      return true;
    });
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
};
