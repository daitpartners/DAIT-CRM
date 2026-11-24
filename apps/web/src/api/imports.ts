import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ColumnQuestion, FileMeta, ImportActivity, ImportBatchCreate, ImportBatchUpdate, ImportColumnAnswer, ImportCommit,
  ImportIncludeAll, ImportRowUpdate, LeadType, ResearchEngine, ResearchNotePart, ResearchValue, ReviewSummary, RowFields,
  RowChanges, RowFilter, RowProblem, UndoPreview,
} from '@dait-crm/shared';
import { api, apiUpload } from './client';

/* Import leads (steps 1–4) and the Data manager's tab count. */

const base = ['imports'] as const;
export const importKeys = {
  /** Prefix of every import query: invalidate it after a write that changes a batch. */
  all: base,
  options: [...base, 'options'] as const,
  batches: (query: BatchListQuery) => [...base, 'batches', query] as const,
  batch: (id: number) => [...base, 'batch', id] as const,
  files: (id: number) => [...base, 'files', id] as const,
  undo: (id: number) => [...base, 'undo', id] as const,
  rows: (id: number, filter: RowsFilter, page: number) => [...base, 'rows', id, filter, page] as const,
  research: (id: number, page: number) => [...base, 'research', id, page] as const,
  review: (id: number, acceptHigh: boolean, noContactRows: NoContactChoice) => [...base, 'review', id, acceptHigh, noContactRows] as const,
};

/** `GET /api/imports/options`: the language rules (with first names), Claude's state and the upload limits. */
export type ImportOptions = {
  languages: { value: string; rules: AllocationLine[] }[];
  claude: { on: boolean; runsThisMonth: number; cap: number; webSearch: boolean };
  limits: { maxFiles: number; maxBytes: number; maxRows: number };
};
export type AllocationLine = { name: string; people: string[] };

export type BatchHead = { id: number; number: string; status: string; language?: string; leadType?: string };

/** `GET /api/imports/batches/:id`: the wizard reads the first fields; the Data manager's batch detail reads the rest. */
export type BatchDetail = {
  id: number;
  number: string;
  status: string;
  language: string;
  leadType: LeadType;
  createdAt: string;
  rowCount: number;
  by?: string | null;
  importedAt?: string | null;
  importedBy?: string | null;
  undoneAt?: string | null;
  undoneBy?: string | null;
  /** What Undo removed and kept (an Undone batch). */
  undo?: UndoPreview | null;
  importedCount?: number;
  newCompanyCount?: number;
  existingCompanyCount?: number;
  skippedCount?: number;
  errorCount?: number;
  /** Why the import job gave up (a Failed batch): `importFailureText`. */
  importError?: string | null;
  /** `updated` = rows that filled blanks of a lead / company already in the CRM; `conflicts` = values they did not apply. */
  counts?: { imported: number; updated?: number; skipped: number; errors: number; conflicts?: number };
  files?: BatchFile[];
  /** The batch can be undone now (the screen also needs the user's `undo_imports`). */
  canUndo?: boolean;
};

/** An original file in the batch detail: `deletedAt` once the 90-day retention removed it. */
export type BatchFile = {
  id: number;
  name: string;
  ext: string;
  size: number;
  status: string;
  error: string | null;
  createdAt: string;
  deletedAt: string | null;
  rows: number | null;
};

export type ImportFileRow = {
  id: number;
  name: string;
  ext: string;
  size: number;
  status: string;
  meta: FileMeta | null;
  error: string | null;
};

export type ImportRowView = {
  id: number;
  fields: RowFields;
  status: string;
  include: boolean;
  problems: RowProblem[];
  matched: { id: number; number: string } | null;
  from: string;
  fileName: string;
  /** Where the row came from, as parts (worded on screen: "Expo xlsx · row 14"). */
  origin: { word: string; ext: string; kind: string; n: number };
  /** Batch detail tabs only (imported / skipped / errors): what the row became. */
  lead?: { id: number; number: string } | null;
  company?: { id: number; number: string; created: boolean } | null;
  error?: string | null;
  outcomeCode?: string | null;
  /** An updated row: what it filled and the values it did not apply. */
  changes?: RowChanges;
  research?: Record<string, ResearchValue>;
  researchStatus?: string;
  researchNote?: ResearchNotePart[];
};

