import type { Lead, Prisma, PrismaClient } from '@prisma/client';
import { can, roleLabel } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { NotFoundError } from '../validate.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Leads the user may see. Administrator / Manager (`view_all_leads`): all. Data Research User:
 * prospects and leads assigned to them. Everyone else (Sales Representative): their own and
 * unassigned leads. Archived leads are excluded unless `includeArchived`.
 */
export function leadWhere(user: AuthUser, opts: { includeArchived?: boolean } = {}): Prisma.LeadWhereInput {
  const archived: Prisma.LeadWhereInput = opts.includeArchived ? {} : { archivedAt: null };
  if (can(user.role, 'view_all_leads')) return archived;
  const own: Prisma.LeadWhereInput = user.role === 'Data Research User'
    ? { OR: [{ leadType: 'Prospect' }, { assignedToId: user.id }] }
    : { OR: [{ assignedToId: user.id }, { assignedToId: null }] };
  return { ...archived, ...own };
}

/** The lead, or NotFoundError (404) when it does not exist or the user may not see it. */
export async function assertLeadVisible(
  db: Db, user: AuthUser, id: number, opts: { includeArchived?: boolean } = {},
): Promise<Lead> {
  const lead = Number.isInteger(id) ? await db.lead.findFirst({ where: { AND: [{ id }, leadWhere(user, opts)] } }) : null;
  if (!lead) throw new NotFoundError();
  return lead;
}

/** Whether the user may see the lead (archived leads included). */
export async function canSeeLead(db: Db, user: AuthUser, leadId: number): Promise<boolean> {
  if (!Number.isInteger(leadId)) return false;
  return (await db.lead.count({ where: { AND: [{ id: leadId }, leadWhere(user, { includeArchived: true })] } })) > 0;
}

/**
 * Whether user `userId` (another user, e.g. a task's new assignee) may see the lead. False for an
 * unknown or inactive user.
 */
export async function canUserSeeLead(db: Db, userId: number, leadId: number): Promise<boolean> {
  const u = await db.user.findFirst({ where: { id: userId, isActive: true } });
  if (!u) return false;
  const asUser: AuthUser = {
    id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone,
    dateFormat: u.dateFormat,
  };
  return canSeeLead(db, asUser, leadId);
}
