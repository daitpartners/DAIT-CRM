import type { Prisma, PrismaClient } from '@prisma/client';
import { checkDomain, normaliseCompanyName, normalisePhone } from '@dait-crm/shared';

// Sample data copied from prototype/js/data.js (companies, contacts, locations). The prototype's
// verified/aiMeta/ai/createdBy/importBatch fields are not seeded.

type SampleCompany = Omit<
  Prisma.CompanyUncheckedCreateInput,
  'nameNormalised' | 'domain' | 'createdById' | 'businessVerticals' | 'targetMarkets' | 'geographicMarkets' | 'createdAt'
> & {
  number: string;
  businessVerticals: string[];
  targetMarkets: string[];
  geographicMarkets: string[];
  createdAt: string;
};

const blank = {
  legalName: null, website: null, industry: null, businessCategory: null, businessType: null, yearEstablished: null,
  description: null, linkedinUrl: null, status: 'Active', isClient: false, state: null, city: null, street: null, zip: null,
  timezone: null, lat: null, lng: null, mapsUrl: null, employeeCount: null, employeeRange: null, annualRevenue: null,
  revenueCurrency: null, revenueRange: null, ownershipType: null, registrationNumber: null, stockExchange: null,
  stockSymbol: null, mainProducts: null, mainServices: null, businessVerticals: [], targetMarkets: [], geographicMarkets: [],
  keyBrands: null, specialisation: null, socialFacebook: null, socialInstagram: null, socialX: null, socialYoutube: null,
  socialOther: null,
} satisfies Partial<SampleCompany>;

