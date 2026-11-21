import type { Prisma } from '@prisma/client';
import type { EducationEntry, ExperienceEntry } from '@dait-crm/shared';

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

/**
 * List rows also count the company's leads, limited to the leads the user may see (`leadWhere`), so a
 * Sales Representative's numbers never include other people's leads.
 */
export const companyListInclude = (leadsSeen: Prisma.LeadWhereInput) =>
  ({
    contacts: companySummaryInclude.contacts,
    _count: { select: { contacts: true, leads: { where: leadsSeen } } },
  }) satisfies Prisma.CompanyInclude;

type ListRow = Prisma.CompanyGetPayload<{ include: ReturnType<typeof companyListInclude> }>;

/** A row in the company list: the summary plus the prototype's columns (size, verification, lead count). */
export function companyListRow(c: ListRow) {
  return {
    ...companySummary(c),
    employeeRange: c.employeeRange,
    verificationStatus: c.verificationStatus,
    leadCount: c._count.leads,
  };
}

/** A company summary (list row core). */
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

/** Relations a contact response needs: its company's id, number and name. */
export const contactSummaryInclude = {
  company: { select: { id: true, number: true, name: true } },
} satisfies Prisma.ContactInclude;

type ContactRow = Prisma.ContactGetPayload<{ include: typeof contactSummaryInclude }>;

/** A contact (list row and detail); drops the internal phone/mobile matching keys. */
export function contactSummary(c: ContactRow) {
  return {
    id: c.id,
    companyId: c.companyId,
    company: { id: c.company.id, number: c.company.number, name: c.company.name },
    firstName: c.firstName,
    lastName: c.lastName,
    designation: c.designation,
    department: c.department,
    businessEmail: c.businessEmail,
    phone: c.phone,
    mobile: c.mobile,
    linkedinUrl: c.linkedinUrl,
    contactType: c.contactType,
    isPrimary: c.isPrimary,
    isActive: c.isActive,
    headline: c.headline,
    location: c.location,
    updatedAt: c.updatedAt,
  };
}

const list = <T>(v: Prisma.JsonValue): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** The contact page: the summary plus the whole profile (about, experience, education, skills, languages). */
export function contactProfile(c: ContactRow) {
  return {
    ...contactSummary(c),
    about: c.about,
    experience: list<ExperienceEntry>(c.experience),
    education: list<EducationEntry>(c.education),
    skills: list<string>(c.skills),
    languages: list<string>(c.languages),
  };
}

/** A company location: every column, decimals as numbers. */
export function locationSummary(l: Prisma.CompanyLocationGetPayload<object>) {
  const { lat, lng, ...fields } = l;
  return { ...fields, lat: num(lat), lng: num(lng) };
}
