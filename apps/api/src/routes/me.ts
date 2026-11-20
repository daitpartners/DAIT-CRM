import type { FastifyPluginAsync } from 'fastify';
import { ACTIONS, PreferencesUpdate, can, roleLabel } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { parseBody } from '../validate.js';
import { requireUser, type AuthUser } from '../plugins/auth.js';

const withRights = (user: AuthUser) => ({ ...user, rights: ACTIONS.filter((a) => can(user.role, a)) });

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: [requireUser] }, async (request) => withRights(request.user!));

  app.patch('/me/preferences', { preHandler: [requireUser] }, async (request) => {
    const prefs = parseBody(PreferencesUpdate, request.body);
    const me = request.user!;
    const before = { language: me.language, timezone: me.timezone, dateFormat: me.dateFormat };
    const row = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: me.id }, data: prefs });
      await audit(tx, { entityType: 'user', entityId: me.id, action: 'update', userId: me.id, before, after: prefs });
      return updated;
    });
    return withRights({
      id: row.id, email: row.email, name: row.name, role: roleLabel(row.role),
      language: row.language, timezone: row.timezone, dateFormat: row.dateFormat,
    });
  });
};
