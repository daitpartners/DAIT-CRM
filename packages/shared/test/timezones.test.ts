import { describe, expect, test } from 'vitest';
import { US_ZONES, inWorkingHours, nextWorkingStart, resolveTimezones } from '../src/timezones';

const SENDER = 'Asia/Kolkata';

describe('recipient time zone (release 2C, client working hours)', () => {
  test("the company's own time zone always wins", () => {
    expect(resolveTimezones({ companyTimezone: 'America/Denver', country: 'United States', state: 'New York' }, SENDER))
      .toEqual({ zones: ['America/Denver'], source: 'company' });
  });

  test('single-zone countries resolve from the country', () => {
    expect(resolveTimezones({ country: 'Chile' }, SENDER)).toEqual({ zones: ['America/Santiago'], source: 'country' });
    expect(resolveTimezones({ country: 'Spain', city: 'Madrid' }, SENDER)).toEqual({ zones: ['Europe/Madrid'], source: 'country' });
    expect(resolveTimezones({ country: 'India' }, SENDER)).toEqual({ zones: ['Asia/Kolkata'], source: 'country' });
    expect(resolveTimezones({ country: 'united kingdom' }, SENDER)).toEqual({ zones: ['Europe/London'], source: 'country' });
  });

  test('US states by name or code, and major cities when the state is missing', () => {
    expect(resolveTimezones({ country: 'United States', state: 'Texas' }, SENDER)).toEqual({ zones: ['America/Chicago'], source: 'address' });
    expect(resolveTimezones({ country: 'USA', state: 'TX' }, SENDER)).toEqual({ zones: ['America/Chicago'], source: 'address' });
    expect(resolveTimezones({ country: 'United States', state: 'california' }, SENDER)).toEqual({ zones: ['America/Los_Angeles'], source: 'address' });
    expect(resolveTimezones({ country: 'United States', city: 'Seattle' }, SENDER)).toEqual({ zones: ['America/Los_Angeles'], source: 'address' });
    expect(resolveTimezones({ country: 'United States', city: 'New York' }, SENDER)).toEqual({ zones: ['America/New_York'], source: 'address' });
  });

  test('a multi-zone country with no usable state or city gives all its main zones', () => {
    expect(resolveTimezones({ country: 'United States', city: 'Smalltown' }, SENDER)).toEqual({ zones: US_ZONES, source: 'country' });
  });

  test('Canada, Mexico and the Canary Islands by province / state', () => {
    expect(resolveTimezones({ country: 'Canada', state: 'Québec' }, SENDER)).toEqual({ zones: ['America/Toronto'], source: 'address' });
    expect(resolveTimezones({ country: 'Canada', city: 'Vancouver' }, SENDER)).toEqual({ zones: ['America/Vancouver'], source: 'address' });
    expect(resolveTimezones({ country: 'México', state: 'Baja California' }, SENDER)).toEqual({ zones: ['America/Tijuana'], source: 'address' });
    expect(resolveTimezones({ country: 'Mexico', city: 'Monterrey' }, SENDER)).toEqual({ zones: ['America/Monterrey'], source: 'address' });
    expect(resolveTimezones({ country: 'Spain', state: 'Las Palmas' }, SENDER)).toEqual({ zones: ['Atlantic/Canary'], source: 'address' });
  });

  test("an unknown country uses the sender's time zone", () => {
    expect(resolveTimezones({ country: 'Atlantis' }, SENDER)).toEqual({ zones: [SENDER], source: 'sender' });
    expect(resolveTimezones({}, SENDER)).toEqual({ zones: [SENDER], source: 'sender' });
  });

  test('an invalid company time zone is ignored', () => {
    expect(resolveTimezones({ companyTimezone: 'Mars/Base', country: 'Chile' }, SENDER)).toEqual({ zones: ['America/Santiago'], source: 'country' });
  });
});

