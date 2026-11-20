import type { FastifyPluginAsync } from 'fastify';
import { Prisma, type User } from '@prisma/client';
import { UserCreate, UserUpdate, roleEnum, roleLabel } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { parseBody } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';

function summary(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: roleLabel(u.role),
    language: u.language,
    timezone: u.timezone,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
  };
}

class RuleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/users', { preHandler: [requireUser] }, async () => {
    const users = await prisma.user.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return { items: users.map(summary) };
  });

  app.post('/users', { preHandler: [requireRight('manage_users')] }, async (request, reply) => {
    const body = parseBody(UserCreate, request.body);
    try {
      const created = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { ...body, role: roleEnum(body.role) },
        });
        await audit(tx, { entityType: 'user', entityId: user.id, action: 'create', userId: request.user!.id, after: user });
        return user;
      });
      return reply.code(201).send(summary(created));
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'email_taken' });
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>('/users/:id', { preHandler: [requireRight('manage_users')] }, async (request, reply) => {
    const body = parseBody(UserUpdate, request.body);
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const actorId = request.user!.id;
    if (body.isActive === false && id === actorId) return reply.code(400).send({ error: 'cannot_deactivate_self' });
    const { role, ...rest } = body;
    const data: Prisma.UserUpdateInput = { ...rest, ...(role ? { role: roleEnum(role) } : {}) };

    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Lock the active administrators so concurrent demotions serialize.
        const admins = await tx.$queryRaw<{ id: number }[]>`
          SELECT id FROM users WHERE role = 'ADMINISTRATOR' AND is_active = true FOR UPDATE`;
        const before = await tx.user.findUnique({ where: { id } });
        if (!before) return null;
        const losesAdmin =
          before.role === 'ADMINISTRATOR' && before.isActive &&
          ((data.role !== undefined && data.role !== 'ADMINISTRATOR') || body.isActive === false);
        if (losesAdmin && admins.every((a) => a.id === id)) throw new RuleError('last_administrator');
        const after = await tx.user.update({ where: { id }, data });
        await audit(tx, { entityType: 'user', entityId: id, action: 'update', userId: actorId, before, after });
        return after;
      });
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return summary(updated);
    } catch (e) {
      if (e instanceof RuleError) return reply.code(400).send({ error: e.code });
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'email_taken' });
      throw e;
    }
  });
};
