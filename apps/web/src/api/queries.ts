import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { lookupLabel } from '@dait-crm/shared';
import type { Action, LookupGroup, Role } from '@dait-crm/shared';
import { api } from './client';
import type { CompanyListQuery, DuplicateInput } from './companies';
import type { ContactDuplicateInput, ContactListQuery } from './contacts';
import type { LeadListQuery } from './leads';
import type { QuotationListQuery } from './quotations';
import type { TaskListQuery } from './tasks';

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
  matchLanguage: 'en' | 'es' | null;
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
  /** Under the companies prefix: a company write may change its locations' context. */
  locations: (companyId: number) => ['companies', 'locations', companyId] as const,
  /** Prefix of every contact query: invalidate this after any contact write. */
  contactsAll: ['contacts'] as const,
  contacts: (query: ContactListQuery) => ['contacts', 'list', query] as const,
  contactDuplicates: (input: ContactDuplicateInput) => ['contacts', 'duplicates', input] as const,
  /** Prefix of every lead query: invalidate this after any lead write. */
  leadsAll: ['leads'] as const,
  leads: (query: LeadListQuery) => ['leads', 'list', query] as const,
  leadDuplicates: (input: DuplicateInput) => ['leads', 'duplicates', input] as const,
  /** A lead page (detail, activities page 1, assignments, open tasks); prefix of its later activity pages. */
  lead: (id: number) => ['leads', 'detail', id] as const,
  leadActivities: (id: number, page: number) => ['leads', 'detail', id, 'activities', page] as const,
  /** Activities across a company's leads: under the leads prefix so any lead write refreshes it. */
  companyActivities: (companyId: number, page: number) => ['leads', 'company-activities', companyId, page] as const,
  /** A company's lead counts by status: under the leads prefix so any lead write refreshes it. */
  companyPipeline: (companyId: number) => ['leads', 'company-pipeline', companyId] as const,
  /** Prefix of every task query: a lead write can create, move or close tasks. */
  tasksAll: ['tasks'] as const,
  tasks: (query: TaskListQuery) => ['tasks', 'list', query] as const,
  /** Sidebar badges: under the tasks prefix so task and lead writes refresh them (notification reads refresh it too). */
  navCounts: ['tasks', 'nav-counts'] as const,
  /** The dashboard: under the tasks prefix so task and lead writes refresh it. */
  dashboard: ['tasks', 'dashboard'] as const,
  /** Prefix of every quotation query: invalidate this after any quotation write. */
  quotationsAll: ['quotations'] as const,
  quotations: (query: QuotationListQuery) => ['quotations', 'list', query] as const,
  quotation: (id: number) => ['quotations', 'detail', id] as const,
  /** Prefix of every notification query. */
  notificationsAll: ['notifications'] as const,
  notifications: (page: number) => ['notifications', 'list', page] as const,
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

/** `(group, value) => label` in the user's language; an unknown (retired or free-text) value shows as stored. */
export function useLookupText(lang: Lang) {
  const { data: lookups } = useLookups();
  return useCallback(
    (group: LookupGroup, value: string | null | undefined): string | null => {
      if (!value) return null;
      const row = lookups?.[group]?.find((x) => x.value === value);
      return row ? lookupLabel(row, lang) : value;
    },
    [lookups, lang],
  );
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