export const SAMPLE_COMPANIES: SampleCompany[] = [
  {
    ...blank, number: 'CO-0318', name: 'Northwind Logistics', legalName: 'Northwind Logistics Private Limited',
    website: 'https://northwindlogistics.in', industry: 'Logistics & Supply Chain', businessCategory: '3PL / Contract logistics',
    businessType: 'Private limited company',
    description: 'Third-party logistics provider operating temperature-controlled and dry warehousing across western India, with last-mile distribution for FMCG and pharma clients.',
    linkedinUrl: 'https://linkedin.com/company/northwind-logistics',
    country: 'India', state: 'Maharashtra', city: 'Pune', street: 'Plot 14, Chakan Industrial Area, Phase II', zip: '410501',
    timezone: 'Asia/Kolkata', lat: 18.7557, lng: 73.846, mapsUrl: 'https://maps.google.com/?cid=1',
    employeeRange: '201–500', revenueCurrency: 'INR', ownershipType: 'Privately held', registrationNumber: 'U63090PN2009PTC134211',
    mainServices: 'Contract warehousing, cold chain storage, last-mile distribution, freight forwarding',
    businessVerticals: ['FMCG', 'Pharma', 'E-commerce'], targetMarkets: ['Enterprise', 'Mid-market'],
    geographicMarkets: ['Maharashtra', 'Gujarat', 'Karnataka'], keyBrands: 'NorthCold, NorthMile',
    socialFacebook: 'https://facebook.com/northwindlogistics', socialYoutube: 'https://youtube.com/@northwindlogistics',
    createdAt: '2026-03-03',
  },
  {
    ...blank, number: 'CO-0211', name: 'Sunrise Pharma', legalName: 'Sunrise Pharma Ltd', website: 'https://sunrisepharma.in',
    industry: 'Pharmaceuticals', businessCategory: 'Generic pharma', businessType: 'Public limited company', yearEstablished: 1998,
    description: 'Generic pharmaceutical manufacturer with plants in Hyderabad and Visakhapatnam.',
    country: 'India', state: 'Telangana', city: 'Hyderabad', timezone: 'Asia/Kolkata',
    employeeCount: 2400, employeeRange: '1,001–5,000', revenueCurrency: 'INR', revenueRange: '250m–1bn',
    ownershipType: 'Publicly listed', stockExchange: 'NSE', stockSymbol: 'SUNPH', mainProducts: 'Generic formulations, APIs',
    businessVerticals: ['Pharma'], targetMarkets: ['Enterprise'], geographicMarkets: ['India', 'Africa'],
    createdAt: '2026-10-12',
  },
  {
    ...blank, number: 'CO-0245', name: 'Meridian Textiles', legalName: 'Meridian Textiles Ltd', website: 'https://meridiantextiles.co.uk',
    industry: 'Manufacturing', businessCategory: 'Textile manufacturer', businessType: 'Private limited company', yearEstablished: 1984,
    description: 'Technical textile manufacturer supplying automotive and medical sectors.',
    country: 'United Kingdom', state: 'Greater Manchester', city: 'Manchester', timezone: 'Europe/London',
    employeeCount: 640, employeeRange: '501–1,000', revenueCurrency: 'GBP', revenueRange: '50–250m', ownershipType: 'Family owned',
    registrationNumber: '01823344', mainProducts: 'Technical fabrics',
    businessVerticals: ['Automotive', 'Medical'], targetMarkets: ['Enterprise'], geographicMarkets: ['UK', 'EU'],
    createdAt: '2026-11-14',
  },
  {
    ...blank, number: 'CO-0301', name: 'Bluefin Marine Supplies', legalName: 'Bluefin Marine Supplies Pty Ltd',
    website: 'https://bluefinmarine.com.au', industry: 'Wholesale & Distribution', businessCategory: 'Marine wholesaler',
    businessType: 'Private limited company', country: 'Australia', state: 'Western Australia', city: 'Fremantle',
    timezone: 'Australia/Perth', employeeRange: '11–50', revenueCurrency: 'AUD',
    createdAt: '2026-11-02',
  },
  {
    ...blank, number: 'CO-0310', name: 'Orbit Fintech', legalName: 'Orbit Fintech GmbH', website: 'https://orbitfintech.de',
    industry: 'Financial Services', businessCategory: 'Fintech', businessType: 'Private limited company', yearEstablished: 2017,
    description: 'Payments platform for SME lending.', isClient: true,
    country: 'Germany', state: 'Berlin', city: 'Berlin', timezone: 'Europe/Berlin',
    employeeCount: 120, employeeRange: '51–200', revenueCurrency: 'EUR', revenueRange: '10–50m', ownershipType: 'Private equity backed',
    registrationNumber: 'HRB 198877', mainProducts: 'Lending platform',
    businessVerticals: ['Banking'], targetMarkets: ['SME'], geographicMarkets: ['DACH'],
    createdAt: '2026-10-28',
  },
  {
    // revenueCurrency 'AED' is not in the currency lookup; kept as in the prototype.
    ...blank, number: 'CO-0320', name: 'Helix Dental Group', website: 'https://helixdental.ae', industry: 'Healthcare',
    businessCategory: 'Dental clinic group', country: 'United Arab Emirates', state: 'Dubai', city: 'Dubai', timezone: 'Asia/Dubai',
    lat: 25.2048, lng: 55.2708, mapsUrl: 'https://maps.google.com/?cid=2', employeeRange: '51–200', revenueCurrency: 'AED',
    createdAt: '2026-11-17',
  },
  {
    ...blank, number: 'CO-0322', name: 'Kestrel Engineering', country: 'Canada', state: 'Alberta', city: 'Calgary',
    createdAt: '2026-10-10',
  },
  {
    ...blank, number: 'CO-0290', name: 'Casa Verde Hospitality', legalName: 'Casa Verde Hospitality SL', website: 'https://casaverde.es',
    industry: 'Hospitality', businessCategory: 'Boutique hotels', status: 'Inactive',
    country: 'Spain', state: 'Valencia', city: 'Valencia', timezone: 'Europe/Madrid', employeeRange: '11–50', revenueCurrency: 'EUR',
    createdAt: '2026-10-30',
  },
  {
    ...blank, number: 'CO-0280', name: 'Zenith Retail', legalName: 'Zenith Retail LLC', website: 'https://zenithretail.com',
    industry: 'Retail', businessCategory: 'Fashion retail', yearEstablished: 2011,
    country: 'United States', state: 'New York', city: 'New York', timezone: 'America/New_York',
    employeeCount: 300, employeeRange: '201–500', revenueCurrency: 'USD',
    createdAt: '2026-11-11',
  },
  {
    ...blank, number: 'CO-0315', name: 'Meyer Bauhaus', legalName: 'Meyer Bauhaus GmbH', website: 'https://meyerbauhaus.de',
    industry: 'Construction', country: 'Germany', state: 'Berlin', city: 'Berlin', timezone: 'Europe/Berlin', revenueCurrency: 'EUR',
    createdAt: '2026-11-17',
  },
  {
    ...blank, number: 'CO-0316', name: 'Bellini Foods', legalName: 'Bellini Foods SpA', website: 'https://bellinifoods.it',
    industry: 'Food & Beverage', businessCategory: 'Food producer',
    country: 'Italy', state: 'Lombardy', city: 'Milan', timezone: 'Europe/Rome', revenueCurrency: 'EUR',
    createdAt: '2026-11-12',
  },
];

