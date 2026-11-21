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

export const ContactUpdate = ContactCreate.omit({ companyId: true }).partial()
  .extend({ updatedAt: z.string().datetime() });
export type ContactUpdate = z.infer<typeof ContactUpdate>;

export const ContactDuplicateCheck = z.object({
  businessEmail: z.string().optional(),
  phone: z.string().optional(),
  /** Checked as the phone key when `phone` is blank. */
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
});
export type ContactListQuery = z.infer<typeof ContactListQuery>;
