import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';
import { requireUser } from '../plugins/auth.js';
import { leadWhere } from '../leads/visibility.js';
import { dateOnly, todayIn } from '../leads/dates.js';
import { taskWhere } from './tasks.js';
import { projectWhere } from '../projects/visibility.js';

/**
 * Sidebar badges (prototype app.js sidebar(), Store.counts): visible non-archived leads, the user's own open tasks
 * due before today in their time zone, and their unread notifications.
 */
export const navCountRoutes: FastifyPluginAsync = async (app) => {
  app.get('/nav-counts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const day = dateOnly(todayIn(user.timezone));
    const [leads, overdueTasks, unread, mailUnread, mailerLive, projects] = await Promise.all([
      prisma.lead.count({ where: leadWhere(user) }),
      prisma.task.count({ where: { AND: [taskWhere(user), { assignedToId: user.id, isDone: false, dueDate: { lt: day } }] } }),
      prisma.notification.count({ where: { userId: user.id, isRead: false } }),
      // Release 2B-2: the user's own unread inbox (prototype Email badge).
      prisma.emailMessage.count({ where: { userId: user.id, folder: 'inbox', isRead: false } }),
      // Release 2C: the user's own campaigns sending or scheduled (prototype "n live").
      prisma.emailCampaign.count({ where: { senderId: user.id, status: { in: ['Sending', 'Scheduled'] } } }),
      // Release 3B: the projects the user can see (prototype Projects badge).
      prisma.project.count({ where: projectWhere(user) }),
    ]);
    return { leads, overdueTasks, unread, mailUnread, mailerLive, projects };
  });
};
