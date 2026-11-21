import type { Role } from './roles.js';

export type Action =
  | 'manage_users' | 'manage_lookups' | 'manage_allocation' | 'view_all_leads'
  | 'transfer_leads' | 'manage_quotes' | 'use_email' | 'manage_prospects'
  | 'view_admin_settings' | 'manage_companies' | 'view_all_companies';

export const ACTIONS: readonly Action[] = [
  'manage_users', 'manage_lookups', 'manage_allocation', 'view_all_leads',
  'transfer_leads', 'manage_quotes', 'use_email', 'manage_prospects', 'view_admin_settings',
  'manage_companies', 'view_all_companies',
];

export const RIGHTS: Record<Role, ReadonlySet<Action>> = {
  Administrator: new Set(ACTIONS),
  Manager: new Set(ACTIONS.filter((a) => a !== 'manage_users' && a !== 'manage_lookups')),
  'Sales Representative': new Set<Action>(['use_email', 'manage_quotes', 'manage_companies']),
  'Data Research User': new Set<Action>(['manage_prospects', 'manage_companies', 'view_all_companies']),
};

export function can(role: Role, action: Action): boolean {
  return RIGHTS[role]?.has(action) ?? false;
}
