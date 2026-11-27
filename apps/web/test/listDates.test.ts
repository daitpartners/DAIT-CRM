import { describe, expect, test } from 'vitest';
import { dateGroup, rowTime } from '../src/pages/email/listDates';

// Thu 26 Nov 2026 14:30 Europe/London.
const NOW = new Date('2026-11-26T14:30:00Z');

describe('list dates (web-mail release 2)', () => {
  test('groups: today, yesterday, earlier this week, last week, older', () => {
    expect(['2026-11-26T09:02:00Z', '2026-11-25T17:46:00Z', '2026-11-23T10:00:00Z', '2026-11-20T10:00:00Z', '2026-11-13T10:00:00Z'].map((d) => dateGroup(d, 'Europe/London', NOW)))
      .toEqual(['today', 'yesterday', 'thisWeek', 'lastWeek', 'older']);
  });

  test('weeks start on Monday: Sunday is last week, Monday 00:00 local is this week', () => {
    expect(dateGroup('2026-11-22T23:59:00Z', 'Europe/London', NOW)).toBe('lastWeek');
    expect(dateGroup('2026-11-23T00:00:00Z', 'Europe/London', NOW)).toBe('thisWeek');
    expect(dateGroup('2026-11-16T00:00:00Z', 'Europe/London', NOW)).toBe('lastWeek');
    expect(dateGroup('2026-11-15T23:59:00Z', 'Europe/London', NOW)).toBe('older');
  });

  test('on a Monday, Sunday is yesterday (not last week)', () => {
    const monday = new Date('2026-11-23T09:00:00Z');
    expect(dateGroup('2026-11-22T18:00:00Z', 'Europe/London', monday)).toBe('yesterday');
    expect(dateGroup('2026-11-21T18:00:00Z', 'Europe/London', monday)).toBe('lastWeek');
  });

  test('days are the viewer zone’s days: 23:30 UTC is already tomorrow in Asia/Kolkata', () => {
    const at = new Date('2026-11-26T23:30:00Z'); // Fri 27 Nov 05:00 in Kolkata
    expect(dateGroup('2026-11-26T20:00:00Z', 'Asia/Kolkata', at)).toBe('today'); // 01:30 on the 27th
    expect(dateGroup('2026-11-26T18:00:00Z', 'Asia/Kolkata', at)).toBe('yesterday'); // 23:30 on the 26th
  });

  test('a time in the future (clock skew) counts as today', () => {
    expect(dateGroup('2026-11-26T15:00:00Z', 'Europe/London', NOW)).toBe('today');
  });

  test('rowTime: 24-hour today, Yesterday hh:mm, else weekday day month', () => {
    expect(rowTime('2026-11-26T14:05:00Z', 'Europe/London', 'en', NOW)).toBe('14:05');
    expect(rowTime('2026-11-25T17:46:00Z', 'Europe/London', 'en', NOW)).toBe('Yesterday 17:46');
    expect(rowTime('2026-11-20T10:00:00Z', 'Europe/London', 'en', NOW)).toBe('Fri 20 Nov');
  });

  test('rowTime in Spanish and French, in the viewer’s zone', () => {
    expect(rowTime('2026-11-25T17:46:00Z', 'Europe/London', 'es', NOW)).toBe('Ayer 17:46');
    expect(rowTime('2026-11-25T17:46:00Z', 'Europe/London', 'fr', NOW)).toBe('Hier 17:46');
    expect(rowTime('2026-11-20T10:00:00Z', 'Europe/London', 'es', NOW)).toBe('Vie 20 nov');
    expect(rowTime('2026-11-20T10:00:00Z', 'Europe/London', 'fr', NOW)).toBe('Ven 20 nov');
    expect(rowTime('2026-11-26T09:02:00Z', 'Asia/Kolkata', 'en', NOW)).toBe('14:32');
  });
});
