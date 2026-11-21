import type { Company, Prisma, PrismaClient } from '@prisma/client';
import { can } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { NotFoundError } from '../validate.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Companies the user may see: all of them with `view_all_companies`, otherwise the ones they created.
 * (Release 1C adds companies with a lead assigned to the user.)
 */
export function companyWhere(user: AuthUser): Prisma.CompanyWhereInput {
  return can(user.role, 'view_all_companies') ? {} : { createdById: user.id };
}

/** The company, or NotFoundError (404) when it does not exist or the user may not see it. */
export async function assertCompanyVisible(db: Db, user: AuthUser, id: number): Promise<Company> {
  const company = Number.isInteger(id) ? await db.company.findFirst({ where: { id, ...companyWhere(user) } }) : null;
  if (!company) throw new NotFoundError();
  return company;
}
