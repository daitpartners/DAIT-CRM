import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ProjectCreate, ProjectStatus, ProjectUpdate, QuoteCurrency, QuoteStatus } from '@dait-crm/shared';
import { api } from './client';
import { keys } from './queries';

/**
 * A project as the list, the company tab and the dialog see it (`projectRow` in apps/api/src/projects/service.ts).
 * `lead.visible` is false when the viewer cannot open the lead: its number shows as plain text.
 */
export type ProjectRow = {
  id: number;
  number: string;
  name: string;
  status: ProjectStatus;
  /** YYYY-MM-DD */
  startDate: string;
  value: number | null;
  currency: QuoteCurrency;
  company: { id: number; name: string; legalName: string | null };
  lead: { id: number; number: string; visible: boolean } | null;
  quotation: { id: number; number: string } | null;
  manager: { id: number; name: string };
  stakeholders: { id: number; name: string; email: string | null }[];
  description: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
};

export type CurrencyAmount = { currency: QuoteCurrency; amount: number };

/** `GET /api/projects`: rows narrowed by the filters; tiles over every project the user can see. */
export type ProjectList = {
  items: ProjectRow[];
  total: number;
  tiles: { active: number; clients: number; totals: CurrencyAmount[]; completedThisYear: number; onHold: number };
};

export type ProjectListQuery = { company?: number; status?: ProjectStatus };

export function useProjects(query: ProjectListQuery) {
  const params = new URLSearchParams();
  if (query.company) params.set('company', String(query.company));
  if (query.status) params.set('status', query.status);
  const qs = params.toString();
  return useQuery({
    queryKey: keys.projects(query),
    queryFn: () => api<ProjectList>(`/api/projects${qs ? `?${qs}` : ''}`),
  });
}

/** The company profile's Projects tab and side card. */
export function useCompanyProjects(companyId: number, enabled = true) {
  return useQuery({
    queryKey: keys.companyProjects(companyId),
    queryFn: () => api<{ items: ProjectRow[]; isClient: boolean }>(`/api/companies/${companyId}/projects`),
    enabled: enabled && Number.isInteger(companyId),
  });
}

/** `GET /api/projects/form-options`: the Create / Edit dialog's choices for one client. */
export type ProjectFormOptions = {
  company: { id: number; name: string; legalName: string | null; country: string | null; isClient: boolean; defaultCurrency: QuoteCurrency };
  leads: { id: number; number: string; status: string; leadSource: string | null; contactId: number | null; contactName: string | null }[];
  quotations: { id: number; number: string; status: QuoteStatus; subject: string; currency: QuoteCurrency }[];
  contacts: { id: number; name: string; designation: string | null; contactType: string; email: string | null; isPrimary: boolean }[];
  users: { id: number; name: string }[];
};

/** `project`: the project being edited (adds back its own lead and quotation). */
export function useProjectFormOptions(company: number | undefined, project?: number) {
  const params = new URLSearchParams();
  if (company) params.set('company', String(company));
  if (project) params.set('project', String(project));
  return useQuery({
    queryKey: keys.projectFormOptions(company ?? 0, project),
    queryFn: () => api<ProjectFormOptions>(`/api/projects/form-options?${params.toString()}`),
    enabled: company !== undefined,
  });
}

/**
 * After any project write: every project query, the sidebar badge, quotations (linking sets a quotation's project),
 * leads (a project writes the lead timeline) and companies (creating sets the Client flag).
 */
export function invalidateAfterProjectWrite(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.projectsAll }),
    qc.invalidateQueries({ queryKey: keys.navCounts }),
    qc.invalidateQueries({ queryKey: keys.quotationsAll }),
    qc.invalidateQueries({ queryKey: keys.leadsAll }),
    qc.invalidateQueries({ queryKey: keys.companiesAll }),
  ]);
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectCreate) => api<ProjectRow>('/api/projects', { method: 'POST', body }),
    onSuccess: () => invalidateAfterProjectWrite(qc),
  });
}

/**
 * Any error refetches the projects. On a 409 `stale` the Edit dialog closes (it holds the old `updatedAt`), so the
 * user reopens it on the refetched row.
 */
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ProjectUpdate }) => api<ProjectRow>(`/api/projects/${id}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateAfterProjectWrite(qc),
    onError: () => qc.invalidateQueries({ queryKey: keys.projectsAll }),
  });
}

/** Convert an Accepted quotation: the new project (201) or the one it already has (200). */
export function useConvertQuotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (quotationId: number) => api<ProjectRow>(`/api/quotations/${quotationId}/convert`, { method: 'POST' }),
    onSuccess: () => invalidateAfterProjectWrite(qc),
  });
}
