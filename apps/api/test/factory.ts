import type { FastifyInstance } from 'fastify';
import type { Company, Contact, Lead, Prisma, User } from '@prisma/client';
import { domainOf, isFreeMail, normaliseCompanyName, normalisePhone, type RoleEnum } from '@dait-crm/shared';
import { prisma } from '../src/db';

let n = 0;

export async function makeUser(
  overrides: Partial<{ email: string; name: string; role: RoleEnum; isActive: boolean; language: string }> = {},
): Promise<User> {
  n += 1;
  return prisma.user.create({
    data: {
      email: (overrides.email ?? `user${n}@daitpartners.com`).toLowerCase(),
      name: overrides.name ?? `User ${n}`,
      role: overrides.role ?? 'SALES_REPRESENTATIVE',
      isActive: overrides.isActive ?? true,
      language: overrides.language ?? 'en',
    },
  });
}

export async function makeCompany(
  overrides: Partial<{
    name: string; legalName: string | null; website: string | null; businessEmail: string | null;
    country: string; city: string | null; createdById: number | null;
  }> = {},
): Promise<Company> {
  n += 1;
  const name = overrides.name ?? `Company ${n}`;
  const website = overrides.website ?? null;
  const businessEmail = overrides.businessEmail ?? null;
  const emailDomain = domainOf(businessEmail);
  return prisma.company.create({
    data: {
      name,
      nameNormalised: normaliseCompanyName(name),
      legalName: overrides.legalName ?? null,
      website,
      businessEmail,
      domain: domainOf(website) ?? (emailDomain && !isFreeMail(emailDomain) ? emailDomain : null),
      country: overrides.country ?? 'India',
      city: overrides.city ?? null,
      createdById: overrides.createdById ?? null,
    },
  });
}

export async function makeContact(
  overrides: Partial<{
    companyId: number; firstName: string; lastName: string; businessEmail: string | null;
    phone: string | null; mobile: string | null;
  }> = {},
): Promise<Contact> {
  n += 1;
  const companyId = overrides.companyId ?? (await makeCompany()).id;
  const phone = overrides.phone ?? null;
  const mobile = overrides.mobile ?? null;
  return prisma.contact.create({
    data: {
      companyId,
      firstName: overrides.firstName ?? `First${n}`,
      lastName: overrides.lastName ?? `Last${n}`,
      businessEmail: overrides.businessEmail ?? null,
      phone,
      phoneNormalised: normalisePhone(phone) || null,
      mobile,
      mobileNormalised: normalisePhone(mobile) || null,
    },
  });
}

/** A lead (no activities, assignments or tasks); a company is created unless `companyId` is given (null = none). */
export async function makeLead(overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}): Promise<Lead> {
  n += 1;
  const companyId = overrides.companyId !== undefined ? overrides.companyId : (await makeCompany()).id;
  return prisma.lead.create({
    data: {
      companyName: `Lead Co ${n}`,
      country: 'India',
      leadSource: 'Manual Entry',
      ...overrides,
      companyId,
    },
  });
}

/** Signs in through the test-login route and returns the `Cookie` header value. */
export async function signIn(app: FastifyInstance, user: Pick<User, 'email'>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test-login', payload: { email: user.email } });
  if (res.statusCode !== 204) throw new Error(`test-login failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'crm_session');
  if (!c) throw new Error('test-login set no crm_session cookie');
  return `crm_session=${c.value}`;
}