interface SampleContact {
  company: string;
  firstName: string;
  lastName: string;
  designation: string | null;
  department: string | null;
  businessEmail: string;
  phone: string | null;
  mobile: string | null;
  linkedinUrl: string | null;
  contactType: string;
  isPrimary: boolean;
}

export const SAMPLE_CONTACTS: SampleContact[] = [
  { company: 'CO-0318', firstName: 'Priya', lastName: 'Raman', designation: 'Head of Operations', department: 'Operations', businessEmail: 'priya.raman@northwindlogistics.in', phone: '+91 20 6710 2200', mobile: '+91 98220 41178', linkedinUrl: 'https://linkedin.com/in/priyaraman', contactType: 'Decision Maker', isPrimary: true },
  { company: 'CO-0318', firstName: 'Sameer', lastName: 'Kulkarni', designation: 'IT Manager', department: 'Technology', businessEmail: 's.kulkarni@northwindlogistics.in', phone: '+91 20 6710 2214', mobile: null, linkedinUrl: null, contactType: 'Influencer', isPrimary: false },
  { company: 'CO-0245', firstName: 'Sarah', lastName: 'Okafor', designation: 'Operations Director', department: 'Operations', businessEmail: 's.okafor@meridiantextiles.co.uk', phone: '+44 161 555 0193', mobile: null, linkedinUrl: null, contactType: 'Decision Maker', isPrimary: true },
  { company: 'CO-0301', firstName: 'Tom', lastName: 'Delaney', designation: 'Managing Director', department: 'Management', businessEmail: 'tom@bluefinmarine.com.au', phone: '+61 8 9335 2200', mobile: null, linkedinUrl: null, contactType: 'Decision Maker', isPrimary: true },
  { company: 'CO-0310', firstName: 'Lena', lastName: 'Fischer', designation: 'COO', department: 'Operations', businessEmail: 'lena.fischer@orbitfintech.de', phone: '+49 30 1234 500', mobile: null, linkedinUrl: null, contactType: 'Decision Maker', isPrimary: true },
  { company: 'CO-0211', firstName: 'Anil', lastName: 'Verma', designation: 'CEO', department: 'Management', businessEmail: 'anil.verma@sunrisepharma.in', phone: '+91 40 2345 6789', mobile: null, linkedinUrl: null, contactType: 'Decision Maker', isPrimary: true },
  { company: 'CO-0211', firstName: 'Meera', lastName: 'Iyer', designation: 'Procurement Lead', department: 'Procurement', businessEmail: 'meera.iyer@sunrisepharma.in', phone: null, mobile: null, linkedinUrl: null, contactType: 'Influencer', isPrimary: false },
  { company: 'CO-0280', firstName: 'Aisha', lastName: 'Rahman', designation: 'Head of Analytics', department: 'Data', businessEmail: 'aisha.r@zenithretail.com', phone: null, mobile: null, linkedinUrl: null, contactType: 'Influencer', isPrimary: true },
  { company: 'CO-0315', firstName: 'Hannah', lastName: 'Meyer', designation: 'Owner', department: null, businessEmail: 'hannah@meyerbauhaus.de', phone: '+49 30 221 0098', mobile: null, linkedinUrl: null, contactType: 'Decision Maker', isPrimary: true },
  { company: 'CO-0316', firstName: 'Marco', lastName: 'Bellini', designation: 'Export Manager', department: 'Sales', businessEmail: 'marco@bellinifoods.it', phone: '+39 02 4455 110', mobile: null, linkedinUrl: null, contactType: 'Decision Maker', isPrimary: true },
];

