import type { PrismaClient } from '@prisma/client';
import { roleEnum, type Role } from '@dait-crm/shared';

type Translated = Record<string, { es: string; fr: string }>;

interface Group {
  group: string;
  values: string[];
  translations?: Translated;
}

// Values copied exactly from prototype/js/data.js `config`.
export const LOOKUP_GROUPS: Group[] = [
  {
    group: 'lead_source',
    values: ['Website Contact Form', 'Google Places API', 'Company Website', 'Business Directory', 'CSV Import', 'Manual Entry', 'Referral', 'LinkedIn', 'Other'],
  },
  {
    group: 'lead_status',
    values: ['New', 'Not Contacted', 'Contacted', 'Interested', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost', 'Not Relevant'],
    translations: {
      New: { es: 'Nuevo', fr: 'Nouveau' },
      'Not Contacted': { es: 'No contactado', fr: 'Non contacté' },
      Contacted: { es: 'Contactado', fr: 'Contacté' },
      Interested: { es: 'Interesado', fr: 'Intéressé' },
      Qualified: { es: 'Cualificado', fr: 'Qualifié' },
      'Proposal Sent': { es: 'Propuesta enviada', fr: 'Proposition envoyée' },
      Negotiation: { es: 'Negociación', fr: 'Négociation' },
      Won: { es: 'Ganado', fr: 'Gagné' },
      Lost: { es: 'Perdido', fr: 'Perdu' },
      'Not Relevant': { es: 'No relevante', fr: 'Non pertinent' },
    },
  },
  {
    group: 'lead_type',
    values: ['Lead', 'Prospect'],
    translations: {
      Lead: { es: 'Lead', fr: 'Lead' },
      Prospect: { es: 'Prospecto', fr: 'Prospect' },
    },
  },
  {
    group: 'priority',
    values: ['High', 'Medium', 'Low'],
    translations: {
      High: { es: 'Alta', fr: 'Haute' },
      Medium: { es: 'Media', fr: 'Moyenne' },
      Low: { es: 'Baja', fr: 'Basse' },
    },
  },
  {
    group: 'country',
    values: ['India', 'United Kingdom', 'United Arab Emirates', 'Australia', 'Germany', 'Spain', 'Canada', 'Italy', 'Nigeria', 'United States', 'Singapore'],
  },
  {
    group: 'industry',
    values: ['Logistics & Supply Chain', 'Healthcare', 'Manufacturing', 'Wholesale & Distribution', 'Financial Services', 'Pharmaceuticals', 'Hospitality', 'Retail', 'Energy & Utilities', 'Construction', 'Food & Beverage', 'Technology', 'Professional Services'],
  },
  {
    group: 'business_category',
    values: ['3PL / Contract logistics', 'Dental clinic group', 'Textile manufacturer', 'Marine wholesaler', 'Fintech', 'Generic pharma', 'Boutique hotels', 'Fashion retail', 'Utility', 'Engineering consultancy', 'Food producer'],
  },
  {
    group: 'business_type',
    values: ['Private limited company', 'Public limited company', 'Partnership', 'Sole proprietorship', 'Non-profit', 'Government'],
  },
  {
    group: 'employee_range',
    values: ['1–10', '11–50', '51–200', '201–500', '501–1,000', '1,001–5,000', '5,000+'],
  },
  {
    group: 'revenue_range',
    values: ['< 1m', '1–10m', '10–50m', '50–250m', '250m–1bn', '> 1bn'],
  },
  {
    group: 'ownership_type',
    values: ['Privately held', 'Publicly listed', 'Family owned', 'Private equity backed', 'State owned'],
  },
  {
    group: 'contact_type',
    values: ['Decision Maker', 'Influencer', 'Other'],
    translations: {
      'Decision Maker': { es: 'Decisor', fr: 'Décideur' },
      Influencer: { es: 'Influyente', fr: 'Influenceur' },
      Other: { es: 'Otro', fr: 'Autre' },
    },
  },
  {
    group: 'location_type',
    values: ['Headquarters', 'Branch', 'Warehouse', 'Registered office', 'Factory'],
  },
  {
    group: 'quote_status',
    values: ['Draft', 'Sent', 'Negotiating', 'Accepted', 'Rejected', 'Expired'],
  },
  {
    group: 'currency',
    values: ['GBP', 'EUR', 'USD', 'INR', 'AUD'],
  },
];

export async function seedLookups(prisma: PrismaClient): Promise<void> {
  for (const { group, values, translations } of LOOKUP_GROUPS) {
    for (const [sortOrder, value] of values.entries()) {
      const tr = translations?.[value];
      const data = { label: value, labelEs: tr?.es ?? null, labelFr: tr?.fr ?? null, sortOrder };
      await prisma.lookupValue.upsert({
        where: { group_value: { group, value } },
        update: data,
        create: { group, value, ...data },
      });
    }
  }
}

// The four users from prototype/js/data.js; seeded only when SEED_SAMPLE_USERS=1.
const SAMPLE_USERS: { name: string; role: Role; email: string }[] = [
  { name: 'Arjun Mehta', role: 'Sales Representative', email: 'arjun.mehta@daitpartners.com' },
  { name: 'Neha Kapoor', role: 'Manager', email: 'neha.kapoor@daitpartners.com' },
  { name: 'Rohan Das', role: 'Data Research User', email: 'rohan.das@daitpartners.com' },
  { name: 'Maya Pillai', role: 'Administrator', email: 'maya.pillai@daitpartners.com' },
];

export async function seedSampleUsers(prisma: PrismaClient): Promise<void> {
  for (const u of SAMPLE_USERS) {
    const email = u.email.toLowerCase();
    await prisma.user.upsert({
      where: { email },
      update: { name: u.name, role: roleEnum(u.role) },
      create: { email, name: u.name, role: roleEnum(u.role) },
    });
  }
}
