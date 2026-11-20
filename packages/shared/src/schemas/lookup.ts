import { z } from 'zod';

export const LOOKUP_GROUPS = [
  'lead_source', 'lead_status', 'lead_type', 'priority', 'country', 'industry',
  'business_category', 'business_type', 'employee_range', 'revenue_range',
  'ownership_type', 'contact_type', 'location_type', 'quote_status', 'currency',
] as const;
export type LookupGroup = (typeof LOOKUP_GROUPS)[number];

export const LookupValueCreate = z.object({
  group: z.enum(LOOKUP_GROUPS),
  value: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  labelEs: z.string().trim().min(1).max(100).optional(),
  labelFr: z.string().trim().min(1).max(100).optional(),
  sortOrder: z.number().int().optional(),
});
export type LookupValueCreate = z.infer<typeof LookupValueCreate>;

export const LookupValueUpdate = LookupValueCreate.omit({ group: true }).partial();
export type LookupValueUpdate = z.infer<typeof LookupValueUpdate>;
