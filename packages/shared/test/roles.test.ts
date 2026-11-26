import { test, expect } from 'vitest';
import { ROLES, can, roleEnum, roleLabel } from '../src/index';

test('roleEnum and roleLabel round-trip for every role', () => {
  for (const label of ROLES) expect(roleLabel(roleEnum(label))).toBe(label);
  expect(roleEnum('Sales Representative')).toBe('SALES_REPRESENTATIVE');
  expect(roleLabel('DATA_RESEARCH_USER')).toBe('Data Research User');
});

test('import rights: Administrators and Managers import, only Administrators undo', () => {
  expect(can('Administrator', 'import_leads')).toBe(true);
  expect(can('Manager', 'import_leads')).toBe(true);
  expect(can('Sales Representative', 'import_leads')).toBe(false);
  expect(can('Data Research User', 'import_leads')).toBe(false);
  expect(can('Administrator', 'undo_imports')).toBe(true);
  expect(can('Manager', 'undo_imports')).toBe(false);
  expect(can('Sales Representative', 'undo_imports')).toBe(false);
  expect(can('Data Research User', 'undo_imports')).toBe(false);
  expect(can('Manager', 'manage_users')).toBe(false);
  expect(can('Manager', 'manage_lookups')).toBe(false);
});

test('delete leads: Administrators only', () => {
  expect(can('Administrator', 'delete_leads')).toBe(true);
  expect(can('Manager', 'delete_leads')).toBe(false);
  expect(can('Sales Representative', 'delete_leads')).toBe(false);
  expect(can('Data Research User', 'delete_leads')).toBe(false);
});

test('view_team_mail: Administrators and Managers only', () => {
  expect(can('Administrator', 'view_team_mail')).toBe(true);
  expect(can('Manager', 'view_team_mail')).toBe(true);
  expect(can('Sales Representative', 'view_team_mail')).toBe(false);
  expect(can('Data Research User', 'view_team_mail')).toBe(false);
});
