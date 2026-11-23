/* AI research (release 4): statuses, the fields a run may suggest, source types and the engine settings defaults. */

/** `Company.aiResearchStatus`: "Not started" = never researched (the auto-trigger condition); "Pending" = queued. */
export const RESEARCH_STATUSES = ['Not started', 'Pending', 'Processing', 'Completed', 'Failed'] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

/** `EnrichmentRun.status`. */
export const RUN_STATUSES = ['Pending', 'Processing', 'Completed', 'Failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses counted as the Companies list "AI queue" (and that block a second run on the same company). */
export const RESEARCH_QUEUE_STATUSES = ['Pending', 'Processing'] as const satisfies readonly ResearchStatus[];

/** `EnrichmentSuggestion.decision`; "superseded" = replaced by a newer suggestion for the same field. */
export const SUGGESTION_DECISIONS = ['pending', 'accepted', 'rejected', 'superseded'] as const;
export type SuggestionDecision = (typeof SUGGESTION_DECISIONS)[number];

/**
 * The company fields a run may suggest a value for (only when empty and not verified), with the label shown in the
 * suggestions table: the prototype's suggestion labels where it has one, else the company form's label.
 * `aiPotentialServices` writes `ai_potential_services`; every other key is the Company column of that name.
 */
export const RESEARCH_FIELDS = [
  { field: 'description', label: 'Company description' },
  { field: 'legalName', label: 'Legal company name' },
  { field: 'businessEmail', label: 'Business email' },
  { field: 'street', label: 'Street address' },
  { field: 'city', label: 'City' },
  { field: 'state', label: 'State / Province' },
  { field: 'zip', label: 'ZIP / Postal code' },
  { field: 'yearEstablished', label: 'Year established' },
  { field: 'linkedinUrl', label: 'LinkedIn company URL' },
  { field: 'socialFacebook', label: 'Facebook' },
  { field: 'socialInstagram', label: 'Instagram' },
  { field: 'socialX', label: 'X / Twitter' },
  { field: 'socialYoutube', label: 'YouTube' },
  { field: 'websiteTechnology', label: 'Website technology' },
  { field: 'lat', label: 'Latitude' },
  { field: 'lng', label: 'Longitude' },
  { field: 'mapsUrl', label: 'Google Maps link' },
  { field: 'website', label: 'Website' },
  { field: 'websiteAssessment', label: 'Website assessment' },
  { field: 'specialisation', label: 'Specialisation' },
  { field: 'employeeRange', label: 'Employee range' },
  { field: 'aiPotentialServices', label: 'Potential services' },
] as const satisfies readonly { field: string; label: string }[];
export type ResearchField = (typeof RESEARCH_FIELDS)[number]['field'];

/** The suggestion label for a field; an unknown field shows as given. */
export function researchFieldLabel(field: string): string {
  return RESEARCH_FIELDS.find((f) => f.field === field)?.label ?? field;
}

/** `SourceRecord.sourceType` (docs/data-model.md source_records). */
export const SOURCE_TYPES = [
  'Company website', 'Google Places API', 'Public registry', 'Business directory', 'Social profile',
  'Contact form', 'Manual research', 'CSV import',
] as const;

/** Types offered by "+ Add source manually" (prototype "Add research source" dialog, in its order). */
export const MANUAL_SOURCE_TYPES = [
  'Company website', 'Business directory', 'Public registry', 'Social profile', 'Google Places API', 'Other',
] as const;

/**
 * The enrichment engine settings as seeded by migration 20261204100000_ai_research (the Claude run cap since
 * 20261205100000_claude_code_run_cap): everything that costs money is off (caps 0). The migrations must match; the API
 * falls back to these when the row is missing.
 */
export const ENRICHMENT_SETTINGS_DEFAULTS = {
  dailyRunLimit: 50,
  claudeEnabled: false,
  claudeMonthlyRunCap: 0,
  placesEnabled: false,
  placesMonthlyCallCap: 0,
  webSearchEnabled: false,
} as const satisfies {
  dailyRunLimit: number; claudeEnabled: boolean; claudeMonthlyRunCap: number;
  placesEnabled: boolean; placesMonthlyCallCap: number; webSearchEnabled: boolean;
};
