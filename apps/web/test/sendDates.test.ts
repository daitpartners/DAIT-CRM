import { describe, expect, test } from 'vitest';
import { savedLabel, whenLabel, whenShort } from '../src/pages/email/sendDates';

// Fri 27 Nov 2026 10:00 Europe/London.
const NOW = new Date('2026-11-27T10:00:00Z');

describe('send dates (web-mail release 3)', () => {
  test('labels: long and short, 24-hour, in the user zone and language', () => {
    expect(whenLabel('2026-12-01', '09:00', 'Europe/London', 'en')).toBe('Tue 1 Dec 2026, 09:00');
    expect(whenShort('2026-12-01', '09:00', 'Europe/London', 'es', NOW)).toBe('mar 1 dic, 09:00');
  });

  test('every language: no trailing dots, 24-hour', () => {
    expect(whenLabel('2026-12-01', '17:30', 'Europe/London', 'es')).toBe('mar 1 dic 2026, 17:30');
    expect(whenLabel('2026-12-01', '17:30', 'Europe/London', 'fr')).toBe('mar 1 déc 2026, 17:30');
    expect(whenShort('2026-12-01', '17:30', 'Europe/London', 'en', NOW)).toBe('Tue 1 Dec, 17:30');
    expect(whenShort('2026-12-01', '17:30', 'Europe/London', 'fr', NOW)).toBe('mar 1 déc, 17:30');
  });

  test('an unknown language reads as English', () => {
    expect(whenLabel('2026-12-01', '09:00', 'Europe/London', 'de')).toBe('Tue 1 Dec 2026, 09:00');
  });

  test('the short label adds the year for a day outside the user’s current year', () => {
    expect(whenShort('2027-01-04', '08:00', 'Europe/London', 'en', NOW)).toBe('Mon 4 Jan 2027, 08:00');
    // 31 Dec 23:30 UTC is already 1 Jan 2027 in Kolkata: a 2027 day is this year there.
    const newYear = new Date('2026-12-31T23:30:00Z');
    expect(whenShort('2027-01-04', '08:00', 'Asia/Kolkata', 'en', newYear)).toBe('Mon 4 Jan, 08:00');
    expect(whenShort('2027-01-04', '08:00', 'Europe/London', 'en', newYear)).toBe('Mon 4 Jan 2027, 08:00');
  });

  test('savedLabel: the save time, 24-hour, in the user zone', () => {
    expect(savedLabel('2026-11-27T14:32:10.000Z', 'Europe/London')).toBe('14:32');
    expect(savedLabel('2026-11-27T14:32:10.000Z', 'Asia/Kolkata')).toBe('20:02');
    expect(savedLabel('2026-07-01T14:32:00.000Z', 'Europe/London')).toBe('15:32'); // BST
    expect(savedLabel('2026-11-27T14:32:00.000Z', 'Not/AZone')).toBe('14:32');
  });
});
