import { z } from 'zod';
import { ROLES } from '../roles.js';

const TIMEZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

// supportedValuesOf lists canonical names only (e.g. Asia/Calcutta, not Asia/Kolkata),
// so also accept Area/City aliases the runtime can resolve.
function isTimezone(v: string): boolean {
  if (v === 'UTC' || TIMEZONES.has(v)) return true;
  if (!/^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

export const Timezone = z.string().refine(isTimezone, { message: 'Invalid IANA timezone' });

export const Language = z.enum(['en', 'es', 'fr']);
export type Language = z.infer<typeof Language>;

export const DATE_FORMATS = ['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY'] as const;
export const DateFormat = z.enum(DATE_FORMATS);

export const UserCreate = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  language: Language.default('en'),
  timezone: Timezone.default('Europe/London'),
});
export type UserCreate = z.infer<typeof UserCreate>;

export const UserUpdate = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  language: Language,
  timezone: Timezone,
  isActive: z.boolean(),
}).partial();
export type UserUpdate = z.infer<typeof UserUpdate>;

export const PreferencesUpdate = z.object({
  language: Language,
  timezone: Timezone,
  dateFormat: DateFormat,
});
export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>;
