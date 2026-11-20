import type { FastifyPluginAsync } from 'fastify';
import { ACTIONS, can } from '@dait-crm/shared';
import { requireUser } from '../plugins/auth.js';

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    return { ...user, rights: ACTIONS.filter((a) => can(user.role, a)) };
  });
};
