import {
  ENRICHMENT_SETTINGS_DEFAULTS, MANUAL_SOURCE_TYPES, RESEARCH_FIELDS, RESEARCH_QUEUE_STATUSES, RESEARCH_STATUSES,
  RUN_STATUSES, SOURCE_TYPES, SUGGESTION_DECISIONS, researchFieldLabel,
} from '../src/research';
import { EnrichmentSettingsUpdate, ManualSourceCreate } from '../src/schemas/research';

describe('research constants', () => {
  test('company research statuses: Not started first, then the run lifecycle', () => {
    expect(RESEARCH_STATUSES).toEqual(['Not started', 'Pending', 'Processing', 'Completed', 'Failed']);
    expect(RUN_STATUSES).toEqual(['Pending', 'Processing', 'Completed', 'Failed']);
    expect(RESEARCH_QUEUE_STATUSES).toEqual(['Pending', 'Processing']);
    expect(SUGGESTION_DECISIONS).toEqual(['pending', 'accepted', 'rejected', 'superseded']);
  });

  test('suggestion fields, in order, with their labels (prototype texts first, else the company form)', () => {
    expect(RESEARCH_FIELDS).toEqual([
      { field: 'description', label: 'Company description' },
      { field: 'legalName', label: 'Legal company name' },
      { field: 'businessEmail', label: 'Business email' },
      { field: 'street', label: 'Street address' },
      { field: 'city', label: 'City' },
      { field: 'state', label: 'State / Province' },
      { field: 'zip', label: 'ZIP / Postal code' },
      { field: 'yearEstablished', label: 'Year established' },
      { field: 'linkedinUrl', label: 'LinkedIn company URL' },
      { field: 'socialFacebook', label: 'Facebook' },
      { field: 'socialInstagram', label: 'Instagram' },
      { field: 'socialX', label: 'X / Twitter' },
      { field: 'socialYoutube', label: 'YouTube' },
      { field: 'websiteTechnology', label: 'Website technology' },
      { field: 'lat', label: 'Latitude' },
      { field: 'lng', label: 'Longitude' },
      { field: 'mapsUrl', label: 'Google Maps link' },
      { field: 'website', label: 'Website' },
      { field: 'websiteAssessment', label: 'Website assessment' },
      { field: 'specialisation', label: 'Specialisation' },
      { field: 'employeeRange', label: 'Employee range' },
      { field: 'aiPotentialServices', label: 'Potential services' },
    ]);
    expect(new Set(RESEARCH_FIELDS.map((f) => f.field)).size).toBe(RESEARCH_FIELDS.length);
  });

  test('researchFieldLabel looks up the label; unknown fields show as given', () => {
    expect(researchFieldLabel('websiteTechnology')).toBe('Website technology');
    expect(researchFieldLabel('aiPotentialServices')).toBe('Potential services');
    expect(researchFieldLabel('industry')).toBe('industry');
  });

  test('source types: the data model list; the manual dialog offers the prototype list', () => {
    expect(SOURCE_TYPES).toEqual([
      'Company website', 'Google Places API', 'Public registry', 'Business directory', 'Social profile',
      'Contact form', 'Manual research', 'CSV import',
    ]);
    expect(MANUAL_SOURCE_TYPES).toEqual([
      'Company website', 'Business directory', 'Public registry', 'Social profile', 'Google Places API', 'Other',
    ]);
  });

  test('settings defaults match the migration seed: everything that costs money is off', () => {
    expect(ENRICHMENT_SETTINGS_DEFAULTS).toEqual({
      dailyRunLimit: 50, claudeEnabled: false, claudeMonthlyRunCap: 0,
      placesEnabled: false, placesMonthlyCallCap: 0, webSearchEnabled: false,
    });
  });
});

describe('EnrichmentSettingsUpdate', () => {
  const valid = { ...ENRICHMENT_SETTINGS_DEFAULTS };
  test('accepts the defaults and a whole monthly Claude run cap', () => {
    expect(EnrichmentSettingsUpdate.parse(valid)).toEqual(valid);
    expect(EnrichmentSettingsUpdate.parse({ ...valid, claudeEnabled: true, claudeMonthlyRunCap: 200 }).claudeMonthlyRunCap).toBe(200);
  });
  test('rejects negative or fractional limits and missing fields', () => {
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, dailyRunLimit: -1 }).success).toBe(false);
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, dailyRunLimit: 1.5 }).success).toBe(false);
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, dailyRunLimit: 100_001 }).success).toBe(false);
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, claudeMonthlyRunCap: -1 }).success).toBe(false);
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, claudeMonthlyRunCap: 2.5 }).success).toBe(false);
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, claudeMonthlyRunCap: 10_001 }).success).toBe(false);
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, placesMonthlyCallCap: 2.5 }).success).toBe(false);
    expect(EnrichmentSettingsUpdate.safeParse({ ...valid, placesEnabled: 'yes' }).success).toBe(false);
    const { webSearchEnabled: _w, ...missing } = valid;
    expect(EnrichmentSettingsUpdate.safeParse(missing).success).toBe(false);
  });
  test('never carries an API key or token', () => {
    const p = EnrichmentSettingsUpdate.parse({ ...valid, claudeCodeOauthToken: 'sk-ant-oat-x', googlePlacesApiKey: 'k' });
    expect(p).not.toHaveProperty('claudeCodeOauthToken');
    expect(p).not.toHaveProperty('googlePlacesApiKey');
  });
});

describe('ManualSourceCreate', () => {
  test('title required and trimmed; URL, fields and notes optional', () => {
    expect(ManualSourceCreate.parse({ title: '  Companies House  ', sourceType: 'Public registry' })).toMatchObject({
      title: 'Companies House', sourceType: 'Public registry',
    });
    const full = ManualSourceCreate.parse({
      title: 'Clutch profile', url: 'clutch.co/profile/acme', sourceType: 'Business directory',
      fieldsPopulated: 'Employee range', notes: '  50-249 staff  ',
    });
    expect(full).toEqual({
      title: 'Clutch profile', url: 'https://clutch.co/profile/acme', sourceType: 'Business directory',
      fieldsPopulated: 'Employee range', notes: '50-249 staff',
    });
    expect(ManualSourceCreate.parse({ title: 'x', sourceType: 'Other', url: '', fieldsPopulated: ' ', notes: '' })).toMatchObject({
      url: null, fieldsPopulated: null, notes: null,
    });
  });
  test('rejects an empty title, an unknown type and an unsafe URL', () => {
    expect(ManualSourceCreate.safeParse({ title: '  ', sourceType: 'Other' }).success).toBe(false);
    expect(ManualSourceCreate.safeParse({ title: 'x'.repeat(201), sourceType: 'Other' }).success).toBe(false);
    expect(ManualSourceCreate.safeParse({ title: 'x', sourceType: 'Manual research' }).success).toBe(false);
    expect(ManualSourceCreate.safeParse({ title: 'x', sourceType: 'Other', url: 'javascript:alert(1)' }).success).toBe(false);
  });
});
