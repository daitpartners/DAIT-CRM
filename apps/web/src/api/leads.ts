import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivityType, CallOutcome, CompanyMatchHow, CsvField, CsvMapping, CsvSuggestedMapping, LEAD_SORTS, LEAD_TABS, LeadBulk, LeadCreate, LeadType, LeadUpdate,
  Priority,
} from '@dait-crm/shared';
import { ApiError, api } from './client';
import type { ContactProfileView } from './contacts';
import { keys } from './queries';
import type { TaskRow } from './tasks';

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
  outreachLanguage: 'en' | 'es';
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
  /** Release 2C: opted out; the Mailer skips this lead. */
  doNotEmail?: boolean;
  /** The contact unsubscribed (through this or another lead); Do not email shows when this or `doNotEmail` is set. */
  contactUnsubscribed?: boolean;
  contactId: number | null;
  assignedToId: number | null;
  company: {
    id: number; number: string; name: string; industry: string | null; city: string | null; country: string;
    employeeRange: string | null; isClient: boolean; verificationStatus: string | null; contactCount: number; openLeadCount: number;
    legalName: string | null; website: string | null; domain: string | null; businessCategory: string | null; timezone: string | null;
    /** The lead page's AI line (release 4). */
    aiResearchStatus?: string; aiSummary?: string | null; aiConfidence?: string | null;
  } | null;
  /** The contact's full profile (`contactProfile`) plus `name` / `email` kept for the older screens. */
  contact: (ContactProfileView & { name: string; email: string | null }) | null;
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
  language?: 'en' | 'es';
  /** A user id, or 'none' for unassigned leads. */
  assignedTo?: number | 'none';
  leadType?: LeadType;
  priority?: Priority;
  /** Created on or after / on or before (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** Leads of this company. */
  companyId?: number;
  /** '1' keeps open leads only (not Won, Lost or Not Relevant). */
  open?: '1';
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

/** A timeline entry (`activityRow`). `by: null` = system. */
export type ActivityRow = {
  id: number;
  leadId: number;
  activityType: ActivityType | string;
  title: string;
  body: string | null;
  url: string | null;
  statusFrom: string | null;
  statusTo: string | null;
  relatedType: string | null;
  relatedId: number | null;
  by: Ref | null;
  occurredAt: string;
};

/** An assignment history row (`assignmentRow`). `to: null` = unassigned; `by: null` = rule / system. */
export type AssignmentRow = {
  id: number;
  leadId: number;
  from: Ref | null;
  to: Ref | null;
  by: Ref | null;
  rule: Ref | null;
  note: string | null;
  assignedAt: string;
};

/** `GET /api/leads/:id`: the lead, its newest activities (15 per page), assignment history and open tasks. */
export type LeadFull = LeadDetail & {
  activities: ActivityRow[];
  activityTotal: number;
  /** All `call` activities on the lead (the "Calls" tab count). */
  callCount: number;
  /** The newest call, email or meeting, for "Last contact: {type · when}". */
  lastContact: { type: string; at: string } | null;
  assignments: AssignmentRow[];
  tasks: TaskRow[];
};

/** Activities shown per page on the lead page (the API's page size). */
export const LEAD_ACTIVITY_PAGE_SIZE = 15;

export function useLead(id: number) {
  return useQuery({
    queryKey: keys.lead(id),
    queryFn: () => api<LeadFull>(`/api/leads/${id}`),
    enabled: Number.isInteger(id),
  });
}

/** Activity pages 2..`pages` of a lead ("Show earlier"); page 1 comes with `useLead`. */
export function useEarlierActivities(id: number, pages: number) {
  return useQueries({
    queries: Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2).map((page) => ({
      queryKey: keys.leadActivities(id, page),
      queryFn: async () => (await api<LeadFull>(`/api/leads/${id}?activitiesPage=${page}`)).activities,
      placeholderData: keepPreviousData,
    })),
  });
}

export type CompanyActivity = ActivityRow & { lead: { id: number; number: string } };
/** Counts across every page of the company's activities, and the last touch (the prototype's "Activity summary"). */
export type CompanyActivitySummary = { call: number; email: number; meeting: number; quote: number; lastAt: string | null };
export type CompanyActivityPage = {
  items: CompanyActivity[];
  total: number;
  page: number;
  pageSize: number;
  summary: CompanyActivitySummary;
};
export const COMPANY_ACTIVITY_PAGE_SIZE = 20;

