import type { Role } from './roles.js';

export type Action =
  | 'manage_users' | 'manage_lookups' | 'manage_allocation' | 'view_all_leads'
  | 'transfer_leads' | 'manage_quotes' | 'use_email' | 'manage_prospects'
  | 'view_admin_settings' | 'manage_companies' | 'view_all_companies' | 'manage_leads' | 'claim_leads'
  | 'import_leads' | 'undo_imports' | 'delete_leads' | 'view_team_mail';

export const ACTIONS: readonly Action[] = [
  'manage_users', 'manage_lookups', 'manage_allocation', 'view_all_leads',
  'transfer_leads', 'manage_quotes', 'use_email', 'manage_prospects', 'view_admin_settings',
  'manage_companies', 'view_all_companies', 'manage_leads', 'claim_leads', 'import_leads', 'undo_imports',
  'delete_leads', 'view_team_mail',
];

/** Rights an Administrator has and a Manager does not. */
const ADMIN_ONLY: readonly Action[] = ['manage_users', 'manage_lookups', 'undo_imports', 'delete_leads'];

export const RIGHTS: Record<Role, ReadonlySet<Action>> = {
  Administrator: new Set(ACTIONS),
  Manager: new Set(ACTIONS.filter((a) => !ADMIN_ONLY.includes(a))),
  'Sales Representative': new Set<Action>(['use_email', 'manage_quotes', 'manage_companies', 'manage_leads', 'claim_leads']),
  'Data Research User': new Set<Action>(['manage_prospects', 'manage_companies', 'view_all_companies', 'manage_leads']),
};

export function can(role: Role, action: Action): boolean {
  return RIGHTS[role]?.has(action) ?? false;
}
