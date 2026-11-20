export const ROLES = ['Administrator', 'Manager', 'Sales Representative', 'Data Research User'] as const;
export type Role = (typeof ROLES)[number];