/** Activities across the company's leads the user may see, newest first. */
export function useCompanyActivities(companyId: number, page: number) {
  return useQuery({
    queryKey: keys.companyActivities(companyId, page),
    queryFn: () =>
      api<CompanyActivityPage>(`/api/companies/${companyId}/activities?page=${page}&pageSize=${COMPANY_ACTIVITY_PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });
}

/**
 * Refusals that mean "your view of the lead (or task) is out of date": someone else changed, claimed,
 * linked, archived, closed or hid it since it was loaded, or already ticked the task.
 */
export const OUT_OF_DATE_CODES: ReadonlySet<string> = new Set([
  'stale', 'already_assigned', 'company_already_linked', 'lead_archived', 'lead_closed', 'not_found', 'task_done',
]);

/**
 * After an out-of-date refusal: refetch leads and tasks so the page shows the lead as it is now
 * (a Claim button or Choose-company box that no longer applies goes away) and a retry carries the
 * fresh `updatedAt`. Every lead mutation calls this from onError (the task list's tick / snooze too).
 */
export function useRefreshWhenOutOfDate() {
  const qc = useQueryClient();
  return (err: unknown) => {
    if (!(err instanceof ApiError) || !OUT_OF_DATE_CODES.has(err.code)) return;
    void qc.invalidateQueries({ queryKey: keys.leadsAll });
    void qc.invalidateQueries({ queryKey: keys.tasksAll });
  };
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
  const qc = useQueryClient();
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: (v: { id?: number; body: LeadCreate | LeadUpdate }) =>
      v.id
        ? api<LeadDetail>(`/api/leads/${v.id}`, { method: 'PATCH', body: v.body })
        : api<LeadDetail>('/api/leads', { method: 'POST', body: v.body }),
    onSuccess: (saved) => {
      qc.setQueryData<LeadFull>(keys.lead(saved.id), (old) => (old ? { ...old, ...saved } : old));
      return refresh();
    },
    onError: useRefreshWhenOutOfDate(),
  });
}

export function useBulkLeads() {
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: (body: LeadBulk) => api<{ updated: number }>('/api/leads/bulk', { method: 'POST', body }),
    onSuccess: refresh,
    onError: useRefreshWhenOutOfDate(),
  });
}

/** Takes an unassigned lead (`claim_leads`). */
export function useClaimLead() {
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: (lead: Pick<LeadSummary, 'id' | 'updatedAt'>) =>
      api<LeadDetail>(`/api/leads/${lead.id}/claim`, { method: 'POST', body: { updatedAt: lead.updatedAt } }),
    onSuccess: refresh,
    onError: useRefreshWhenOutOfDate(),
  });
}

/** Bodies of the lead page's POST actions (`POST /api/leads/:id/<action>`); `updatedAt` is added from the lead. */
export type LeadActionBody = {
  status: { status: string; reason?: string };
  'log-call': { outcome: CallOutcome; minutes?: number; body?: string; statusAfter?: string; nextFollowUp?: string | null };
  contact: { contactId: number | null };
  archive: Record<string, never>;
  unarchive: Record<string, never>;
  transfer: { toUserId: number; note?: string };
  claim: Record<string, never>;
  unassign: { note: string };
  'resolve-company': { companyId: number | 'create' };
};
export type LeadAction = keyof LeadActionBody;
export type LeadActionInput = {
  [A in LeadAction]: { lead: Pick<LeadDetail, 'id' | 'updatedAt'>; action: A; body: LeadActionBody[A] };
}[LeadAction];

/**
 * One of the lead page's actions. On success the returned lead (with its new `updatedAt`) goes
 * straight into the page's cache, so a second action right after does not read as stale.
 */
export function useLeadAction() {
  const qc = useQueryClient();
  const refresh = useInvalidateAfterLeadWrite();
  return useMutation({
    mutationFn: ({ lead, action, body }: LeadActionInput) =>
      api<LeadDetail>(`/api/leads/${lead.id}/${action}`, { method: 'POST', body: { ...body, updatedAt: lead.updatedAt } }),
    onSuccess: (saved) => {
      qc.setQueryData<LeadFull>(keys.lead(saved.id), (old) => (old ? { ...old, ...saved } : old));
      return refresh();
    },
    onError: useRefreshWhenOutOfDate(),
  });
}

/** Bodies of the compose panel's notes (`POST /api/leads/:id/research|meeting`); `updatedAt` is added from the lead. */
export type LeadNoteInput =
  | { lead: Pick<LeadDetail, 'id' | 'updatedAt'>; kind: 'research'; body: { title: string; url?: string; body?: string } }
  | { lead: Pick<LeadDetail, 'id' | 'updatedAt'>; kind: 'meeting'; body: { title: string; occurredAt: string; body?: string } };

/**
 * A research or meeting note: one activity on the timeline. The API answers with the activity (201), and the
 * lead's `updatedAt` has moved, so the lead and every lead list are refetched.
 */
export function useLeadNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lead, kind, body }: LeadNoteInput) =>
      api<ActivityRow>(`/api/leads/${lead.id}/${kind}`, { method: 'POST', body: { ...body, updatedAt: lead.updatedAt } }),
    onSuccess: (_row, { lead }) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.lead(lead.id) }),
        qc.invalidateQueries({ queryKey: keys.leadsAll }),
      ]),
    onError: useRefreshWhenOutOfDate(),
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
