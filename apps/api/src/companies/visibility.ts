import type { Company, Prisma, PrismaClient } from '@prisma/client';
import { can } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { NotFoundError } from '../validate.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Companies the user may see: all of them with `view_all_companies`, otherwise the ones they
 * created and the ones with a lead assigned to them. Returns `{}` or a single `OR`, so callers may
 * spread it into a where that has no `OR` of its own.
 */
export function companyWhere(user: AuthUser): Prisma.CompanyWhereInput {
  return can(user.role, 'view_all_companies')
    ? {}
    : { OR: [{ createdById: user.id }, { leads: { some: { assignedToId: user.id } } }] };
}

/** The company, or NotFoundError (404) when it does not exist or the user may not see it. */
export async function assertCompanyVisible(db: Db, user: AuthUser, id: number): Promise<Company> {
  const company = Number.isInteger(id) ? await db.company.findFirst({ where: { id, ...companyWhere(user) } }) : null;
  if (!company) throw new NotFoundError();
  return company;
}

/** Of `ids`, the companies the user may see (no query when the user sees every company or `ids` is empty). */
export async function visibleCompanyIds(db: Db, user: AuthUser, ids: number[]): Promise<Set<number>> {
  const where = companyWhere(user);
  if (Object.keys(where).length === 0 || ids.length === 0) return new Set(ids);
  const rows = await db.company.findMany({ where: { id: { in: ids }, ...where }, select: { id: true } });
  return new Set(rows.map((c) => c.id));
}
