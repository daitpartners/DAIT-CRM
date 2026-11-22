import { describe, expect, it } from 'vitest';
import {
  addDays, addMonths, calendarNames, calendarTitle, dow, isDate, monthGrid, monthWeeks, shortDay, weekDays,
} from '../src/pages/calendar/dates';

const en = calendarNames('en');

describe('calendar date helpers', () => {
  it('counts weekdays Monday-first, in UTC whatever the computer zone', () => {
    expect(dow('2026-11-23')).toBe(0); // Monday
    expect(dow('2026-11-22')).toBe(6); // Sunday
    expect(dow('2026-03-29')).toBe(6); // the London clock change day
  });

  it('adds days and months across month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-01');
    expect(isDate('2026-11-23')).toBe(true);
    expect(isDate('23/11/2026')).toBe(false);
  });

  it('starts the month grid on the Monday on or before the 1st, 42 days long', () => {
    const g = monthGrid('2026-11-15');
    expect(g[0]).toBe('2026-10-26');
    expect(g).toHaveLength(42);
    expect(g[41]).toBe('2026-12-06');
    expect(monthGrid('2027-02-10')[0]).toBe('2027-02-01'); // the 1st is a Monday
  });

  it('shows 6 weeks only when the month reaches the sixth row, else 5', () => {
    expect(monthWeeks('2026-11-01')).toBe(6); // Nov 30 is on row 6
    expect(monthWeeks('2026-12-01')).toBe(5);
    expect(monthWeeks('2027-02-01')).toBe(5); // a 4-row February still shows 5
  });

  it('gives the Monday-to-Sunday week of a day', () => {
    expect(weekDays('2026-11-25')).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
  });

  it('titles each view as the prototype', () => {
    expect(calendarTitle('month', '2026-11-15', en)).toBe('November 2026');
    expect(calendarTitle('week', '2026-11-25', en)).toBe('23 – 29 Nov 2026');
    expect(calendarTitle('week', '2026-12-02', en)).toBe('30 Nov – 6 Dec 2026');
    expect(calendarTitle('day', '2026-11-23', en)).toBe('Monday 23 November 2026');
    expect(shortDay('2026-11-23', en)).toBe('Mon 23 Nov');
    expect(shortDay('2026-09-01', en)).toBe('Tue 1 Sep');
  });

  it('names months and days in Spanish', () => {
    const es = calendarNames('es');
    expect(calendarTitle('month', '2026-11-15', es)).toBe('Noviembre 2026');
    expect(shortDay('2026-11-23', es)).toBe('Lun 23 Nov');
    expect(es.narrow).toHaveLength(7);
  });
});
