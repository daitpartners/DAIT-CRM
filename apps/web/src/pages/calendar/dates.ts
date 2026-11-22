/* Pure date helpers for the Calendar (prototype views-calendar.js). Dates are YYYY-MM-DD strings handled in UTC, so
   the computer's time zone cannot shift a day; weeks start on Monday. */
import type { Lang } from '../../api/queries';

export type CalendarView = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;
const p2 = (n: number) => String(n).padStart(2, '0');
const utc = (d: string) => new Date(`${d}T00:00:00Z`);
const ymd = (dt: Date) => `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;

export const isDate = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && !Number.isNaN(utc(s!).getTime());
/** Monday = 0 … Sunday = 6. */
export const dow = (d: string) => (utc(d).getUTCDay() + 6) % 7;
export const dayNum = (d: string) => parseInt(d.slice(8), 10);
export const monthIndex = (d: string) => Number(d.slice(5, 7)) - 1;
export const monthStart = (d: string) => `${d.slice(0, 8)}01`;
export const addDays = (d: string, n: number) => ymd(new Date(utc(d).getTime() + n * DAY_MS));
/** The 1st of the month `n` months from `d`'s month. */
export const addMonths = (d: string, n: number) => ymd(new Date(Date.UTC(Number(d.slice(0, 4)), monthIndex(d) + n, 1)));

/** The 42 days (6 weeks) of `d`'s month grid, from the Monday on or before the 1st. */
export function monthGrid(d: string): string[] {
  const ms = monthStart(d);
  const start = addDays(ms, -dow(ms));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Rows the month view shows: 6 when the month reaches the sixth row, else 5. */
export function monthWeeks(d: string): 5 | 6 {
  const month = d.slice(0, 7);
  return monthGrid(d).slice(35).some((x) => x.slice(0, 7) === month) ? 6 : 5;
}

/** Monday to Sunday of `d`'s week. */
export function weekDays(d: string): string[] {
  const start = addDays(d, -dow(d));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Today (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return ymd(new Date());
  }
}

/** Month and day names in the user's language; `days` are Monday-first, `narrow` the mini month's column heads. */
export type CalendarNames = { months: string[]; monthsShort: string[]; days: string[]; daysShort: string[]; narrow: string[] };

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-ES', fr: 'fr-FR' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function calendarNames(lang: Lang): CalendarNames {
  const locale = LOCALE[lang] ?? LOCALE.en;
  const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts });
  const month = (o: Intl.DateTimeFormatOptions) => Array.from({ length: 12 }, (_, m) => cap(f(o).format(Date.UTC(2026, m, 1))).replace(/\.$/, ''));
  // 5 Jan 2026 is a Monday.
  const day = (o: Intl.DateTimeFormatOptions) => Array.from({ length: 7 }, (_, i) => cap(f(o).format(Date.UTC(2026, 0, 5 + i))).replace(/\.$/, ''));
  return { months: month({ month: 'long' }), monthsShort: month({ month: 'short' }), days: day({ weekday: 'long' }), daysShort: day({ weekday: 'short' }), narrow: day({ weekday: 'narrow' }) };
}

/** "Mon 23 Nov" (prototype `short`). */
export const shortDay = (d: string, n: CalendarNames) => `${n.daysShort[dow(d)]} ${dayNum(d)} ${n.monthsShort[monthIndex(d)]}`;

/** "November 2026" / "23 – 29 Nov 2026" or "30 Nov – 6 Dec 2026" / "Monday 23 November 2026". */
export function calendarTitle(view: CalendarView, d: string, n: CalendarNames): string {
  if (view === 'month') return `${n.months[monthIndex(d)]} ${d.slice(0, 4)}`;
  if (view === 'day') return `${n.days[dow(d)]} ${dayNum(d)} ${n.months[monthIndex(d)]} ${d.slice(0, 4)}`;
  const w = weekDays(d);
  const first = w[0]!;
  const last = w[6]!;
  const firstMonth = monthIndex(first) !== monthIndex(last) ? ` ${n.monthsShort[monthIndex(first)]}` : '';
  return `${dayNum(first)}${firstMonth} – ${dayNum(last)} ${n.monthsShort[monthIndex(last)]} ${last.slice(0, 4)}`;
}
