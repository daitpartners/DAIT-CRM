import { z } from 'zod';
import { PagingQuery } from './paging.js';
import { optionalEmail, optionalText, optionalTimezone, optionalUrl, blankToNull } from './common.js';

const stringList = z.array(z.string().trim().min(1).max(100)).max(50).default([]);

export const CompanyStatus = z.enum(['Active', 'Inactive', 'Closed']);
export type CompanyStatus = z.infer<typeof CompanyStatus>;

export const CompanyCreate = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: optionalText(200),
  website: optionalUrl(),
  businessEmail: optionalEmail(),
  industry: optionalText(100),
  businessCategory: optionalText(100),
  businessType: optionalText(60),
  yearEstablished: z.number().int().min(1800)
    .refine((y) => y <= new Date().getFullYear(), { message: 'Year cannot be in the future' })
    .nullish(),
  description: optionalText(5000),
  linkedinUrl: optionalUrl(),
  status: CompanyStatus.default('Active'),
  country: z.string().trim().min(1).max(80),
  state: optionalText(100),
  city: optionalText(100),
  street: optionalText(255),
  zip: optionalText(20),
  timezone: optionalTimezone,
  employeeCount: z.number().int().min(0).nullish(),
  employeeRange: optionalText(20),
  annualRevenue: z.number().min(0).nullish(),
  revenueCurrency: z.preprocess(blankToNull, z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).nullish()),
  revenueRange: optionalText(20),
  ownershipType: optionalText(60),
  registrationNumber: optionalText(60),
  stockExchange: optionalText(60),
  stockSymbol: optionalText(20),
  mainProducts: optionalText(5000),
  mainServices: optionalText(5000),
  businessVerticals: stringList,
  targetMarkets: stringList,
  geographicMarkets: stringList,
  keyBrands: optionalText(255),
  specialisation: optionalText(5000),
  socialFacebook: optionalUrl(),
  socialInstagram: optionalUrl(),
  socialX: optionalUrl(),
  socialYoutube: optionalUrl(),
  socialOther: optionalUrl(),
});
export type CompanyCreate = z.infer<typeof CompanyCreate>;

/** `isClient` is editable only by roles with `view_all_leads` (the route refuses it for others). */
export const CompanyUpdate = CompanyCreate.partial().extend({ isClient: z.boolean().optional(), updatedAt: z.string().datetime() });
export type CompanyUpdate = z.infer<typeof CompanyUpdate>;

export const DuplicateCheck = z.object({
  name: z.string().optional(),
  website: z.string().optional(),
  businessEmail: z.string().optional(),
  legalName: z.string().optional(),
  country: z.string().optional(),
  excludeId: z.number().int().optional(),
});
export type DuplicateCheck = z.infer<typeof DuplicateCheck>;

/** Columns `GET /companies` may sort by; anything else is a 400. */
export const COMPANY_SORTS = ['name', 'country', 'industry', 'status', 'updatedAt'] as const;

/** `GET /companies` query: paging plus list filters. Query values arrive as strings. */
export const CompanyListQuery = PagingQuery.extend({
  sort: z.enum(COMPANY_SORTS).optional(),
  status: CompanyStatus.optional(),
  country: z.string().trim().max(80).optional(),
  industry: z.string().trim().max(100).optional(),
  isClient: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type CompanyListQuery = z.infer<typeof CompanyListQuery>;

export const CompanyBulkStatus = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  status: CompanyStatus,
});
export type CompanyBulkStatus = z.infer<typeof CompanyBulkStatus>;
