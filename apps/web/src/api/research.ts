import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RESEARCH_QUEUE_STATUSES, type EnrichmentSettingsUpdate, type ManualSourceCreate } from '@dait-crm/shared';
import { api } from './client';
import { keys } from './queries';

/* AI research (release 4): the AI Intelligence and Research Sources tabs, the Overview AI card and the lead AI line. */

/** One undecided suggestion (`GET /api/companies/:id/research` `pending`). */
export type ResearchSuggestion = {
  id: number;
  runId: number;
  field: string;
  label: string;
  value: unknown;
  display: string | null;
  confidence: number;
  sourceUrl: string;
  sourceLabel: string | null;
  currentValue: unknown;
  /** Verified, or no longer empty: never overwritten. */
  locked: boolean;
};

/** An `enrichment_history` row. */
export type ResearchRun = {
  id: number;
  createdAt: string;
  trigger: string;
  engine: string;
  sources: string | null;
  result: string | null;
  appliedCount: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/** `GET /api/companies/:id/research`. */
export type ResearchView = {
  company: {
    aiSummary: string | null;
    aiIndustry: string | null;
    aiBusinessCategory: string | null;
    aiPotentialServices: string[];
    aiOpportunityScore: number | null;
    aiConfidence: string | null;
    aiResearchStatus: string;
    aiLastResearchAt: string | null;
    verificationStatus: string;
    verifiedFields: Record<string, boolean> | null;
  };
  pending: ResearchSuggestion[];
  runs: ResearchRun[];
  canEdit: boolean;
};

/** A `source_records` row (`GET /api/companies/:id/sources`, newest first). */
export type SourceRow = {
  id: number;
  title: string;
  url: string | null;
  sourceType: string;
  collectedAt: string;
  collectedBy: string;
  fieldsPopulated: string | null;
  confidence: string | null;
  snapshot: string | null;
};

/** `GET /api/settings/enrichment` (Administrators): the settings, key presence (never a key) and this month's use. */
export type EnrichmentView = EnrichmentSettingsUpdate & {
  claudeKeyPresent: boolean;
  placesKeyPresent: boolean;
  claudeSpentThisMonthUsd: number;
  placesCallsThisMonth: number;
};

/** Research is queued or running: the run buttons are disabled and the research query polls. */
export const isResearchQueued = (status: string | null | undefined): boolean =>
  (RESEARCH_QUEUE_STATUSES as readonly string[]).includes(status ?? '');

/** How often the research query polls while a run is Pending or Processing. */
export const RESEARCH_POLL_MS = 3000;

const researchKey = (companyId: number) => ['research', companyId] as const;
const sourcesKey = (companyId: number) => ['research', companyId, 'sources'] as const;
const settingsKey = ['settings', 'enrichment'] as const;

/**
 * The company's research view, polled every 3 s while its status is Pending or Processing. When a run finishes, the
 * company, its sources and (via `onFinished`) the caller's own views are refreshed.
 */
export function useResearch(
  companyId: number,
  opts: { enabled?: boolean; onFinished?: (view: ResearchView) => void } = {},
) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: researchKey(companyId),
    queryFn: () => api<ResearchView>(`/api/companies/${companyId}/research`),
    enabled: Number.isInteger(companyId) && (opts.enabled ?? true),
    refetchInterval: (q) => (isResearchQueued(q.state.data?.company?.aiResearchStatus) ? RESEARCH_POLL_MS : false),
  });
  const status = query.data?.company?.aiResearchStatus;
  const previous = useRef(status);
  const onFinished = useRef(opts.onFinished);
  onFinished.current = opts.onFinished;
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (!isResearchQueued(was) || isResearchQueued(status) || !query.data) return;
    void qc.invalidateQueries({ queryKey: keys.companiesAll });
    void qc.invalidateQueries({ queryKey: sourcesKey(companyId) });
    onFinished.current?.(query.data);
  }, [status, query.data, qc, companyId]);
  return query;
}

/** After a write: the research view and every company query (profile, Overview values, list tiles). */
function useRefreshResearch(companyId: number) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: researchKey(companyId) }),
      qc.invalidateQueries({ queryKey: keys.companiesAll }),
    ]);
}

/** "Run research" / "Re-run research": 202 `{runId}`; 409 research_running, 429 daily_limit. */
export function useStartResearch(companyId: number) {
  const refresh = useRefreshResearch(companyId);
  return useMutation({
    mutationFn: () => api<{ runId: number }>(`/api/companies/${companyId}/research`, { method: 'POST' }),
    onSettled: refresh,
  });
}

/** Accept or reject one suggestion (409 locked / already_decided). */
export function useDecideSuggestion(companyId: number) {
  const refresh = useRefreshResearch(companyId);
  return useMutation({
    mutationFn: (v: { id: number; accept: boolean }) =>
      api<{ id: number; decision: string }>(`/api/research/suggestions/${v.id}/${v.accept ? 'accept' : 'reject'}`, { method: 'POST' }),
    onSettled: refresh,
  });
}

/** "Accept all ≥ 80%". */
export function useAcceptHigh(companyId: number) {
  const refresh = useRefreshResearch(companyId);
  return useMutation({
    mutationFn: () => api<{ accepted: number }>(`/api/companies/${companyId}/research/accept-high`, { method: 'POST' }),
    onSettled: refresh,
  });
}

/** "Mark profile verified". */
export function useVerifyProfile(companyId: number) {
  const refresh = useRefreshResearch(companyId);
  return useMutation({
    mutationFn: () => api<{ ok: true }>(`/api/companies/${companyId}/verify-profile`, { method: 'POST' }),
    onSettled: refresh,
  });
}

export function useSources(companyId: number) {
  return useQuery({
    queryKey: sourcesKey(companyId),
    queryFn: async () => (await api<{ items: SourceRow[] }>(`/api/companies/${companyId}/sources`)).items,
    enabled: Number.isInteger(companyId),
  });
}

/** "+ Add source manually". */
export function useAddSource(companyId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ManualSourceCreate) => api<SourceRow>(`/api/companies/${companyId}/sources`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: sourcesKey(companyId) }),
  });
}

/** The enrichment engine card (Administrators only: `enabled` false for everyone else, so nothing is asked). */
export function useEnrichmentSettings(enabled: boolean) {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => api<EnrichmentView>('/api/settings/enrichment'),
    enabled,
  });
}

export function useSaveEnrichmentSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EnrichmentSettingsUpdate) => api<EnrichmentView>('/api/settings/enrichment', { method: 'PUT', body }),
    onSuccess: (view) => qc.setQueryData(settingsKey, view),
  });
}
