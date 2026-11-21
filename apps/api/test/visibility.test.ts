import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { roleLabel } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { visibleCompanyIds } from '../src/companies/visibility';
import type { AuthUser } from '../src/plugins/auth';
import { resetDb } from './helpers';
import { makeCompany, makeUser } from './factory';

beforeEach(async () => {
  await resetDb();
});

const authUser = (u: User): AuthUser => ({
  id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat,
});

describe('visibleCompanyIds', () => {
  it('visibleCompanyIds returns only visible ids', async () => {
    const rep = await makeUser({ role: 'SALES_REPRESENTATIVE' });
    const admin = await makeUser({ role: 'ADMINISTRATOR' });
    const own = await makeCompany({ createdById: rep.id });
    const other = await makeCompany({ createdById: admin.id });
    const ids = [own.id, other.id];

    expect(await visibleCompanyIds(prisma, authUser(rep), ids)).toEqual(new Set([own.id]));
    expect(await visibleCompanyIds(prisma, authUser(admin), ids)).toEqual(new Set(ids));
    expect(await visibleCompanyIds(prisma, authUser(rep), [])).toEqual(new Set());
  });
});
