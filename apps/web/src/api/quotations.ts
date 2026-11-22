import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CompanySettingsUpdate, QuotationCreate, QuotationUpdate, QuoteCurrency, QuoteStatus, QuoteTab, QuoteTotals } from '@dait-crm/shared';
import { api } from './client';
import { leadListPath, type LeadPage } from './leads';
import { keys } from './queries';

/** A Quotations list row (`quotationListItem` in apps/api/src/quotations/service.ts); `total` is the display figure. */
export type QuotationListItem = {
  id: number;
  number: string;
  status: QuoteStatus;
  revision: number;
  editingNewRevision: boolean;
  company: { id: number; number: string; name: string; legalName: string | null };
  contact: { id: number; name: string } | null;
  lead: { id: number; number: string; status: string } | null;
  owner: { id: number; name: string };
  /** YYYY-MM-DD */
  quotationDate: string;
  validUntil: string | null;
  subject: string;
  currency: QuoteCurrency;
  total: number;
  projectId: number | null;
  /** Sent / Negotiating and valid until within 7 days of the viewer's today. */
  expiringSoon: boolean;
};

export type CurrencySum = { currency: QuoteCurrency; amount: number };

/** `GET /api/quotations`: rows for the tab and search; counts and tiles over every visible quotation. */
export type QuotationList = {
  items: QuotationListItem[];
  counts: Record<QuoteTab, number>;
  tiles: {
    openCount: number;
    openSums: CurrencySum[];
    acceptedCount: number;
    acceptedSums: CurrencySum[];
    expiringSoon: { id: number; number: string; validUntil: string | null }[];
    winRate: number;
    sentCount: number;
  };
};

/** `companyId` narrows rows, counts and tiles to one company (the company page). */
export type QuotationListQuery = { tab?: QuoteTab; s?: string; companyId?: number };

export function useQuotations(query: QuotationListQuery) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, String(v));
  return useQuery({
    queryKey: keys.quotations(query),
    queryFn: () => api<QuotationList>(`/api/quotations?${params.toString()}`),
    placeholderData: keepPreviousData,
  });
}

/** A line of the working copy (`quotationDetail` in apps/api/src/quotations/service.ts). */
export type QuotationLine = {
  id: number;
  sortOrder: number;
  item: string;
  description: string | null;
  qty: number;
  unit: string;
  unitPrice: number;
  discount: number;
  total: number;
};

/** A sent, frozen revision. */
export type QuotationRevision = {
  revisionNo: number;
  sentAt: string;
  sentTo: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  note: string | null;
  currency: QuoteCurrency;
};

/**
 * `GET/POST/PATCH /api/quotations/:id`: the editor's view. `totals` are the working copy's; `displayTotals` what the
 * list shows (the last sent revision while revision n+1 is unsent). `canEdit` = not locked, not sending, and the user
 * may edit it; `sending` = a send is queued and the editor is read-only until it settles.
 */
export type QuotationDetail = Pick<QuotationListItem, 'id' | 'number' | 'status' | 'revision' | 'editingNewRevision' | 'lead' | 'owner'> & {
  company: QuotationListItem['company'] & { country?: string | null };
  contact: { id: number; name: string; email: string | null } | null;
  locked: boolean;
  sending: boolean;
  canEdit: boolean;
  /** YYYY-MM-DD */
  quotationDate: string;
  validUntil: string | null;
  currency: QuoteCurrency;
  subject: string;
  taxRate: number;
  overallDiscount: number;
  notes: string;
  projectId: number | null;
  lines: QuotationLine[];
  totals: QuoteTotals;
  displayTotals: QuoteTotals & { currency: QuoteCurrency };
  revisions: QuotationRevision[];
  history: { at: string; text: string }[];
  createdAt: string;
  updatedAt: string;
};

/** The editor's quotation; while a send is queued it is fetched again every 5 s so the page flips to Sent by itself. */
export function useQuotation(id: number) {
  return useQuery({
    queryKey: keys.quotation(id),
    queryFn: () => api<QuotationDetail>(`/api/quotations/${id}`),
    enabled: Number.isInteger(id),
    refetchInterval: (query) => (query.state.data?.sending ? SENDING_POLL_MS : false),
  });
}

export const SENDING_POLL_MS = 5000;

