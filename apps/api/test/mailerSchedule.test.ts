import { describe, expect, test } from 'vitest';
import { startOfDayIn, startOfNextDayIn } from '../src/mailer/schedule';

/** The local calendar date (YYYY-MM-DD) of `at` in `timeZone`. */
const localDate = (timeZone: string, at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

// Daylight-saving days: [zone, an instant on the change day, the day's first instant, an instant on the day before].
const CASES: [string, string, string, string][] = [
  ['America/Santiago', '2026-09-06T12:00:00Z', '2026-09-06T04:00:00Z', '2026-09-05T12:00:00Z'], // local 00:00 does not exist; 01:00 −03
  ['America/Santiago', '2026-04-05T12:00:00Z', '2026-04-05T04:00:00Z', '2026-04-04T12:00:00Z'], // clocks went back at 03:00Z; 00:00 −04
  ['Australia/Sydney', '2026-10-04T05:00:00Z', '2026-10-03T14:00:00Z', '2026-10-03T05:00:00Z'],
  ['Australia/Sydney', '2026-04-05T05:00:00Z', '2026-04-04T13:00:00Z', '2026-04-04T05:00:00Z'],
  ['Europe/London', '2026-03-29T12:00:00Z', '2026-03-29T00:00:00Z', '2026-03-28T12:00:00Z'],
  ['America/Havana', '2026-11-01T12:00:00Z', '2026-11-01T04:00:00Z', '2026-10-31T12:00:00Z'], // back 01:00 → 00:00: midnight twice, the first counts
];

describe('mailer day boundaries in the sender time zone (daily limit)', () => {
  test.each(CASES)('%s: the day of %s begins at %s', (zone, at, start) => {
    const result = startOfDayIn(zone, new Date(at));
    expect(result.toISOString()).toBe(new Date(start).toISOString());
    expect(localDate(zone, result)).toBe(localDate(zone, new Date(at)));
    expect(localDate(zone, new Date(result.getTime() - 1)) < localDate(zone, result)).toBe(true);
  });

  test.each(CASES)('%s: the day after the day before %s begins at %s', (zone, at, start, dayBefore) => {
    const result = startOfNextDayIn(zone, new Date(dayBefore));
    expect(result.toISOString()).toBe(new Date(start).toISOString());
    expect(localDate(zone, result)).toBe(localDate(zone, new Date(at)));
    expect(localDate(zone, new Date(result.getTime() - 1))).toBe(localDate(zone, new Date(dayBefore)));
  });

  test('an ordinary day', () => {
    expect(startOfDayIn('Asia/Kolkata', new Date('2026-11-25T20:00:00Z')).toISOString()).toBe('2026-11-25T18:30:00.000Z');
    expect(startOfNextDayIn('America/Chicago', new Date('2026-11-25T20:00:00Z')).toISOString()).toBe('2026-11-26T06:00:00.000Z');
  });
});
