import type { Prisma } from '@prisma/client';

/** Relations every company response needs: the primary contact and the contact count. */
export const companySummaryInclude = {
  contacts: {
    where: { isPrimary: true },
    take: 1,
    select: { id: true, firstName: true, lastName: true, businessEmail: true },
  },
  _count: { select: { contacts: true } },
} satisfies Prisma.CompanyInclude;

export const companyDetailInclude = {
  ...companySummaryInclude,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.CompanyInclude;

type SummaryRow = Prisma.CompanyGetPayload<{ include: typeof companySummaryInclude }>;
type DetailRow = Prisma.CompanyGetPayload<{ include: typeof companyDetailInclude }>;

const num = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());

function primaryContact(c: SummaryRow) {
  const p = c.contacts[0];
  return p ? { id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), businessEmail: p.businessEmail } : null;
}

/** A row in the company list. */
export function companySummary(c: SummaryRow) {
  return {
    id: c.id,
    number: c.number,
    name: c.name,
    domain: c.domain,
    industry: c.industry,
    country: c.country,
    city: c.city,
    status: c.status,
    isClient: c.isClient,
    primaryContact: primaryContact(c),
    contactCount: c._count.contacts,
    updatedAt: c.updatedAt,
  };
}

/**
 * The full company: every column (decimals as numbers) except the internal `nameNormalised`
 * matching key, plus the summary's primary contact and count, and who created it.
 */
export function companyDetail(c: DetailRow) {
  const { contacts: _contacts, _count, nameNormalised: _key, createdBy, lat, lng, annualRevenue, ...fields } = c;
  return {
    ...fields,
    lat: num(lat),
    lng: num(lng),
    annualRevenue: num(annualRevenue),
    primaryContact: primaryContact(c),
    contactCount: _count.contacts,
    createdBy: createdBy ? { id: createdBy.id, name: createdBy.name } : null,
  };
}
