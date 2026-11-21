import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CONTACT_SORTS, ContactCreate, ContactMatchHow, ContactUpdate } from '@dait-crm/shared';
import { useDebounce } from '../hooks/useDebounce';
import { api } from './client';
import { keys } from './queries';

export type ContactSort = (typeof CONTACT_SORTS)[number];

/** A row in `GET /api/contacts`. */
export type ContactSummary = {
  id: number;
  companyId: number;
  company: { id: number; number: string; name: string };
  firstName: string;
  lastName: string;
  designation: string | null;
  department: string | null;
  businessEmail: string | null;
  phone: string | null;
  mobile: string | null;
  linkedinUrl: string | null;
  contactType: string;
  isPrimary: boolean;
  updatedAt: string;
};

/** `GET /api/contacts` parameters; anything left out takes the API default. */
export type ContactListQuery = {
  companyId?: number;
  page?: number;
  pageSize?: number;
  sort?: ContactSort;
  dir?: 'asc' | 'desc';
  q?: string;
  contactType?: string;
};

export type ContactPage = { items: ContactSummary[]; total: number; page: number; pageSize: number };

/** A duplicate candidate; one on a company the user may not open carries no email or phone keys. */
export type ContactCandidate = {
  id: number;
  companyId: number;
  firstName: string;
  lastName: string;
  businessEmail?: string | null;
};

export type ContactDuplicateResult = {
  auto: ContactCandidate | null;
  review: { candidate: ContactCandidate; how: ContactMatchHow }[];
};

export type ContactDuplicateInput = {
  businessEmail?: string;
  phone?: string;
  mobile?: string;
  firstName?: string;
  lastName?: string;
  companyId?: number;
  excludeId?: number;
};

export function contactListPath(query: ContactListQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  return `/api/contacts?${params.toString()}`;
}

export function useContacts(query: ContactListQuery, enabled = true) {
  return useQuery({
    queryKey: keys.contacts(query),
    queryFn: () => api<ContactPage>(contactListPath(query)),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Drops blank values so equivalent inputs share a cache entry and send the same body. */
function compact(input: ContactDuplicateInput): ContactDuplicateInput {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' ? v.trim() !== '' : v !== undefined) out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as ContactDuplicateInput;
}

/** Live contact duplicate check (email, then phone, then name at the company), debounced 400 ms. */
export function useContactDuplicateCheck(input: ContactDuplicateInput, enabled: boolean) {
  const json = useDebounce(JSON.stringify(compact(input)), 400);
  const debounced = useMemo(() => JSON.parse(json) as ContactDuplicateInput, [json]);
  const hasKey = Boolean(
    debounced.businessEmail || debounced.phone || debounced.mobile || (debounced.firstName && debounced.lastName && debounced.companyId),
  );
  return useQuery({
    queryKey: keys.contactDuplicates(debounced),
    queryFn: () => api<ContactDuplicateResult>('/api/contacts/check-duplicates', { method: 'POST', body: debounced }),
    enabled: enabled && hasKey,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Create (no `id`) or update a contact; refreshes contact lists and the company (primary contact, count). */
export function useSaveContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id?: number; body: ContactCreate | ContactUpdate }) =>
      v.id
        ? api<ContactSummary>(`/api/contacts/${v.id}`, { method: 'PATCH', body: v.body })
        : api<ContactSummary>('/api/contacts', { method: 'POST', body: v.body }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.contactsAll }),
        qc.invalidateQueries({ queryKey: keys.companiesAll }),
      ]);
    },
  });
}
