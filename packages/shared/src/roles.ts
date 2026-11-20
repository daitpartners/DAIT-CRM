export const ROLES = ['Administrator', 'Manager', 'Sales Representative', 'Data Research User'] as const;
export type Role = (typeof ROLES)[number];

export type RoleEnum = 'ADMINISTRATOR' | 'MANAGER' | 'SALES_REPRESENTATIVE' | 'DATA_RESEARCH_USER';

const LABEL_BY_ENUM: Record<RoleEnum, Role> = {
  ADMINISTRATOR: 'Administrator',
  MANAGER: 'Manager',
  SALES_REPRESENTATIVE: 'Sales Representative',
  DATA_RESEARCH_USER: 'Data Research User',
};

const ENUM_BY_LABEL: Record<Role, RoleEnum> = {
  Administrator: 'ADMINISTRATOR',
  Manager: 'MANAGER',
  'Sales Representative': 'SALES_REPRESENTATIVE',
  'Data Research User': 'DATA_RESEARCH_USER',
};

export function roleLabel(r: RoleEnum): Role {
  return LABEL_BY_ENUM[r];
}

export function roleEnum(label: Role): RoleEnum {
  return ENUM_BY_LABEL[label];
}
