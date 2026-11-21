import { useQuery } from '@tanstack/react-query';
import type { Action, LookupGroup, Role } from '@dait-crm/shared';
import { api } from './client';
import type { CompanyListQuery, DuplicateInput } from './companies';

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

export type SystemMailbox = {
  account: { address: string; sendAs: string | null; status: string; lastError: string | null; updatedAt: string } | null;
  pendingJobs: number;
  failedJobs: number;
  /** Running for over 15 minutes: interrupted mid-send, can be retried. */
  staleJobs: number;
};

export type JobSummary = {
  id: number;
  type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  createdAt: string;
  payloadSummary: { to?: string[]; subject?: string };
};

/** A job an administrator can retry: failed, or interrupted (stale running). */
export type RetryableJob = JobSummary & { interrupted: boolean };

export type AuthOptions = { localLogin: boolean; testLogin: boolean };

export const keys = {
  me: ['me'] as const,
  authOptions: ['auth-options'] as const,
  users: ['users'] as const,
  lookups: ['lookups'] as const,
  lookupGroup: (group: string) => ['lookups', group, 'all'] as const,
  allocation: ['allocation-rules'] as const,
  systemMailbox: ['mailboxes', 'system'] as const,
  failedEmailJobs: ['jobs', 'send_email', 'failed'] as const,
  /** Prefix of every company query: invalidate this after any company write. */
  companiesAll: ['companies'] as const,
  companies: (query: CompanyListQuery) => ['companies', 'list', query] as const,
  company: (id: number) => ['companies', 'detail', id] as const,
  companyDuplicates: (input: DuplicateInput) => ['companies', 'duplicates', input] as const,
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

export function useSystemMailbox() {
  return useQuery({ queryKey: keys.systemMailbox, queryFn: () => api<SystemMailbox>('/api/mailboxes/system') });
}

export function useFailedEmailJobs() {
  return useQuery({
    queryKey: keys.failedEmailJobs,
    queryFn: async (): Promise<RetryableJob[]> => {
      const [stale, failed] = await Promise.all([
        api<{ items: JobSummary[] }>('/api/jobs?status=stale&type=send_email'),
        api<{ items: JobSummary[] }>('/api/jobs?status=failed&type=send_email'),
      ]);
      return [
        ...stale.items.map((j) => ({ ...j, interrupted: true })),
        ...failed.items.map((j) => ({ ...j, interrupted: false })),
      ];
    },
  });
}
