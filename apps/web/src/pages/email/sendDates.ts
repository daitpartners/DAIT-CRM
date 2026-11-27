import { localNow } from '@dait-crm/shared';

/**
 * The send flow's dates (web-mail release 3): the follow-up cards, the Schedule send choices, the Undo toast and the
 * Scheduled list, and "Draft saved hh:mm". Always 24-hour, in the user's language; a `day` and `time` are a wall-clock
 * day (`YYYY-MM-DD`) and time (`HH:MM`) in the user's own zone (`me.timezone`), as the shared presets give them.
 */

const LOCALES: Record<string, string> = { en: 'en-GB', es: 'es-ES', fr: 'fr-FR' };
const noDot = (s: string) => s.replace(/\.$/, '');

/** `Tue 1 Dec` (in `lang`) of a calendar day, plus its year when `withYear`. */
function dayText(day: string, lang: string, withYear: boolean): string {
  const parts = new Intl.DateTimeFormat(LOCALES[lang] ?? LOCALES.en!, {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  }).formatToParts(new Date(`${day}T12:00:00Z`));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const text = `${noDot(part('weekday'))} ${part('day')} ${noDot(part('month'))}`;
  return withYear ? `${text} ${part('year')}` : text;
}

/**
 * The long label (follow-up cards, the custom choice): `Tue 1 Dec 2026, 09:00`; `mar 1 dic 2026, 09:00` in Spanish.
 * Always with the year, so `timezone` and `now` (taken for the same call shape as whenShort) do not change it.
 */
export function whenLabel(day: string, time: string, _timezone: string, lang: string, _now?: Date): string {
  return `${dayText(day, lang, true)}, ${time}`;
}

/**
 * The short label (the Undo toast, the Scheduled list): `Tue 1 Dec, 09:00`; the year is added when the day is not in
 * the user's current year (`now` in `timezone`), e.g. a send scheduled into next year.
 */
export function whenShort(day: string, time: string, timezone: string, lang: string, now: Date = new Date()): string {
  const thisYear = localNow(timezone, now).day.slice(0, 4);
  return `${dayText(day, lang, day.slice(0, 4) !== thisYear)}, ${time}`;
}

/** "Draft saved hh:mm": the 24-hour time of the instant `iso` in `timezone` (UTC for an unknown zone). */
export function savedLabel(iso: string, timezone: string): string {
  return localNow(timezone, new Date(iso)).time;
}

/** The instant `iso` (a scheduled send's time) as whenShort / whenLabel show it, in `timezone`: `Mon 30 Nov, 08:00`. */
export function instantShort(iso: string, timezone: string, lang: string, now: Date = new Date()): string {
  const local = localNow(timezone, new Date(iso));
  return whenShort(local.day, local.time, timezone, lang, now);
}

/** The instant `iso` as the long label, in `timezone`: `Mon 30 Nov 2026, 08:00`. */
export function instantLabel(iso: string, timezone: string, lang: string): string {
  const local = localNow(timezone, new Date(iso));
  return whenLabel(local.day, local.time, timezone, lang);
}
