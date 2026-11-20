import type { Role } from './roles.js';

export type Action =
  | 'manage_users' | 'manage_lookups' | 'manage_allocation' | 'view_all_leads'
  | 'transfer_leads' | 'manage_quotes' | 'use_email' | 'manage_prospects'
  | 'view_admin_settings';

const ALL: readonly Action[] = [
  'manage_users', 'manage_lookups', 'manage_allocation', 'view_all_leads',
  'transfer_leads', 'manage_quotes', 'use_email', 'manage_prospects', 'view_admin_settings',
];

export const RIGHTS: Record<Role, ReadonlySet<Action>> = {
  Administrator: new Set(ALL),
  Manager: new Set(ALL.filter((a) => a !== 'manage_users' && a !== 'manage_lookups')),
  'Sales Representative': new Set<Action>(['use_email', 'manage_quotes']),
  'Data Research User': new Set<Action>(['manage_prospects']),
};

export function can(role: Role, action: Action): boolean {
  return RIGHTS[role]?.has(action) ?? false;
}
