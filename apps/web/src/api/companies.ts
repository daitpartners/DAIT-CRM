import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { COMPANY_SORTS, CompanyMatchHow, CompanyStatus } from '@dait-crm/shared';
import { useDebounce } from '../hooks/useDebounce';
import { api } from './client';
import { keys } from './queries';

/** Same object as `keys` in ./queries, re-exported so company code can import keys from here. */
export { keys };

export type CompanySort = (typeof COMPANY_SORTS)[number];
export type SortDir = 'asc' | 'desc';

/** A row in `GET /api/companies`. */
export type CompanySummary = {
  id: number;
  number: string;
  name: string;
  domain: string | null;
  industry: string | null;
  country: string;
  city: string | null;
  status: CompanyStatus;
  isClient: boolean;
  primaryContact: { id: number; name: string; businessEmail: string | null } | null;
  contactCount: number;
  updatedAt: string;
};

/** `GET /api/companies/:id`: every column plus the summary's contact fields and who created it. */
export type CompanyDetail = CompanySummary & {
  legalName: string | null;
  website: string | null;
  businessEmail: string | null;
  businessCategory: string | null;
  businessType: string | null;
  yearEstablished: number | null;
  description: string | null;
  linkedinUrl: string | null;
  state: string | null;
  street: string | null;
  zip: string | null;
  timezone: string | null;
  lat: number | null;
  lng: number | null;
  employeeCount: number | null;
  employeeRange: string | null;
  annualRevenue: number | null;
  revenueCurrency: string | null;
  revenueRange: string | null;
  ownershipType: string | null;
  registrationNumber: string | null;
  stockExchange: string | null;
  stockSymbol: string | null;
  mainProducts: string | null;
  mainServices: string | null;
  businessVerticals: string[];
  targetMarkets: string[];
  geographicMarkets: string[];
  keyBrands: string | null;
  specialisation: string | null;
  socialFacebook: string | null;
  socialInstagram: string | null;
  socialX: string | null;
  socialYoutube: string | null;
  socialOther: string | null;
  createdAt: string;
  createdBy: { id: number; name: string } | null;
};

/** `GET /api/companies` parameters; anything left out takes the API default (page 1, 25 rows, name ascending). */
export type CompanyListQuery = {
  page?: number;
  pageSize?: number;
  sort?: CompanySort;
  dir?: SortDir;
  q?: string;
  status?: CompanyStatus;
  country?: string;
  industry?: string;
  isClient?: boolean;
};

export type CompanyPage = { items: CompanySummary[]; total: number; page: number; pageSize: number };

/** A duplicate candidate; a company the user may not open carries only id, number and name. */
export type DuplicateCandidate = {
  id: number;
  number: string;
  name: string;
  legalName?: string | null;
  domain?: string | null;
  country?: string | null;
  city?: string | null;
};

export type DuplicateResult = {
  auto: DuplicateCandidate | null;
  review: { candidate: DuplicateCandidate; how: CompanyMatchHow }[];
};

export type DuplicateInput = {
  name?: string;
  website?: string;
  businessEmail?: string;
  legalName?: string;
  country?: string;
  excludeId?: number;
};

/** Builds the `GET /api/companies` query string, leaving out empty filters. */
export function companyListPath(query: CompanyListQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  return `/api/companies?${params.toString()}`;
}

export function useCompanies(query: CompanyListQuery) {
  return useQuery({
    queryKey: keys.companies(query),
    queryFn: () => api<CompanyPage>(companyListPath(query)),
    placeholderData: keepPreviousData,
  });
}

export function useCompany(id: number) {
  return useQuery({
    queryKey: keys.company(id),
    queryFn: () => api<CompanyDetail>(`/api/companies/${id}`),
    enabled: Number.isInteger(id),
  });
}

/** Drops blank values so `{ name: '' }` and `{}` share a cache entry and send the same body. */
function compact(input: DuplicateInput): DuplicateInput {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' ? v.trim() !== '' : v !== undefined) out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as DuplicateInput;
}

/**
 * Live duplicate check, debounced 400 ms after the last keystroke. `scope: 'leads'` asks the lead
 * endpoint, which also reports companies the user may not open (number and name only).
 */
export function useDuplicateCheck(input: DuplicateInput, enabled: boolean, scope: 'companies' | 'leads' = 'companies') {
  // Debounce the serialised input: a fresh object every render would restart the timer forever.
  const json = useDebounce(JSON.stringify(compact(input)), 400);
  const debounced = useMemo(() => JSON.parse(json) as DuplicateInput, [json]);
  const hasKey = Boolean(debounced.name || debounced.website || debounced.businessEmail || debounced.legalName);
  return useQuery({
    queryKey: scope === 'leads' ? keys.leadDuplicates(debounced) : keys.companyDuplicates(debounced),
    queryFn: () => api<DuplicateResult>(`/api/${scope}/check-duplicates`, { method: 'POST', body: debounced }),
    enabled: enabled && hasKey,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
