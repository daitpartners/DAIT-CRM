import { z } from 'zod';
import { OUTREACH_LANGUAGES } from '../outreach.js';

export const AllocationRuleCreate = z.object({
  name: z.string().trim().min(1).max(100),
  matchCountries: z.array(z.string().min(1)).nonempty(),
  assignTo: z.union([z.number().int(), z.array(z.number().int()).nonempty()]),
  priority: z.number().int().min(0),
  /** Only leads in this outreach language; null / left out = any language. */
  matchLanguage: z.enum(OUTREACH_LANGUAGES).nullish(),
});
export type AllocationRuleCreate = z.infer<typeof AllocationRuleCreate>;

export const AllocationRuleUpdate = AllocationRuleCreate.partial().extend({ isActive: z.boolean().optional() });
export type AllocationRuleUpdate = z.infer<typeof AllocationRuleUpdate>;
