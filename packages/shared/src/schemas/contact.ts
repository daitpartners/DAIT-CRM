import { z } from 'zod';
import { optionalEmail, optionalText, optionalUrl } from './common.js';
import { PagingQuery } from './paging.js';

export const ContactCreate = z.object({
  companyId: z.number().int(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  designation: optionalText(100),
  department: optionalText(100),
  businessEmail: optionalEmail(),
  phone: optionalText(40),
  mobile: optionalText(40),
  linkedinUrl: optionalUrl(),
  contactType: z.string().trim().min(1).max(60).default('Other'),
  isPrimary: z.boolean().default(false),
});
export type ContactCreate = z.infer<typeof ContactCreate>;

const text = (max: number) => z.string().trim().min(1).max(max);
/** A period end-point as typed: a year, `YYYY-MM` or a date (≤ 10 chars). */
const period = z.string().trim().min(1).max(10);

export const ExperienceEntry = z.object({
  title: text(120),
  company: text(120),
  from: period,
  /** null = present. */
  to: period.nullable(),
  description: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(1000).nullable()),
});
export type ExperienceEntry = z.infer<typeof ExperienceEntry>;

export const EducationEntry = z.object({
  school: text(120),
  degree: text(120),
  from: period,
  to: period,
});
export type EducationEntry = z.infer<typeof EducationEntry>;

/** The contact's profile (LinkedIn-style); every field optional so PATCH can send any subset. */
export const ContactProfile = z.object({
  headline: optionalText(200),
  location: optionalText(200),
  about: optionalText(5000),
  experience: z.array(ExperienceEntry).max(20),
  education: z.array(EducationEntry).max(10),
  skills: z.array(text(60)).max(40),
  languages: z.array(text(60)).max(20),
}).partial();
export type ContactProfile = z.infer<typeof ContactProfile>;

export const ContactUpdate = ContactCreate.omit({ companyId: true }).partial()
  .merge(ContactProfile)
  .extend({ isActive: z.boolean().optional(), updatedAt: z.string().datetime() });
export type ContactUpdate = z.infer<typeof ContactUpdate>;

/** `POST /contacts/:id/move`: move the contact to another company. */
export const ContactMove = z.object({
  companyId: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});
export type ContactMove = z.infer<typeof ContactMove>;

export const ContactDuplicateCheck = z.object({
  businessEmail: z.string().optional(),
  phone: z.string().optional(),
  /** Checked as a phone key alongside `phone`. */
  mobile: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  companyId: z.number().int().optional(),
  excludeId: z.number().int().optional(),
});
export type ContactDuplicateCheck = z.infer<typeof ContactDuplicateCheck>;

export const CONTACT_SORTS = ['lastName', 'company', 'businessEmail', 'updatedAt'] as const;

export const ContactListQuery = PagingQuery.extend({
  sort: z.enum(CONTACT_SORTS).optional(),
  companyId: z.coerce.number().int().positive().optional(),
  contactType: z.string().trim().min(1).max(60).optional(),
  /** '1' = include inactive contacts (default: active only, as every picker needs). */
  inactive: z.enum(['0', '1']).transform((v) => v === '1').optional(),
});
export type ContactListQuery = z.infer<typeof ContactListQuery>;
