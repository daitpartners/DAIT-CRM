import { z } from 'zod';
import { optionalText, optionalUrl } from './common.js';
import { MANUAL_SOURCE_TYPES } from '../research.js';

/**
 * `PUT /settings/enrichment` (Administrators). API keys are never part of it: they live in server environment
 * variables only (unknown keys are stripped).
 */
export const EnrichmentSettingsUpdate = z.object({
  dailyRunLimit: z.number().int().min(0).max(100_000),
  claudeEnabled: z.boolean(),
  /** Research runs that use Claude Code per calendar month (UTC); 0 = Claude off. */
  claudeMonthlyRunCap: z.number().int().min(0).max(10_000),
  placesEnabled: z.boolean(),
  /** Place Details calls per calendar month; 0 = Google Places off. */
  placesMonthlyCallCap: z.number().int().min(0).max(1_000_000),
  webSearchEnabled: z.boolean(),
});
export type EnrichmentSettingsUpdate = z.infer<typeof EnrichmentSettingsUpdate>;

/** `POST /companies/:id/sources`: "+ Add source manually" (prototype "Add research source" dialog). */
export const ManualSourceCreate = z.object({
  title: z.string().trim().min(1).max(200),
  url: optionalUrl(500),
  sourceType: z.enum(MANUAL_SOURCE_TYPES),
  fieldsPopulated: optionalText(500),
  notes: optionalText(4000),
});
export type ManualSourceCreate = z.infer<typeof ManualSourceCreate>;