describe('working hours: Monday–Friday 09:00–18:00 in every zone', () => {
  // Wednesday 25 Nov 2026.
  test('inside and at the edges in one zone', () => {
    expect(inWorkingHours(['Europe/London'], new Date('2026-11-25T09:00:00Z'))).toBe(true);
    expect(inWorkingHours(['Europe/London'], new Date('2026-11-25T17:59:00Z'))).toBe(true);
    expect(inWorkingHours(['Europe/London'], new Date('2026-11-25T18:00:00Z'))).toBe(false);
    expect(inWorkingHours(['Europe/London'], new Date('2026-11-25T08:59:00Z'))).toBe(false);
  });

  test('weekends are not working days', () => {
    expect(inWorkingHours(['Europe/London'], new Date('2026-11-28T12:00:00Z'))).toBe(false);
    expect(inWorkingHours(['Europe/London'], new Date('2026-11-29T12:00:00Z'))).toBe(false);
  });

  test('all US zones: only noon to six in New York', () => {
    // 16:00Z = 11:00 New York / 08:00 Los Angeles → no; 17:00Z = 12:00 NY / 09:00 LA → yes; 23:00Z = 18:00 NY → no.
    expect(inWorkingHours(US_ZONES, new Date('2026-11-25T16:00:00Z'))).toBe(false);
    expect(inWorkingHours(US_ZONES, new Date('2026-11-25T17:00:00Z'))).toBe(true);
    expect(inWorkingHours(US_ZONES, new Date('2026-11-25T22:59:00Z'))).toBe(true);
    expect(inWorkingHours(US_ZONES, new Date('2026-11-25T23:00:00Z'))).toBe(false);
  });
});

describe('next working time', () => {
  test('Chicago on Saturday: Monday 09:00 Chicago', () => {
    expect(nextWorkingStart(['America/Chicago'], new Date('2026-11-21T20:00:00Z')).toISOString()).toBe('2026-11-23T15:00:00.000Z');
  });

  test('inside working hours it is the given time', () => {
    const from = new Date('2026-11-25T10:07:13Z');
    expect(nextWorkingStart(['Europe/London'], from).toISOString()).toBe(from.toISOString());
  });

  test('India on Friday afternoon: Monday 09:00 IST', () => {
    expect(nextWorkingStart(['Asia/Kolkata'], new Date('2026-11-20T13:00:00Z')).toISOString()).toBe('2026-11-23T03:30:00.000Z');
  });

  test('all US zones on Saturday: Monday 09:00 Los Angeles, when all are open', () => {
    expect(nextWorkingStart(US_ZONES, new Date('2026-11-21T20:00:00Z')).toISOString()).toBe('2026-11-23T17:00:00.000Z');
  });

  test('zones that never share working hours fall back to five minutes later', () => {
    const from = new Date('2026-11-25T10:00:00Z');
    expect(nextWorkingStart(['Asia/Kolkata', 'America/Los_Angeles'], from).toISOString()).toBe(new Date(from.getTime() + 5 * 60_000).toISOString());
  });
});

describe('every Mexican and Brazilian state', () => {
  const zone = (country: string, state: string) => resolveTimezones({ country, state }, 'UTC');

  test('Mexico', () => {
    expect(zone('Mexico', 'Jalisco')).toEqual({ zones: ['America/Mexico_City'], source: 'address' });
    expect(zone('Mexico', 'Nuevo León')).toEqual({ zones: ['America/Monterrey'], source: 'address' });
    expect(zone('Mexico', 'Yucatán')).toEqual({ zones: ['America/Merida'], source: 'address' });
    expect(zone('México', 'Ciudad de México').zones).toEqual(['America/Mexico_City']);
    expect(zone('Mexico', 'CDMX').zones).toEqual(['America/Mexico_City']);
    expect(zone('Mexico', 'Estado de México').zones).toEqual(['America/Mexico_City']);
    expect(zone('Mexico', 'Tamaulipas').zones).toEqual(['America/Monterrey']);
    expect(zone('Mexico', 'Campeche').zones).toEqual(['America/Merida']);
    expect(zone('Mexico', 'Baja California').zones).toEqual(['America/Tijuana']);
  });

  test('Brazil by name or code', () => {
    expect(zone('Brazil', 'São Paulo')).toEqual({ zones: ['America/Sao_Paulo'], source: 'address' });
    expect(zone('Brasil', 'SP')).toEqual({ zones: ['America/Sao_Paulo'], source: 'address' });
    expect(zone('Brazil', 'Bahia')).toEqual({ zones: ['America/Bahia'], source: 'address' });
    expect(zone('Brazil', 'Pernambuco')).toEqual({ zones: ['America/Recife'], source: 'address' });
    expect(zone('Brazil', 'Pará')).toEqual({ zones: ['America/Belem'], source: 'address' });
    expect(zone('Brazil', 'Paraná').zones).toEqual(['America/Sao_Paulo']);
    expect(zone('Brazil', 'Ceará').zones).toEqual(['America/Fortaleza']);
    expect(zone('Brazil', 'AL').zones).toEqual(['America/Maceio']);
    expect(zone('Brazil', 'Tocantins').zones).toEqual(['America/Araguaina']);
    expect(zone('Brazil', 'Amazonas').zones).toEqual(['America/Manaus']);
  });
});