export type BatchTiles = { rows: number; files: number; ready: number; missing: number; already: number; notLead: number; update?: number };
export type OpenQuestion = ColumnQuestion & { fileId: number; fileName: string };
/** `total` = rows in the filter, `included` = how many of them are ticked (every page): the header tick reads both. */
export type RowsPage = { items: ImportRowView[]; total: number; included: number; tiles: BatchTiles; question: OpenQuestion | null };

export type ResearchPage = {
  status: string;
  paused: boolean;
  stopReason: 'cap' | null;
  total: number;
  done: number;
  etaMinutes: number | null;
  tiles: { everything: number; some: number; nothing: number };
  claude: { on: boolean; runsThisMonth: number; cap: number };
  engine: ResearchEngine | null;
  items: ImportRowView[];
  activity: ImportActivity[];
};

export type NoContactChoice = 'import' | 'leave' | null;
/** `updates` is optional on screen (the totals read without it as "no update rows"). */
export type ReviewView = Omit<ReviewSummary, 'updates'> & Partial<Pick<ReviewSummary, 'updates'>> & {
  leadType: LeadType; language: string; source: string; allocation: AllocationLine[];
};

/** The step-2 filters, and the batch detail's tabs (what each row became at import). */
export type RowsFilter = RowFilter | 'imported' | 'updated' | 'skipped' | 'errors';

export type BatchListQuery = { page?: number; pageSize: number; language?: string; status?: string; q?: string };
/** A Data manager table row; the counts are null before the batch imported. */
export type BatchListItem = {
  id: number;
  number: string;
  createdAt: string;
  by: string | null;
  language: string;
  files: { first: string; more: number };
  rowCount: number;
  importedCount: number | null;
  newCompanyCount: number | null;
  skippedCount: number | null;
  /** Rows that updated a lead / company already in the CRM (null before the batch imported). */
  updatedCount?: number | null;
  /** null = nothing researched, 'done', or how far research is. */
  research: { done: number; total: number } | 'done' | null;
  status: string;
  undoneAt: string | null;
};
/** The Data manager tiles ("this month" = the viewer's calendar month, worked out by the API). */
export type BatchListTiles = {
  importedThisMonth: number;
  importedBatchesThisMonth: number;
  waitingForReview: number;
  stillResearching: number;
  duplicatesSkippedThisMonth: number;
};
/** `total` = batches matching the filters, `count` = every batch (the tab's count). */
export type BatchList = { items: BatchListItem[]; total: number; count: number; tiles: BatchListTiles };

/** Rows a page of the step-2 and step-3 tables. */
export const IMPORT_PAGE_SIZE = 100;

const qs = (q: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

export function useImportOptions() {
  return useQuery({ queryKey: importKeys.options, queryFn: () => api<ImportOptions>('/api/imports/options') });
}

/** Batches still moving on their own: the Data manager polls while one is shown. */
const MOVING = new Set(['Researching', 'Importing']);

/**
 * The Data manager list (filters, search, tiles); with `{ pageSize: 1 }` only its `count` (every batch) is used, for
 * the tab. Polls every 5 s while a listed batch is Researching or Importing.
 */
export function useBatches(query: BatchListQuery) {
  return useQuery({
    queryKey: importKeys.batches(query),
    queryFn: () => api<BatchList>(`/api/imports/batches?${qs(query)}`),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items?.some((b) => MOVING.has(b.status)) ? 5000 : false),
  });
}

/** One batch; `poll` refreshes it every 3 s while it is Importing (the Data manager's detail). */
export function useBatch(id: number | null, poll = false) {
  return useQuery({
    queryKey: importKeys.batch(id ?? 0),
    queryFn: () => api<BatchDetail>(`/api/imports/batches/${id}`),
    enabled: id !== null,
    refetchInterval: (q) => (poll && q.state.data?.status === 'Importing' ? 3000 : false),
  });
}

