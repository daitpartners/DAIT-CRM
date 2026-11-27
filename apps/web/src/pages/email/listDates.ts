import { addDays, localNow } from '@dait-crm/shared';

/** The message list's date groups (web-mail release 2, Outlook): weeks start on Monday. */
export type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'older';

/** `YYYY-MM-DD` of `iso` in `timezone` (UTC for an unknown zone, as localNow). */
const dayOf = (iso: string, timezone: string) => localNow(timezone, new Date(iso)).day;

/** The Monday of the week holding `day` (`YYYY-MM-DD`). */
function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

/**
 * Which group a message received at `iso` falls in, by the viewer's own days in `timezone`: Today, Yesterday, earlier
 * this week (from Monday), last week, older. A moment after `now` (clock skew) counts as today.
 */
export function dateGroup(iso: string, timezone: string, now: Date = new Date()): DateGroup {
  const today = localNow(timezone, now).day;
  const day = dayOf(iso, timezone);
  if (day >= today) return 'today';
  if (day === addDays(today, -1)) return 'yesterday';
  const monday = mondayOf(today);
  if (day >= monday) return 'thisWeek';
  if (day >= addDays(monday, -7)) return 'lastWeek';
  return 'older';
}

const LOCALES: Record<string, string> = { en: 'en-GB', es: 'es-ES', fr: 'fr-FR' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const noDot = (s: string) => s.replace(/\.$/, '');

/**
 * A row's time, 24-hour in the viewer's zone: today `14:05`; yesterday `Yesterday 17:46` (in `language`); otherwise
 * the weekday, day and month, `Fri 20 Nov`.
 */
export function rowTime(iso: string, timezone: string, language: string, now: Date = new Date()): string {
  const locale = LOCALES[language] ?? LOCALES.en!;
  const group = dateGroup(iso, timezone, now);
  const at = new Date(iso);
  if (group === 'today' || group === 'yesterday') {
    const time = localNow(timezone, at).time;
    if (group === 'today') return time;
    return `${cap(new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day'))} ${time}`;
  }
  return weekdayDayMonth(at, timezone, locale);
}

/** `Fri 20 Nov` (in `locale`) of the instant `at` in `timezone` (UTC for an unknown zone). */
function weekdayDayMonth(at: Date, timezone: string, locale: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(at);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${cap(noDot(part('weekday')))} ${part('day')} ${noDot(part('month'))}`;
}

/** A calendar day (`YYYY-MM-DD`) as the Flag menu shows its due day: `Thu 26 Nov`, in `language`. */
export function dayLabel(day: string, language: string): string {
  return weekdayDayMonth(new Date(`${day}T12:00:00Z`), 'UTC', LOCALES[language] ?? LOCALES.en!);
}