type SampleLocation = Omit<Prisma.CompanyLocationUncheckedCreateInput, 'companyId'> & { company: string; name: string };

export const SAMPLE_LOCATIONS: SampleLocation[] = [
  { company: 'CO-0318', name: 'Headquarters', locationType: 'Headquarters', country: 'India', state: 'Maharashtra', city: 'Pune', street: 'Plot 14, Chakan Industrial Area, Phase II', zip: '410501', timezone: 'Asia/Kolkata', lat: 18.7557, lng: 73.846, mapsUrl: 'https://maps.google.com/?cid=1', phone: '+91 20 6710 2200', isVerified: true, source: 'Manual' },
  { company: 'CO-0318', name: 'Bhiwandi warehouse', locationType: 'Warehouse', country: 'India', state: 'Maharashtra', city: 'Bhiwandi', street: 'Gala 7–9, Mankoli Logistics Park, Thane', zip: '421302', timezone: 'Asia/Kolkata', lat: 19.2813, lng: 73.0483, mapsUrl: 'https://maps.google.com/?cid=3', phone: null, isVerified: false, source: 'Google Places · 18 Nov' },
  { company: 'CO-0211', name: 'Hyderabad plant', locationType: 'Factory', country: 'India', state: 'Telangana', city: 'Hyderabad', street: null, zip: null, timezone: 'Asia/Kolkata', lat: null, lng: null, mapsUrl: null, phone: null, isVerified: true, source: 'Manual' },
  { company: 'CO-0211', name: 'Vizag plant', locationType: 'Factory', country: 'India', state: 'Andhra Pradesh', city: 'Visakhapatnam', street: null, zip: null, timezone: 'Asia/Kolkata', lat: null, lng: null, mapsUrl: null, phone: null, isVerified: true, source: 'Manual' },
];

const phoneKey = (p: string | null): string | null => normalisePhone(p) || null;

/**
 * Idempotent: companies upserted by number, contacts by (company, businessEmail), locations by
 * (company, name). Needs the sample users (createdBy is Maya Pillai). Leaves company_number_seq past
 * the highest seeded number so new companies do not collide with CO-0322.
 */
export async function seedSampleCompanies(prisma: PrismaClient): Promise<void> {
  const maya = await prisma.user.findUniqueOrThrow({ where: { email: 'maya.pillai@daitpartners.com' } });
  const ids = new Map<string, number>();

  for (const { createdAt, ...c } of SAMPLE_COMPANIES) {
    const data = {
      ...c,
      nameNormalised: normaliseCompanyName(c.name),
      domain: checkDomain({ website: c.website ?? undefined }),
      createdById: maya.id,
    };
    const row = await prisma.company.upsert({
      where: { number: c.number },
      create: { ...data, createdAt: new Date(createdAt) },
      update: data,
    });
    ids.set(c.number, row.id);
  }

  for (const { company, ...ct } of SAMPLE_CONTACTS) {
    const companyId = ids.get(company)!;
    const data = { ...ct, companyId, phoneNormalised: phoneKey(ct.phone), mobileNormalised: phoneKey(ct.mobile) };
    const existing = await prisma.contact.findFirst({ where: { companyId, businessEmail: ct.businessEmail } });
    if (existing) await prisma.contact.update({ where: { id: existing.id }, data });
    else await prisma.contact.create({ data });
  }

  for (const { company, ...loc } of SAMPLE_LOCATIONS) {
    const companyId = ids.get(company)!;
    const data = { ...loc, companyId };
    const existing = await prisma.companyLocation.findFirst({ where: { companyId, name: loc.name } });
    if (existing) await prisma.companyLocation.update({ where: { id: existing.id }, data });
    else await prisma.companyLocation.create({ data });
  }

  await prisma.$executeRawUnsafe(
    `SELECT setval('company_number_seq', GREATEST(322, (SELECT max(substring(number from 4)::int) FROM companies)))`,
  );
}
