import type { Prisma, PrismaClient } from '@prisma/client';
import {
  checkDomain, normaliseCompanyName, normalisePhone, rankCompanyMatches, rankContactMatches,
  type CompanyMatches, type ContactDuplicateCheck, type ContactMatches, type DuplicateCheck,
} from '@dait-crm/shared';

type Db = Prisma.TransactionClient | PrismaClient;

const trimmed = (s: string | undefined): string => (s ?? '').trim();

/**
 * Possible duplicates of a company being created or edited. One query over the three keys
 * (domain, legal name, normalised name + country); each key is used only when it is non-empty.
 */
export async function findCompanyMatches(db: Db, input: DuplicateCheck): Promise<CompanyMatches> {
  const domain = checkDomain(input);
  const legalName = trimmed(input.legalName);
  const nameNormalised = normaliseCompanyName(input.name ?? '');
  const country = trimmed(input.country);
  const or: Prisma.CompanyWhereInput[] = [];
  if (domain) or.push({ domain });
  if (legalName) or.push({ legalName: { equals: legalName, mode: 'insensitive' } });
  if (nameNormalised && country) or.push({ nameNormalised, country: { equals: country, mode: 'insensitive' } });
  if (or.length === 0) return { auto: null, review: [] };
  const candidates = await db.company.findMany({
    where: { OR: or, ...(input.excludeId !== undefined ? { id: { not: input.excludeId } } : {}) },
    select: { id: true, number: true, name: true, legalName: true, domain: true, country: true, city: true },
    orderBy: { id: 'asc' },
  });
  return rankCompanyMatches(input, candidates);
}

/**
 * Possible duplicates of a contact. One query over business email, phone/mobile key and
 * first name [+ last name] within the company; each key is used only when it is non-empty.
 */
export async function findContactMatches(db: Db, input: ContactDuplicateCheck): Promise<ContactMatches> {
  const email = trimmed(input.businessEmail);
  const phone = normalisePhone(input.phone);
  const firstName = trimmed(input.firstName);
  const lastName = trimmed(input.lastName);
  const or: Prisma.ContactWhereInput[] = [];
  if (email) or.push({ businessEmail: { equals: email, mode: 'insensitive' } });
  if (phone) or.push({ phoneNormalised: phone }, { mobileNormalised: phone });
  if (firstName && input.companyId !== undefined) {
    or.push({
      companyId: input.companyId,
      firstName: { equals: firstName, mode: 'insensitive' },
      ...(lastName ? { lastName: { equals: lastName, mode: 'insensitive' } } : {}),
    });
  }
  if (or.length === 0) return { auto: null, review: [] };
  const candidates = await db.contact.findMany({
    where: { OR: or, ...(input.excludeId !== undefined ? { id: { not: input.excludeId } } : {}) },
    select: {
      id: true, companyId: true, firstName: true, lastName: true,
      businessEmail: true, phoneNormalised: true, mobileNormalised: true,
    },
    orderBy: { id: 'asc' },
  });
  return rankContactMatches(input, candidates);
}