/** Undo, listed first: what would be removed and kept (Administrators; asked again each time the dialog opens). */
export function useUndoPreview(id: number) {
  return useQuery({
    queryKey: importKeys.undo(id),
    queryFn: () => api<UndoPreview>(`/api/imports/batches/${id}/undo`),
    gcTime: 0,
    staleTime: 0,
  });
}

/** Undo the batch; every import query and the lead, company and contact lists are refreshed after it. */
export function useUndo(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UndoPreview>(`/api/imports/batches/${id}/undo`, { method: 'POST' }),
    onSuccess: () => {
      // The preview is for a batch that is now Undone: dropped, never asked again (it would answer 409).
      qc.removeQueries({ queryKey: importKeys.undo(id) });
      void qc.invalidateQueries({ queryKey: importKeys.all });
      for (const key of [['leads'], ['companies'], ['contacts'], ['tasks']]) void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** "Continue import" on a Failed batch: imports the rows that are not in the CRM yet (202). */
export function useContinueImport(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ id: number; status: string }>(`/api/imports/batches/${id}/import/continue`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}

/** The batch detail's downloads (sent as attachments by the API). */
export const rowsCsvUrl = (batchId: number) => `/api/imports/batches/${batchId}/rows.csv`;
export const originalFileUrl = (fileId: number) => `/api/imports/files/${fileId}/original`;

export function useCreateBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportBatchCreate) => api<BatchHead>('/api/imports/batches', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...base, 'batches'] }),
  });
}

export function useUpdateBatch(id: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportBatchUpdate) => api<BatchHead>(`/api/imports/batches/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}

export function useUploadFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ batchId, file }: { batchId: number; file: File }) =>
      apiUpload<ImportFileRow>(`/api/imports/batches/${batchId}/files?${qs({ name: file.name })}`, file),
    onSettled: (_d, _e, v) => qc.invalidateQueries({ queryKey: importKeys.files(v.batchId) }),
  });
}

/** The batch's files; polls every 2 s while any is still being read. */
export function useBatchFiles(batchId: number | null) {
  return useQuery({
    queryKey: importKeys.files(batchId ?? 0),
    queryFn: () => api<{ items: ImportFileRow[] }>(`/api/imports/batches/${batchId}/files`),
    enabled: batchId !== null,
    refetchInterval: (q) => (q.state.data?.items.some((f) => f.status === 'Reading') ? 2000 : false),
  });
}

export function useSortBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: number) => api<BatchHead>(`/api/imports/batches/${batchId}/sort`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}

/** One page of a batch's rows; `poll` refreshes it every 3 s (the Data manager while the batch is Importing). */
export function useBatchRows(batchId: number, filter: RowsFilter, page: number, poll = false) {
  return useQuery({
    queryKey: importKeys.rows(batchId, filter, page),
    queryFn: () => api<RowsPage>(`/api/imports/batches/${batchId}/rows?${qs({ filter, page, pageSize: IMPORT_PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    refetchInterval: poll ? 3000 : false,
  });
}

/** Step-2 writes refresh the rows, tiles and question (and step 4's totals). */
function useRefreshRows() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: importKeys.all });
}

type RowsSnapshot = [readonly unknown[], RowsPage | undefined][];

/**
 * Changes the cached step-2 pages at once (an edit or tick shows before the server answers); returns what they were,
 * so a refused change is rolled back.
 */
async function patchRowPages(qc: ReturnType<typeof useQueryClient>, change: (page: RowsPage) => RowsPage): Promise<RowsSnapshot> {
  const key = [...base, 'rows'];
  await qc.cancelQueries({ queryKey: key });
  const before = qc.getQueriesData<RowsPage>({ queryKey: key });
  qc.setQueriesData<RowsPage>({ queryKey: key }, (page) => (page ? change(page) : page));
  return before;
}
const rollBack = (qc: ReturnType<typeof useQueryClient>, before: RowsSnapshot | undefined) =>
  before?.forEach(([key, data]) => qc.setQueryData(key, data));

