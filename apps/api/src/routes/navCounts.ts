import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.js';
import { leadWhere } from '../leads/visibility.js';
import { dateOnly, todayIn } from '../leads/dates.js';
import { taskWhere } from './tasks.js';

/**
 * Sidebar badges (prototype app.js sidebar(), Store.counts): visible non-archived leads, the user's own open tasks
 * due before today in their time zone, and their unread notifications.
 */
export const navCountRoutes: FastifyPluginAsync = async (app) => {
  app.get('/nav-counts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const day = dateOnly(todayIn(user.timezone));
    const [leads, overdueTasks, unread, mailUnread] = await Promise.all([
      prisma.lead.count({ where: leadWhere(user) }),
      prisma.task.count({ where: { AND: [taskWhere(user), { assignedToId: user.id, isDone: false, dueDate: { lt: day } }] } }),
      prisma.notification.count({ where: { userId: user.id, isRead: false } }),
      // Release 2B-2: the user's own unread inbox (prototype Email badge).
      prisma.emailMessage.count({ where: { userId: user.id, folder: 'inbox', isRead: false } }),
    ]);
    return { leads, overdueTasks, unread, mailUnread };
  });
};
