import type { FastifyPluginAsync } from 'fastify';
import { Prisma, type LookupValue } from '@prisma/client';
import { LookupValueCreate, LookupValuePatch, LookupOrder, LOOKUP_GROUPS } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { parseBody } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const byOrder = [{ sortOrder: 'asc' as const }, { id: 'asc' as const }];

export const lookupRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { group?: string; all?: string } }>('/lookups', { preHandler: [requireUser] }, async (request) => {
    const { group, all } = request.query;
    if (group) {
      const items = await prisma.lookupValue.findMany({
        where: { group, ...(all === '1' ? {} : { isActive: true }) },
        orderBy: byOrder,
      });
      return { items };
    }
    const rows = await prisma.lookupValue.findMany({ where: { isActive: true }, orderBy: byOrder });
    const groups: Record<string, LookupValue[]> = Object.fromEntries(LOOKUP_GROUPS.map((g) => [g, []]));
    for (const r of rows) (groups[r.group] ??= []).push(r);
    return { groups };
  });

  app.post('/lookups', { preHandler: [requireRight('manage_lookups')] }, async (request, reply) => {
    const body = parseBody(LookupValueCreate, request.body);
    try {
      const created = await prisma.$transaction(async (tx) => {
        let sortOrder = body.sortOrder;
        if (sortOrder === undefined) {
          const max = await tx.lookupValue.aggregate({ where: { group: body.group }, _max: { sortOrder: true } });
          sortOrder = (max._max.sortOrder ?? -1) + 1;
        }
        const row = await tx.lookupValue.create({ data: { ...body, sortOrder } });
        await audit(tx, { entityType: 'lookup_value', entityId: row.id, action: 'create', userId: request.user!.id, after: row });
        return row;
      });
      return reply.code(201).send(created);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'duplicate_value' });
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>('/lookups/:id', { preHandler: [requireRight('manage_lookups')] }, async (request, reply) => {
    const body = parseBody(LookupValuePatch, request.body);
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.lookupValue.findUnique({ where: { id } });
      if (!before) return null;
      const after = await tx.lookupValue.update({ where: { id }, data: body });
      await audit(tx, { entityType: 'lookup_value', entityId: id, action: 'update', userId: request.user!.id, before, after });
      return after;
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return updated;
  });

  app.put<{ Params: { group: string } }>('/lookups/:group/order', { preHandler: [requireRight('manage_lookups')] }, async (request, reply) => {
    const { ids } = parseBody(LookupOrder, request.body);
    const { group } = request.params;
    const ok = await prisma.$transaction(async (tx) => {
      // Lock the group's rows so concurrent reorders serialize.
      await tx.$queryRaw`SELECT id FROM lookup_values WHERE "group" = ${group} FOR UPDATE`;
      const rows = await tx.lookupValue.findMany({ where: { group }, orderBy: byOrder });
      const members = new Set(rows.map((r) => r.id));
      if (new Set(ids).size !== ids.length || ids.some((i) => !members.has(i))) return false;
      const listed = new Set(ids);
      const finalOrder = [...ids, ...rows.map((r) => r.id).filter((i) => !listed.has(i))];
      for (const [sortOrder, id] of finalOrder.entries()) {
        await tx.lookupValue.update({ where: { id }, data: { sortOrder } });
      }
      await audit(tx, { entityType: 'lookup_value', entityId: group, action: 'update', userId: request.user!.id, before: rows.map((r) => r.id), after: finalOrder });
      return true;
    });
    if (!ok) return reply.code(400).send({ error: 'invalid_ids' });
    return reply.code(204).send();
  });
};
