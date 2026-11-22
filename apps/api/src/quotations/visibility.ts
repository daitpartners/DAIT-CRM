import type { Prisma } from '@prisma/client';
import { can } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { companyWhere } from '../companies/visibility.js';
import { leadWhere } from '../leads/visibility.js';

/**
 * Quotations the user may see: those on a lead they can see (archived leads included, so a quotation does not vanish
 * when its lead is archived) and, without a lead, those on a company they can see.
 */
export function quotationWhere(user: AuthUser): Prisma.QuotationWhereInput {
  if (can(user.role, 'view_all_leads') && can(user.role, 'view_all_companies')) return {};
  return {
    OR: [
      { leadId: { not: null }, lead: { is: leadWhere(user, { includeArchived: true }) } },
      { leadId: null, company: { is: companyWhere(user) } },
    ],
  };
}

/**
 * Who may create, edit, send and change the status of a visible quotation: users with `manage_quotes` who own it,
 * are its lead's assignee, or have `view_all_leads`.
 */
export function canEditQuotation(
  user: AuthUser, q: { ownerId: number; lead: { assignedToId: number | null } | null },
): boolean {
  if (!can(user.role, 'manage_quotes')) return false;
  return q.ownerId === user.id || (q.lead !== null && q.lead.assignedToId === user.id) || can(user.role, 'view_all_leads');
}
