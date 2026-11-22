import type { Prisma } from '@prisma/client';
import { can } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { companyWhere } from '../companies/visibility.js';
import { leadWhere } from '../leads/visibility.js';

/**
 * Projects the user may see: those on a lead they can see (archived leads included), without a lead those on a
 * company they can see (the quotation rule), and always those they manage (builder's call: the manager sees their
 * projects whatever the lead visibility; it widens nothing else on the lead).
 */
export function projectWhere(user: AuthUser): Prisma.ProjectWhereInput {
  if (can(user.role, 'view_all_leads') && can(user.role, 'view_all_companies')) return {};
  return {
    OR: [
      { leadId: { not: null }, lead: { is: leadWhere(user, { includeArchived: true }) } },
      { leadId: null, company: { is: companyWhere(user) } },
      { managerId: user.id },
    ],
  };
}

type ProjectRights = { managerId: number; lead: { assignedToId: number | null } | null };

/**
 * Who may edit a visible project: `manage_quotes` users who manage it, are its lead's assignee, or have
 * `view_all_leads`. Without a lead: the manager or `view_all_leads`.
 */
export function canEditProject(user: AuthUser, p: ProjectRights): boolean {
  if (!can(user.role, 'manage_quotes')) return false;
  return p.managerId === user.id || (p.lead !== null && p.lead.assignedToId === user.id) || can(user.role, 'view_all_leads');
}

/**
 * Who may create a project (the caller has already checked the lead, or without one the company, is visible): with a
 * lead, `manage_quotes` users who are its assignee, the new project's manager, or have `view_all_leads`; without a
 * lead any `manage_quotes` user.
 */
export function canCreateProject(user: AuthUser, p: ProjectRights): boolean {
  if (!can(user.role, 'manage_quotes')) return false;
  return p.lead === null || canEditProject(user, p);
}
