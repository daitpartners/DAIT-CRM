/** The language a lead is approached in (owner, 22 Nov 2026: English and Spanish markets). */
export const OUTREACH_LANGUAGES = ['en', 'es'] as const;
export type OutreachLanguage = (typeof OUTREACH_LANGUAGES)[number];

/** Countries whose leads start as Spanish (country lookup values); everything else starts as English. */
export const SPANISH_COUNTRIES: readonly string[] = [
  'Mexico', 'Chile', 'Spain', 'Argentina', 'Colombia', 'Peru', 'Venezuela', 'Ecuador', 'Guatemala', 'Cuba', 'Bolivia',
  'Dominican Republic', 'Honduras', 'Paraguay', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Uruguay', 'Puerto Rico',
];

/** The language a new lead gets when none is given: Spanish for Spanish-speaking countries, else English. */
export function defaultOutreachLanguage(country: string | null | undefined): OutreachLanguage {
  const c = (country ?? '').trim().toLowerCase();
  return SPANISH_COUNTRIES.some((s) => s.toLowerCase() === c) ? 'es' : 'en';
}

/** A CSV / free-text value as a language ("es", "Español", "Spanish", "English", "Inglés"…), or null when unknown. */
export function parseOutreachLanguage(raw: string | null | undefined): OutreachLanguage | null {
  const v = (raw ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (['es', 'spa', 'spanish', 'espanol', 'castellano'].includes(v)) return 'es';
  if (['en', 'eng', 'english', 'ingles'].includes(v)) return 'en';
  return null;
}
