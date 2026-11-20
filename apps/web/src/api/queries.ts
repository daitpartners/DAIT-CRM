import { useQuery } from '@tanstack/react-query';
import type { Action, LookupGroup, Role } from '@dait-crm/shared';
import { api } from './client';

export type Lang = 'en' | 'es' | 'fr';

export type Me = {
  id: number;
  email: string;
  name: string;
  role: Role;
  language: Lang;
  timezone: string;
  dateFormat: string;
  rights: Action[];
};

export type UserSummary = {
  id: number;
  email: string;
  name: string;
  role: Role;
  language: Lang;
  timezone: string;
  isActive: boolean;
  lastLoginAt: string | null;
};

export type LookupValue = {
  id: number;
  group: LookupGroup;
  value: string;
  label: string;
  labelEs: string | null;
  labelFr: string | null;
  sortOrder: number;
  isActive: boolean;
};

export type AllocationRule = {
  id: number;
  name: string;
  matchCountries: string[];
  assignTo: number | number[];
  priority: number;
  isActive: boolean;
  roundRobinPos: number;
};

export type AuthOptions = { localLogin: boolean; testLogin: boolean };

export const keys = {
  me: ['me'] as const,
  authOptions: ['auth-options'] as const,
  users: ['users'] as const,
  lookups: ['lookups'] as const,
  lookupGroup: (group: string) => ['lookups', group, 'all'] as const,
  allocation: ['allocation-rules'] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Me>('/api/me', { noAuthRedirect: true }) });
}

export function useAuthOptions() {
  return useQuery({ queryKey: keys.authOptions, queryFn: () => api<AuthOptions>('/api/auth/options') });
}

export function useUsers() {
  return useQuery({
    queryKey: keys.users,
    queryFn: async () => (await api<{ items: UserSummary[] }>('/api/users')).items,
  });
}

export function useLookups() {
  return useQuery({
    queryKey: keys.lookups,
    queryFn: async () => (await api<{ groups: Record<LookupGroup, LookupValue[]> }>('/api/lookups')).groups,
  });
}

export function useLookupGroup(group: LookupGroup) {
  return useQuery({
    queryKey: keys.lookupGroup(group),
    queryFn: async () =>
      (await api<{ items: LookupValue[] }>(`/api/lookups?group=${encodeURIComponent(group)}&all=1`)).items,
  });
}

export function useAllocationRules() {
  return useQuery({
    queryKey: keys.allocation,
    queryFn: async () => (await api<{ items: AllocationRule[] }>('/api/allocation-rules')).items,
  });
}
