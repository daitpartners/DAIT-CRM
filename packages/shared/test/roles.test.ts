import { test, expect } from 'vitest';
import { ROLES, roleEnum, roleLabel } from '../src/index';

test('roleEnum and roleLabel round-trip for every role', () => {
  for (const label of ROLES) expect(roleLabel(roleEnum(label))).toBe(label);
  expect(roleEnum('Sales Representative')).toBe('SALES_REPRESENTATIVE');
  expect(roleLabel('DATA_RESEARCH_USER')).toBe('Data Research User');
});
