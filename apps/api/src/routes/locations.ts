import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import { LocationCreate, LocationUpdate } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { NotFoundError, parseBody } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import { locationSummary } from '../companies/serialize.js';
import { assertLookupValue } from '../companies/lookups.js';

const isNotFound = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';

class StaleError extends Error {}

type Params = { id: string };
type LocParams = { id: string; locId: string };

/** Headquarters first, then by name. */
const byTypeThenName = (a: { locationType: string; name: string }, b: { locationType: string; name: string }) =>
  Number(b.locationType === 'Headquarters') - Number(a.locationType === 'Headquarters') || a.name.localeCompare(b.name);

export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: Params }>('/companies/:id/locations', { preHandler: [requireUser] }, async (request) => {
    const company = await assertCompanyVisible(prisma, request.user!, Number(request.params.id));
    const rows = await prisma.companyLocation.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } });
    return { items: rows.sort(byTypeThenName).map(locationSummary) };
  });

  app.post<{ Params: Params }>('/companies/:id/locations', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const body = parseBody(LocationCreate, request.body);
    const user = request.user!;
    const created = await prisma.$transaction(async (tx) => {
      const company = await assertCompanyVisible(tx, user, Number(request.params.id));
      await assertLookupValue(tx, 'location_type', body.locationType, 'locationType');
      const row = await tx.companyLocation.create({ data: { ...body, companyId: company.id } });
      await audit(tx, { entityType: 'location', entityId: row.id, action: 'create', userId: user.id, after: row });
      return row;
    });
    return reply.code(201).send(locationSummary(created));
  });

  app.patch<{ Params: LocParams }>('/companies/:id/locations/:locId', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const { updatedAt, ...body } = parseBody(LocationUpdate, request.body);
    const user = request.user!;
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const company = await assertCompanyVisible(tx, user, Number(request.params.id));
        const locId = Number(request.params.locId);
        const before = Number.isInteger(locId)
          ? await tx.companyLocation.findFirst({ where: { id: locId, companyId: company.id } })
          : null;
        if (!before) throw new NotFoundError();
        if (new Date(updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
        if (body.locationType !== undefined) await assertLookupValue(tx, 'location_type', body.locationType, 'locationType');
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        const after = await tx.companyLocation.update({ where: { id: locId, updatedAt: before.updatedAt }, data: body });
        await audit(tx, { entityType: 'location', entityId: locId, action: 'update', userId: user.id, before, after });
        return after;
      });
      return locationSummary(updated);
    } catch (e) {
      if (e instanceof StaleError || isNotFound(e)) return reply.code(409).send({ error: 'stale' });
      throw e;
    }
  });

  // Locations are the one hard delete: they are addresses, not history. The audit row keeps `before`.
  app.delete<{ Params: LocParams }>('/companies/:id/locations/:locId', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const user = request.user!;
    await prisma.$transaction(async (tx) => {
      const company = await assertCompanyVisible(tx, user, Number(request.params.id));
      const locId = Number(request.params.locId);
      const before = Number.isInteger(locId)
        ? await tx.companyLocation.findFirst({ where: { id: locId, companyId: company.id } })
        : null;
      if (!before) throw new NotFoundError();
      await tx.companyLocation.delete({ where: { id: locId } });
      await audit(tx, { entityType: 'location', entityId: locId, action: 'delete', userId: user.id, before });
    });
    return reply.code(204).send();
  });
};
