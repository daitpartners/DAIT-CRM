import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QuotationCreate, QuoteCurrency, QuoteStatus, QuoteTab } from '@dait-crm/shared';
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

/** The fields of `GET/POST /api/quotations/:id` the list and entry points use (the editor reads the rest). */
export type QuotationDetail = Pick<QuotationListItem, 'id' | 'number' | 'status' | 'revision' | 'editingNewRevision' | 'company'> & {
  updatedAt: string;
};

export function useQuotation(id: number) {
  return useQuery({
    queryKey: keys.quotation(id),
    queryFn: () => api<QuotationDetail>(`/api/quotations/${id}`),
    enabled: Number.isInteger(id),
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
