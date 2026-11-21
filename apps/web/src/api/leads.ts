import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CompanyMatchHow, CsvField, CsvMapping, CsvSuggestedMapping, LEAD_SORTS, LEAD_TABS, LeadBulk, LeadCreate, LeadType, LeadUpdate,
  Priority,
} from '@dait-crm/shared';
import { api } from './client';
import { keys } from './queries';

export type LeadSort = (typeof LEAD_SORTS)[number];
export type LeadTab = (typeof LEAD_TABS)[number];
type Ref = { id: number; name: string };

/** A row in `GET /api/leads` (`leadSummary` in apps/api/src/leads/serialize.ts). */
export type LeadSummary = {
  id: number;
  number: string;
  leadType: LeadType;
  companyName: string;
  companyId: number | null;
  company: { id: number; number: string; name: string } | null;
  contact: { id: number; name: string; email: string | null; linkedinUrl: string | null } | null;
  country: string;
  city: string | null;
  leadSource: string;
  status: string;
  priority: Priority;
  assignedTo: Ref | null;
  /** YYYY-MM-DD */
  nextFollowUp: string | null;
  isOverdue: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `GET /api/leads/:id` and every lead write (`leadDetail`); the page adds activities, assignments and tasks. */
export type LeadDetail = Omit<LeadSummary, 'company' | 'contact'> & {
  website: string | null;
  businessEmail: string | null;
  phone: string | null;
  sourceUrl: string | null;
  importBatch: string | null;
  notes: string | null;
  contactId: number | null;
  assignedToId: number | null;
  company: {
    id: number; number: string; name: string; industry: string | null; city: string | null; country: string;
    employeeRange: string | null; isClient: boolean; verificationStatus: string | null; contactCount: number; openLeadCount: number;
  } | null;
  contact: {
    id: number; name: string; firstName: string; lastName: string; designation: string | null; email: string | null;
    phone: string | null; mobile: string | null; linkedinUrl: string | null; isActive: boolean;
  } | null;
  createdBy: Ref | null;
};

/** `GET /api/leads` parameters; anything left out takes the API default (page 1, 25 rows, newest first). */
export type LeadListQuery = {
  page?: number;
  pageSize?: number;
  sort?: LeadSort;
  dir?: 'asc' | 'desc';
  q?: string;
  tab?: LeadTab;
  status?: string;
  source?: string;
  country?: string;
  /** A user id, or 'none' for unassigned leads. */
  assignedTo?: number | 'none';
  leadType?: LeadType;
  priority?: Priority;
  /** Created on or after / on or before (YYYY-MM-DD). */
  from?: string;
  to?: string;
};

export type LeadTiles = {
  newThisWeek: number;
  newThisWeekFromWebsite: number;
  followUpsDueToday: number;
  overdue: number;
  unassigned: number;
};

export type LeadPage = {
  items: LeadSummary[];
  total: number;
  page: number;
  pageSize: number;
  tiles: LeadTiles;
  counts: Record<LeadTab, number>;
};

export function leadListPath(query: LeadListQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  return `/api/leads?${params.toString()}`;
}

export function useLeads(query: LeadListQuery, enabled = true) {
  return useQuery({
    queryKey: keys.leads(query),
    queryFn: () => api<LeadPage>(leadListPath(query)),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** A lead write can touch tasks (follow-up, review task) and companies (new or linked company). */
function useInvalidateAfterLeadWrite() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: keys.leadsAll }),
      qc.invalidateQueries({ queryKey: keys.tasksAll }),
      qc.invalidateQueries({ queryKey: keys.companiesAll }),
      qc.invalidateQueries({ queryKey: keys.contactsAll }),
    ]);
}

/** Create (no `id`) or update a lead's details. */
export function useSaveLead() {
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: (v: { id?: number; body: LeadCreate | LeadUpdate }) =>
      v.id
        ? api<LeadDetail>(`/api/leads/${v.id}`, { method: 'PATCH', body: v.body })
        : api<LeadDetail>('/api/leads', { method: 'POST', body: v.body }),
    onSuccess: refresh,
  });
}

export function useBulkLeads() {
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: (body: LeadBulk) => api<{ updated: number }>('/api/leads/bulk', { method: 'POST', body }),
    onSuccess: refresh,
  });
}

/** Takes an unassigned lead (`claim_leads`). */
export function useClaimLead() {
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: (lead: Pick<LeadSummary, 'id' | 'updatedAt'>) =>
      api<LeadDetail>(`/api/leads/${lead.id}/claim`, { method: 'POST', body: { updatedAt: lead.updatedAt } }),
    onSuccess: refresh,
  });
}

/* ------------------------------------------------------------------ CSV import */

export type CsvPreviewResult = {
  headers: string[];
  sample: string[][];
  rowCount: number;
  suggestedMapping: CsvSuggestedMapping;
};

export type CsvImportResult = {
  batch: string;
  created: number;
  linked: number;
  review: {
    row: number;
    leadId: number;
    companyName: string;
    candidates: { id: number; number: string; name: string; how: CompanyMatchHow }[];
  }[];
  errors: { row: number; message: string }[];
};

export type { CsvField, CsvMapping };

export function useCsvPreview() {
  return useMutation({
    mutationFn: (csv: string) => api<CsvPreviewResult>('/api/imports/leads/preview', { method: 'POST', body: { csv } }),
  });
}

export function useCsvImport() {
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: (body: { csv: string; mapping: CsvMapping; leadSource?: string; assignedToId?: number | null }) =>
      api<CsvImportResult>('/api/imports/leads', { method: 'POST', body }),
    onSuccess: refresh,
  });
}
