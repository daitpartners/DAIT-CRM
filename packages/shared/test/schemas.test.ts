import { describe, it, expect } from 'vitest';
import {
  can, UserCreate, UserUpdate, PreferencesUpdate, LookupValueCreate, LookupValueUpdate,
  AllocationRuleCreate, LOOKUP_GROUPS, t, formatDate, lookupLabel,
} from '../src/index.js';

describe('rights', () => {
  it('matrix', () => {
    expect(can('Manager', 'manage_users')).toBe(false);
    expect(can('Manager', 'manage_lookups')).toBe(false);
    expect(can('Manager', 'transfer_leads')).toBe(true);
    expect(can('Administrator', 'manage_users')).toBe(true);
    expect(can('Administrator', 'view_admin_settings')).toBe(true);
    expect(can('Sales Representative', 'view_all_leads')).toBe(false);
    expect(can('Sales Representative', 'use_email')).toBe(true);
    expect(can('Sales Representative', 'manage_quotes')).toBe(true);
    expect(can('Data Research User', 'manage_prospects')).toBe(true);
    expect(can('Data Research User', 'use_email')).toBe(false);
    expect(can('Sales Representative', 'manage_companies')).toBe(true);
    expect(can('Sales Representative', 'view_all_companies')).toBe(false);
    expect(can('Data Research User', 'manage_companies')).toBe(true);
    expect(can('Data Research User', 'view_all_companies')).toBe(true);
    expect(can('Manager', 'view_all_companies')).toBe(true);
    for (const role of ['Administrator', 'Manager', 'Sales Representative', 'Data Research User'] as const) {
      expect(can(role, 'manage_leads')).toBe(true);
    }
    expect(can('Sales Representative', 'claim_leads')).toBe(true);
    expect(can('Manager', 'claim_leads')).toBe(true);
    expect(can('Data Research User', 'claim_leads')).toBe(false);
    expect(can('Data Research User', 'view_all_leads')).toBe(false);
  });
});

describe('user schemas', () => {
  it('normalises email and applies defaults', () => {
    const u = UserCreate.parse({ email: ' A@B.com ', name: 'A', role: 'Manager' });
    expect(u.email).toBe('a@b.com');
    expect(u.language).toBe('en');
    expect(u.timezone).toBe('Europe/London');
  });
  it('rejects bad input', () => {
    expect(UserCreate.safeParse({ email: 'x', name: 'A', role: 'Manager' }).success).toBe(false);
    expect(UserCreate.safeParse({ email: 'a@b.com', name: '', role: 'Manager' }).success).toBe(false);
    expect(UserCreate.safeParse({ email: 'a@b.com', name: 'A', role: 'Boss' }).success).toBe(false);
    expect(UserCreate.safeParse({ email: 'a@b.com', name: 'A', role: 'Manager', timezone: 'Mars/Base' }).success).toBe(false);
    expect(UserCreate.safeParse({ email: 'a@b.com', name: 'A', role: 'Manager', timezone: 'UTC' }).success).toBe(true);
  });
  it('update is partial with isActive and no defaults injected', () => {
    expect(UserUpdate.parse({ isActive: false })).toEqual({ isActive: false });
  });
  it('preferences', () => {
    expect(PreferencesUpdate.safeParse({ language: 'fr', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY' }).success).toBe(true);
    expect(PreferencesUpdate.safeParse({ language: 'de', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY' }).success).toBe(false);
  });
});

describe('lookup schemas', () => {
  it('has 15 groups', () => expect(LOOKUP_GROUPS).toHaveLength(15));
  it('validates', () => {
    expect(LookupValueCreate.safeParse({ group: 'lead_source', value: 'web', label: 'Web' }).success).toBe(true);
    expect(LookupValueCreate.safeParse({ group: 'nope', value: 'web', label: 'Web' }).success).toBe(false);
    expect(LookupValueCreate.safeParse({ group: 'currency', value: '', label: 'x' }).success).toBe(false);
    expect(LookupValueUpdate.safeParse({ label: 'New', sortOrder: 3 }).success).toBe(true);
  });
});

describe('AllocationRuleCreate', () => {
  const base = { name: 'R', matchCountries: ['IN'], assignTo: 1, priority: 0 };
  it('accepts valid', () => {
    expect(AllocationRuleCreate.safeParse(base).success).toBe(true);
    expect(AllocationRuleCreate.safeParse({ ...base, matchCountries: ['*'], assignTo: [1, 2] }).success).toBe(true);
  });
  it('rejects empties and negatives', () => {
    expect(AllocationRuleCreate.safeParse({ ...base, matchCountries: [] }).success).toBe(false);
    expect(AllocationRuleCreate.safeParse({ ...base, assignTo: [] }).success).toBe(false);
    expect(AllocationRuleCreate.safeParse({ ...base, priority: -1 }).success).toBe(false);
  });
});

describe('i18n', () => {
  it('t interpolates and falls back', () => {
    expect(t({ 'Hello {name}': 'Hola {name}' }, 'Hello {name}', { name: 'Ana' })).toBe('Hola Ana');
    expect(t({}, 'Hi {name}', { name: 'Bo' })).toBe('Hi Bo');
    expect(t({}, 'Plain')).toBe('Plain');
  });
  it('formatDate', () => {
    const d = '2026-11-21T10:00:00Z';
    expect(formatDate(d, { locale: 'en', timezone: 'Asia/Kolkata', dateFormat: 'DD MMM YYYY' })).toBe('21 Nov 2026');
    expect(formatDate(d, { locale: 'en', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY' })).toBe('21/11/2026');
    expect(formatDate(new Date(d), { locale: 'en', timezone: 'UTC', dateFormat: 'MM/DD/YYYY' })).toBe('11/21/2026');
  });
  it('formatDate honours timezone day boundary', () => {
    expect(formatDate('2026-11-21T20:00:00Z', { locale: 'en', timezone: 'Asia/Kolkata', dateFormat: 'DD/MM/YYYY' })).toBe('22/11/2026');
  });
  it('lookupLabel', () => {
    expect(lookupLabel({ label: 'New', labelEs: 'Nuevo' }, 'fr')).toBe('New');
    expect(lookupLabel({ label: 'New', labelEs: 'Nuevo' }, 'es')).toBe('Nuevo');
    expect(lookupLabel({ label: 'New', labelFr: null }, 'fr')).toBe('New');
    expect(lookupLabel({ label: 'New' }, 'en')).toBe('New');
  });
});