/** One cell or tick: shown at once, rolled back when the server refuses it (the caller shows why). */
export function useUpdateRow() {
  const qc = useQueryClient();
  const refresh = useRefreshRows();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ImportRowUpdate }) => api<ImportRowView>(`/api/imports/rows/${id}`, { method: 'PATCH', body }),
    onMutate: ({ id, body }) =>
      patchRowPages(qc, (page) => {
        const row = page.items.find((r) => r.id === id);
        if (!row) return page;
        const tick = body.include !== undefined && body.include !== row.include ? (body.include ? 1 : -1) : 0;
        const fields = { ...row.fields };
        if (body.field) {
          if (body.value) fields[body.field] = body.value;
          else delete fields[body.field];
        }
        return {
          ...page,
          included: page.included + tick,
          items: page.items.map((r) => (r.id === id ? { ...r, fields, include: body.include ?? r.include } : r)),
        };
      }),
    onError: (_e, _v, before) => rollBack(qc, before),
    onSettled: refresh,
  });
}

/** The header tick: every row of the filter (all pages), shown at once on the page in view, rolled back if refused. */
export function useIncludeAll(batchId: number) {
  const qc = useQueryClient();
  const refresh = useRefreshRows();
  return useMutation({
    mutationFn: (body: ImportIncludeAll) => api<{ changed: number }>(`/api/imports/batches/${batchId}/include`, { method: 'POST', body }),
    onMutate: async (body) => {
      const key = [...base, 'rows', batchId, body.filter];
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueriesData<RowsPage>({ queryKey: key });
      qc.setQueriesData<RowsPage>({ queryKey: key }, (page) =>
        page ? { ...page, included: body.include ? page.total : 0, items: page.items.map((r) => ({ ...r, include: body.include })) } : page);
      return before;
    },
    onError: (_e, _v, before) => rollBack(qc, before),
    onSettled: refresh,
  });
}

export function useAnswerColumn() {
  const refresh = useRefreshRows();
  return useMutation({
    mutationFn: ({ fileId, body }: { fileId: number; body: ImportColumnAnswer }) =>
      api<{ done: string }>(`/api/imports/files/${fileId}/columns`, { method: 'POST', body }),
    onSettled: refresh,
  });
}

export function useRematch(batchId: number) {
  const refresh = useRefreshRows();
  return useMutation({
    mutationFn: () => api<{ tiles: BatchTiles }>(`/api/imports/batches/${batchId}/rematch`, { method: 'POST' }),
    onSettled: refresh,
  });
}

function useResearchAction(path: string) {
  const refresh = useRefreshRows();
  return useMutation({
    mutationFn: (batchId: number) => api<unknown>(`/api/imports/batches/${batchId}/research${path}`, { method: 'POST' }),
    onSettled: refresh,
  });
}
export const useStartResearch = () => useResearchAction('');
export const usePauseResearch = () => useResearchAction('/pause');
export const useResumeResearch = () => useResearchAction('/resume');

/** Step 3; polls every 3 s while the batch is Researching. */
export function useResearch(batchId: number, page: number) {
  return useQuery({
    queryKey: importKeys.research(batchId, page),
    queryFn: () => api<ResearchPage>(`/api/imports/batches/${batchId}/research?${qs({ page })}`),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.status === 'Researching' ? 3000 : false),
  });
}

export function useReview(batchId: number, acceptHigh: boolean, noContactRows: NoContactChoice) {
  return useQuery({
    queryKey: importKeys.review(batchId, acceptHigh, noContactRows),
    queryFn: () =>
      api<ReviewView>(`/api/imports/batches/${batchId}/review?${qs({ acceptHigh: acceptHigh ? '1' : '0', noContactRows: noContactRows ?? undefined })}`),
    placeholderData: keepPreviousData,
  });
}

export function useStartImport(batchId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportCommit) => api<{ id: number; status: string }>(`/api/imports/batches/${batchId}/import`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: importKeys.all }),
  });
}

/** "Download rows to fix (Excel)" with the current step-4 choices. */
export const rowsToFixUrl = (batchId: number, acceptHigh: boolean, noContactRows: NoContactChoice) =>
  `/api/imports/batches/${batchId}/rows-to-fix.xlsx?${qs({ acceptHigh: acceptHigh ? '1' : '0', noContactRows: noContactRows ?? undefined })}`;
