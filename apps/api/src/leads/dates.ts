/** Today's calendar date (YYYY-MM-DD) in `timezone`; falls back to UTC for an unknown zone. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  const fmt = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  try {
    return fmt(timezone);
  } catch {
    return fmt('UTC');
  }
}

/**
 * The instant a calendar day (YYYY-MM-DD) starts in `timezone` (UTC for an unknown zone).
 * Two passes of "UTC midnight minus the zone's offset at that moment" settle DST edges.
 */
export function startOfDayIn(day: string, timezone: string): Date {
  const utc = new Date(`${day}T00:00:00Z`).getTime();
  const offsetAt = (ms: number) => {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
      );
      const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
      return wall - ms;
    } catch {
      return 0;
    }
  };
  let guess = utc - offsetAt(utc);
  guess = utc - offsetAt(guess);
  return new Date(guess);
}

/** A `@db.Date` column value as YYYY-MM-DD (Prisma returns it as UTC midnight). */
export function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** A YYYY-MM-DD string as the Date Prisma writes to a `@db.Date` column. */
export function dateOnly(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/**
 * An all-day calendar time moved to the nearest UTC midnight. Graph is asked for UTC but may send an all-day event's
 * midnight in its own zone (Kolkata 10 Mar → 2030-03-09T18:30Z); rounding restores the intended date for any offset
 * under 12 hours.
 */
export function nearestUtcMidnight(at: Date): Date {
  const DAY_MS = 86_400_000;
  return new Date(Math.round(at.getTime() / DAY_MS) * DAY_MS);
}

/**
 * An all-day calendar time as UTC midnight of its date: a midnight in `timezone` (the owner's) gives that local date,
 * which also holds east of UTC+12 (New Zealand, Tonga, Kiribati) where rounding picks the day before; any other time
 * is rounded to the nearest UTC midnight.
 */
export function allDayMidnight(at: Date, timezone: string): Date {
  let local: Record<string, string> | null = null;
  try {
    local = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((p) => [p.type, p.value]));
  } catch {
    // An unknown zone: rounding only.
  }
  if (local && local.hour === '00' && local.minute === '00') return new Date(`${local.year}-${local.month}-${local.day}T00:00:00.000Z`);
  return nearestUtcMidnight(at);
}
