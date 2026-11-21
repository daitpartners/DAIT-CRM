import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { NotificationListQuery, pageArgs } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { NotFoundError, parseQuery } from '../validate.js';
import { requireUser } from '../plugins/auth.js';

const unreadCount = (userId: number) => prisma.notification.count({ where: { userId, isRead: false } });

/** The signed-in user's own in-app notifications. Read flags are not audited. */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/notifications', { preHandler: [requireUser] }, async (request) => {
    const query = parseQuery(NotificationListQuery, request.query);
    const userId = request.user!.id;
    const where: Prisma.NotificationWhereInput = { userId, ...(query.unread === '1' ? { isRead: false } : {}) };
    const [total, rows, unread] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(query) }),
      unreadCount(userId),
    ]);
    return {
      items: rows.map((n) => ({ id: n.id, text: n.text, detail: n.detail, link: n.link, isRead: n.isRead, createdAt: n.createdAt })),
      total,
      unread,
    };
  });

  app.get('/notifications/count', { preHandler: [requireUser] }, async (request) => ({ unread: await unreadCount(request.user!.id) }));

  app.post<{ Params: { id: string } }>('/notifications/:id/read', { preHandler: [requireUser] }, async (request) => {
    const userId = request.user!.id;
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) throw new NotFoundError();
    const { count } = await prisma.notification.updateMany({ where: { id, userId }, data: { isRead: true } });
    if (count === 0) throw new NotFoundError();
    return { unread: await unreadCount(userId) };
  });

  app.post('/notifications/read-all', { preHandler: [requireUser] }, async (request) => {
    const userId = request.user!.id;
    await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
    return { unread: 0 };
  });
};