/**
 * After any quotation write: the list and other quotations, the dashboard tile (under the tasks prefix), leads (send
 * and accept move the lead and write its timeline) and companies (accept sets the Client flag). `written` is the
 * quotation whose answer the caller has just put in the cache: it is not fetched again, so an older copy cannot land
 * on top of a newer save.
 */
export function invalidateAfterQuotationWrite(qc: QueryClient, written?: number) {
  const detail = written === undefined ? null : keys.quotation(written);
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.quotationsAll, predicate: (query) => !detail || JSON.stringify(query.queryKey) !== JSON.stringify(detail) }),
    qc.invalidateQueries({ queryKey: keys.dashboard }),
    qc.invalidateQueries({ queryKey: keys.leadsAll }),
    qc.invalidateQueries({ queryKey: keys.companiesAll }),
  ]);
}

/** `PATCH /api/quotations/:id` (autosave); the caller puts the answer in the cache. */
export function patchQuotation(id: number, body: QuotationUpdate) {
  return api<QuotationDetail>(`/api/quotations/${id}`, { method: 'PATCH', body });
}

export type QuotationAction =
  | { kind: 'negotiate' }
  | { kind: 'accept' | 'reject'; discardUnsent?: boolean }
  | { kind: 'send'; body?: string }
  | { kind: 'duplicate' };

/** Negotiating / accept / reject / send / duplicate. The answer is the quotation (for duplicate: the new Draft). */
export function useQuotationAction(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: QuotationAction) => {
      const body = a.kind === 'accept' || a.kind === 'reject' ? (a.discardUnsent ? { discardUnsent: true } : {}) : a.kind === 'send' ? (a.body ? { body: a.body } : {}) : undefined;
      return api<QuotationDetail>(`/api/quotations/${id}/${a.kind}`, { method: 'POST', body });
    },
    onSuccess: (q, a) => {
      if (a.kind === 'duplicate') return invalidateAfterQuotationWrite(qc);
      qc.setQueryData(keys.quotation(id), q);
      return invalidateAfterQuotationWrite(qc, id);
    },
  });
}

/** Settings → Company details (Administrators). */
export type CompanySettings = {
  legalName: string;
  addressLines: string[];
  email: string;
  gstin: string | null;
  taxInr: number;
  taxUsd: number;
  taxCad: number;
  defaultNotes: string;
};

export function useCompanySettings(enabled = true) {
  return useQuery({ queryKey: keys.companySettings, queryFn: () => api<CompanySettings>('/api/settings/company'), enabled });
}

export function useSaveCompanySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CompanySettingsUpdate) => api<CompanySettings>('/api/settings/company', { method: 'PUT', body }),
    onSuccess: (saved) => qc.setQueryData(keys.companySettings, saved),
  });
}

/**
 * "New quotation" (needs `manage_quotes`). Creating writes a timeline entry on the lead, so leads refresh too, and
 * the dashboard (its tile counts the user's own quotations).
 */
export function useCreateQuotation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: QuotationCreate) => api<QuotationDetail>('/api/quotations', { method: 'POST', body }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.quotationsAll }),
        qc.invalidateQueries({ queryKey: keys.leadsAll }),
        qc.invalidateQueries({ queryKey: keys.dashboard }),
      ]),
  });
}

/**
 * The company page's "New quotation" (prototype `#/quotes/new?company=`): the API never picks a lead, so this passes
 * the first lead the user can see at the company (as the Leads tab lists them, newest first), else none.
 */
export function useCreateQuotationForCompany() {
  const create = useCreateQuotation();
  // Busy from the lead look-up until the create settles, so a second click cannot start a second quotation.
  const [busy, setBusy] = useState(false);
  return {
    isPending: busy,
    mutate: (companyId: number, opts: { onSuccess: (q: QuotationDetail) => void; onError: (err: unknown) => void }) => {
      if (busy) return;
      setBusy(true);
      void (async () => {
        try {
          const leads = await api<LeadPage>(leadListPath({ companyId, page: 1, pageSize: 1 }));
          const leadId = leads.items[0]?.id;
          const q = await create.mutateAsync({ companyId, ...(leadId ? { leadId } : {}) });
          setBusy(false);
          opts.onSuccess(q);
        } catch (err) {
          setBusy(false);
          opts.onError(err);
        }
      })();
    },
  };
}
