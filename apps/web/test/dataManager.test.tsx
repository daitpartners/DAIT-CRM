import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { BatchDetail, BatchList, ImportRowView } from '../src/api/imports';
import { keys, type Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { ImportLeadsPage } from '../src/pages/imports/ImportLeadsPage';

const manager: Me = {
  id: 4, email: 'neha@daitpartners.com', name: 'Neha Kapoor', role: 'Manager', language: 'en', timezone: 'Europe/London',
  dateFormat: 'DD MMM YYYY', rights: ['manage_leads', 'view_all_leads', 'import_leads'],
};
const admin: Me = { ...manager, id: 1, name: 'Maya Pillai', role: 'Administrator', rights: [...manager.rights, 'manage_lookups', 'undo_imports'] };

const item = (over: Partial<BatchList['items'][number]>): BatchList['items'][number] => ({
  id: 8, number: 'IMPORT-2026-11-22', createdAt: '2026-11-22T11:05:00Z', by: 'Deepak Singh', language: 'en',
  files: { first: 'leads-master.csv', more: 0 }, rowCount: 488, importedCount: 231, newCompanyCount: 198, skippedCount: 257,
  research: 'done', status: 'Imported', undoneAt: null, ...over,
});
const list: BatchList = {
  items: [
    item({
      id: 9, number: 'IMPORT-2026-11-24', createdAt: '2026-11-24T14:20:00Z', files: { first: 'Expo-Dubai-visitors.xlsx', more: 2 }, rowCount: 468,
      importedCount: null, newCompanyCount: null, skippedCount: null, research: { done: 46, total: 121 }, status: 'Researching',
    }),
    item({}),
    item({ id: 6, number: 'IMPORT-2026-11-18', by: 'Carlos Ruiz', language: 'es', status: 'Undone', undoneAt: '2026-11-19T10:00:00Z', research: null }),
    item({ id: 5, number: 'IMPORT-2026-11-10', status: 'Failed', importedCount: 40, newCompanyCount: 30, skippedCount: 0 }),
  ],
  total: 4,
  count: 4,
  tiles: { importedThisMonth: 643, importedBatchesThisMonth: 4, waitingForReview: 1, stillResearching: 17, duplicatesSkippedThisMonth: 52 },
};

const detail = (over: Partial<BatchDetail> = {}): BatchDetail => ({
  id: 8, number: 'IMPORT-2026-11-22', status: 'Imported', language: 'en', leadType: 'Prospect', createdAt: '2026-11-22T11:05:00Z', rowCount: 488,
  by: 'Deepak Singh', importedAt: '2026-11-22T11:30:00Z', importedBy: 'Deepak Singh', undoneAt: null, undoneBy: null, undo: null,
  importedCount: 231, newCompanyCount: 198, existingCompanyCount: 33, skippedCount: 257, errorCount: 1, importError: null,
  counts: { imported: 231, skipped: 257, errors: 1 },
  files: [
    { id: 31, name: 'leads-master.csv', ext: 'csv', size: 81_920, status: 'Read', error: null, createdAt: '2026-11-22T11:00:00Z', deletedAt: null, rows: 488 },
    { id: 32, name: 'old-list.xlsx', ext: 'xlsx', size: 2_097_152, status: 'Read', error: null, createdAt: '2026-08-01T11:00:00Z', deletedAt: '2026-10-30T02:00:00Z', rows: 12 },
  ],
  canUndo: true,
  ...over,
});

const row = (over: Partial<ImportRowView>): ImportRowView => ({
  id: 501, fields: { companyName: 'Al Noor Logistics LLC', website: 'alnoorlogistics.ae', country: 'United Arab Emirates', email: 'omar@alnoor.ae' },
  status: 'Ready', include: true, problems: [], matched: null, from: 'leads csv · row 2', fileName: 'leads-master.csv',
  origin: { word: 'leads', ext: 'csv', kind: 'row', n: 2 }, ...over,
});
const imported = row({ lead: { id: 9101, number: 'LD-9101' }, company: { id: 77, number: 'CO-2001', created: true } });
const importedExisting = row({
  id: 502, fields: { companyName: 'Meridian Textiles Ltd', website: 'https://meridian.example' }, origin: { word: 'leads', ext: 'csv', kind: 'row', n: 3 },
  lead: { id: 9102, number: 'LD-9102' }, company: { id: 12, number: 'CO-1042', created: false },
});
const skipped = row({
  id: 503, status: 'Already in CRM', matched: { id: 12, number: 'CO-1042' }, fields: { companyName: 'Meridian Textiles Ltd', country: 'Chile' },
  problems: [{ code: 'email_missing', field: 'email', level: 'missing' }], outcomeCode: 'already_in_crm',
});
const failedRow = row({ id: 504, status: 'Ready', outcomeCode: 'import_error', error: 'invalid_status' });

const preview = {
  remove: { leads: [{ id: 9101, number: 'LD-9101' }, { id: 9103, number: 'LD-9103' }], contacts: 1, companies: 2 },
  keep: [
    { kind: 'lead', id: 9102, label: 'LD-9102 · Meridian Textiles Ltd', reason: 'emails' },
    { kind: 'company', id: 12, label: 'CO-1042 · Meridian Textiles Ltd', reason: 'other_leads' },
  ],
  reverted: [{ id: 44, label: 'CO-0900 · Gulf Freight' }],
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Stubs fetch: `handler` answers first; then the list, batch 8's detail and its rows. */
function stubFetch(handler: Handler = () => undefined) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const res = handler(url, init);
    if (res) return res;
    if (url.startsWith('/api/imports/batches?')) return Response.json(list);
    if (url === '/api/imports/batches/8') return Response.json(detail());
    if (url.startsWith('/api/imports/batches/8/rows?')) {
      const filter = new URLSearchParams(url.split('?')[1]).get('filter');
      const items = filter === 'imported' ? [imported, importedExisting] : filter === 'skipped' ? [skipped] : [failedRow];
      return Response.json({ items, total: items.length, included: 0, tiles: {}, question: null });
    }
    if (url === '/api/imports/batches/8/undo' && (init?.method ?? 'GET') === 'GET') return Response.json(preview);
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const calls = (fn: ReturnType<typeof stubFetch>, method: string, url: string | RegExp) =>
  fn.mock.calls.filter(([u, init]) => (init?.method ?? 'GET') === method && (typeof url === 'string' ? u === url : url.test(u)));
const listQueries = (fn: ReturnType<typeof stubFetch>) =>
  calls(fn, 'GET', /^\/api\/imports\/batches\?/).map(([u]) => Object.fromEntries(new URLSearchParams(u.split('?')[1])));

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function renderPage(path = '/leads/import/manager', me: Me = manager) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/leads/import" element={<p>wizard</p>} />
            <Route path="/leads/import/manager" element={<ImportLeadsPage view="manager" />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const where = () => screen.getByTestId('where').textContent;
const batchesTable = () => screen.getByRole('region', { name: 'Import batches' });
const detailCard = () => screen.getByRole('region', { name: 'Batch IMPORT-2026-11-22' });

afterEach(() => vi.unstubAllGlobals());

describe('Data manager list', () => {
  it('shows the tiles from the API and the batches in the mockup columns', async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText('643')).toBeInTheDocument();
    expect(screen.getByText('in 4 batches')).toBeInTheDocument();
    const tile = (label: string) => screen.getByText(label, { selector: '.tile .l' }).closest('.tile') as HTMLElement;
    expect(tile('Waiting for review')).toHaveTextContent('1batch');
    expect(tile('Still being researched')).toHaveTextContent('17leads');
    expect(tile('Duplicates skipped')).toHaveTextContent('52this month');

    const table = within(batchesTable());
    const headers = table.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Batch', 'Date', 'By', 'Language', 'Files', 'Rows', 'Imported', 'New companies', 'Skipped', 'Research', 'Status', 'Actions']);
    const researching = table.getByText('IMPORT-2026-11-24').closest('tr')!;
    expect(within(researching).getByText('24 Nov 2026, 14:20')).toHaveClass('muted');
    expect(within(researching).getByText('+ 2 more')).toHaveClass('cell-sub');
    expect(within(researching).getByText('46 / 121')).toBeInTheDocument();
    expect(within(researching).getAllByText('—')).toHaveLength(3);
    expect(within(researching).getByText('Researching')).toHaveClass('badge', 'b-purple');
    const done = table.getByText('IMPORT-2026-11-22').closest('tr')!;
    expect(within(done).getByText('231')).toBeInTheDocument();
    expect(within(done).getByText('Done')).toBeInTheDocument();
    expect(within(done).getByText('Imported')).toHaveClass('b-ok');
    expect(table.getByText('Undone 19 Nov')).toHaveClass('badge', 'b-grey');
    expect(within(table.getByText('IMPORT-2026-11-18').closest('tr')!).getByText('Español')).toBeInTheDocument();
    expect(table.getByText('Failed', { selector: '.badge' })).toHaveClass('b-bad');
  });

  it('the Language and Status filters and the search change the query', async () => {
    const fetchFn = stubFetch();
    renderPage();
    await screen.findByText('IMPORT-2026-11-24');
    const status = screen.getByLabelText('Status');
    expect([...(status as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Status: Any', 'Uploading', 'Sorting', 'Waiting for review', 'Researching', 'Importing', 'Imported', 'Undone', 'Failed',
    ]);
    await userEvent.selectOptions(status, 'Imported');
    await waitFor(() => expect(listQueries(fetchFn).some((q) => q.status === 'Imported')).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText('Language'), 'es');
    await waitFor(() => expect(listQueries(fetchFn).some((q) => q.status === 'Imported' && q.language === 'es')).toBe(true));
    await userEvent.type(screen.getByPlaceholderText('Search file or batch…'), 'expo');
    await waitFor(() => expect(listQueries(fetchFn).some((q) => q.q === 'expo' && q.status === 'Imported')).toBe(true));
    // Each change goes back to page 1.
    expect(listQueries(fetchFn).filter((q) => q.pageSize === '25').every((q) => (q.page ?? '1') === '1')).toBe(true);
  });

  it('"Open" on a batch not imported yet goes back to the wizard', async () => {
    stubFetch();
    renderPage();
    const researching = (await screen.findByText('IMPORT-2026-11-24')).closest('tr')!;
    await userEvent.click(within(researching).getByRole('button', { name: /^Open IMPORT/ }));
    expect(where()).toBe('/leads/import?batch=9');
  });

  it('"Open" on an imported batch selects it and shows the detail with its four tabs', async () => {
    stubFetch();
    renderPage();
    const done = (await screen.findByText('IMPORT-2026-11-22')).closest('tr')!;
    await userEvent.click(within(done).getByRole('button', { name: /^Open IMPORT/ }));
    expect(where()).toBe('/leads/import/manager?batch=8');
    expect(await screen.findByRole('heading', { name: 'Batch IMPORT-2026-11-22' })).toBeInTheDocument();
    expect(screen.getByText('IMPORT-2026-11-22', { selector: 'a' }).closest('tr')).toHaveClass('sel');
    const tabs = within(detailCard()).getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Imported 231', 'Skipped 257', 'Errors 1', 'Original files']);
    expect(within(detailCard()).getByRole('link', { name: 'Open leads in Leads list' })).toHaveAttribute('href', '/leads?q=IMPORT-2026-11-22');
    expect(within(detailCard()).getByRole('link', { name: 'Download rows (CSV)' })).toHaveAttribute('href', '/api/imports/batches/8/rows.csv');
    expect(within(detailCard()).getByRole('link', { name: 'Download rows to fix (Excel)' })).toHaveAttribute('href', '/api/imports/batches/8/rows-to-fix.xlsx?acceptHigh=0');
  });
});

describe('batch detail tabs', () => {
  it('Imported: the row with its lead and company (new / existing); a website is a link only when it is http(s)', async () => {
    stubFetch();
    renderPage('/leads/import/manager?batch=8');
    const lead = await within(await screen.findByRole('region', { name: 'Batch IMPORT-2026-11-22' })).findByRole('link', { name: 'LD-9101' });
    expect(lead).toHaveAttribute('href', '/leads/9101');
    expect(lead).toHaveClass('id-link');
    const first = lead.closest('tr')!;
    expect(within(first).getByRole('link', { name: 'CO-2001' })).toHaveAttribute('href', '/companies/77');
    expect(within(first).getByText('new')).toHaveClass('cell-sub');
    expect(within(first).getByText('leads csv · row 2')).toBeInTheDocument();
    // A bare host is plain text; an http(s) address opens in a new tab.
    expect(within(first).queryByRole('link', { name: 'alnoorlogistics.ae' })).toBeNull();
    expect(within(first).getByText('alnoorlogistics.ae')).toBeInTheDocument();
    const second = screen.getByRole('link', { name: 'LD-9102' }).closest('tr')!;
    expect(within(second).getByText('existing')).toHaveClass('cell-sub');
    expect(within(second).getByRole('link', { name: 'https://meridian.example' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('Skipped shows What to fix; Errors shows the stored code in words', async () => {
    stubFetch();
    renderPage('/leads/import/manager?batch=8');
    const card = await screen.findByRole('region', { name: 'Batch IMPORT-2026-11-22' });
    await userEvent.click(within(card).getByRole('tab', { name: /Skipped/ }));
    expect(await within(card).findByRole('columnheader', { name: 'What to fix' })).toBeInTheDocument();
    expect(within(card).getByText('Add an email; Already in the CRM as CO-1042')).toBeInTheDocument();
    // The step-2 Status column, through the same badge as step 2.
    expect(within(card).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(within(card).getByText('Already in CRM · CO-1042')).toHaveClass('badge', 'b-info');
    await userEvent.click(within(card).getByRole('tab', { name: /Errors/ }));
    expect(await within(card).findByText('The lead status is not available')).toBeInTheDocument();
    expect(within(card).queryByText('invalid_status')).toBeNull();
  });

  it('each tab starts on page 1: page 3 of Imported, then Errors shows its row', async () => {
    const fetchFn = stubFetch((url) => {
      if (!url.startsWith('/api/imports/batches/8/rows?')) return undefined;
      const q = new URLSearchParams(url.split('?')[1]);
      if (q.get('filter') === 'imported') return Response.json({ items: [imported], total: 231, included: 0, tiles: {}, question: null });
      // Errors has one row: only on page 1.
      const items = q.get('page') === '1' ? [failedRow] : [];
      return Response.json({ items, total: 1, included: 0, tiles: {}, question: null });
    });
    renderPage('/leads/import/manager?batch=8');
    const card = await screen.findByRole('region', { name: 'Batch IMPORT-2026-11-22' });
    await within(card).findByText('Showing 1–100 of 231');
    await userEvent.click(within(card).getByRole('button', { name: 'Next' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Next' }));
    expect(await within(card).findByText('Showing 201–231 of 231')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('tab', { name: /Errors/ }));
    expect(await within(card).findByText('The lead status is not available')).toBeInTheDocument();
    expect(calls(fetchFn, 'GET', /\/rows\?.*filter=errors/).map(([u]) => new URLSearchParams(u.split('?')[1]).get('page'))).toEqual(['1']);
  });

  it('Original files: a download link through the API, or "Deleted after 90 days"; a 410 on download shows it too', async () => {
    const fetchFn = stubFetch((url) => (url === '/api/imports/files/31/original' ? Response.json({ error: 'file_deleted' }, { status: 410 }) : undefined));
    renderPage('/leads/import/manager?batch=8');
    const card = await screen.findByRole('region', { name: 'Batch IMPORT-2026-11-22' });
    await userEvent.click(within(card).getByRole('tab', { name: 'Original files' }));
    const csv = within(card).getByText('leads-master.csv').closest('tr')!;
    expect(within(csv).getByText('80 KB')).toBeInTheDocument();
    expect(within(csv).getByText('Read')).toHaveClass('badge', 'b-ok');
    const link = within(csv).getByRole('link', { name: 'Download leads-master.csv' });
    expect(link).toHaveAttribute('href', '/api/imports/files/31/original');
    const old = within(card).getByText('old-list.xlsx').closest('tr')!;
    expect(within(old).getByText('Deleted after 90 days')).toHaveClass('dim');
    expect(within(old).queryByRole('link')).toBeNull();
    await userEvent.click(link);
    expect(await within(csv).findByText('Deleted after 90 days')).toHaveClass('dim');
    expect(calls(fetchFn, 'GET', '/api/imports/files/31/original')).toHaveLength(1);
  });
});

describe('Undo', () => {
  it('is hidden for a Manager', async () => {
    stubFetch();
    renderPage('/leads/import/manager?batch=8', manager);
    await screen.findByRole('heading', { name: 'Batch IMPORT-2026-11-22' });
    expect(screen.queryByRole('button', { name: 'Undo this import…' })).toBeNull();
  });

  it('is hidden for an Administrator when the batch cannot be undone', async () => {
    stubFetch((url) => (url === '/api/imports/batches/8' ? Response.json(detail({ canUndo: false })) : undefined));
    renderPage('/leads/import/manager?batch=8', admin);
    await screen.findByRole('heading', { name: 'Batch IMPORT-2026-11-22' });
    expect(screen.queryByRole('button', { name: 'Undo this import…' })).toBeNull();
  });

  it('an Administrator sees the preview first (removed, kept with reasons, put back), then confirms', async () => {
    const fetchFn = stubFetch((url, init) =>
      url === '/api/imports/batches/8/undo' && init?.method === 'POST' ? Response.json(preview) : undefined);
    renderPage('/leads/import/manager?batch=8', admin);
    const undo = await screen.findByRole('button', { name: 'Undo this import…' });
    expect(undo).toHaveClass('btn', 'sm', 'danger');
    expect(screen.getByText(/Undo removes leads and companies this batch created/)).toHaveClass('note', 'info');
    await userEvent.click(undo);
    const dialog = screen.getByRole('dialog', { name: 'Undo IMPORT-2026-11-22?' });
    expect(await within(dialog).findByText('Will be removed: 2 leads, 1 contact, 2 companies.')).toBeInTheDocument();
    expect(within(dialog).getByText('Kept because someone worked on them:')).toBeInTheDocument();
    const kept = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(kept).toEqual(['LD-9102 · Meridian Textiles Ltd — Has emails', 'CO-1042 · Meridian Textiles Ltd — Linked to leads that stay', 'CO-0900 · Gulf Freight']);
    expect(within(dialog).getByText('Research values the import accepted go back on these companies that were already in the CRM:')).toBeInTheDocument();
    expect(calls(fetchFn, 'POST', '/api/imports/batches/8/undo')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo import' }));
    await waitFor(() => expect(calls(fetchFn, 'POST', '/api/imports/batches/8/undo')).toHaveLength(1));
    expect(await screen.findByText('Import undone')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The preview of a now Undone batch is not asked for again.
    expect(calls(fetchFn, 'GET', '/api/imports/batches/8/undo')).toHaveLength(1);
  });

  it('Cancel and Escape close it without undoing', async () => {
    const fetchFn = stubFetch();
    renderPage('/leads/import/manager?batch=8', admin);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this import…' }));
    await screen.findByText('Will be removed: 2 leads, 1 contact, 2 companies.');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Undo this import…' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls(fetchFn, 'POST', '/api/imports/batches/8/undo')).toHaveLength(0);
  });

  it('a 409 try_again keeps the dialog open and asks for the preview again; batch_locked refreshes the batch (Undo goes)', async () => {
    let answer = 'try_again';
    let locked = false;
    const fetchFn = stubFetch((url, init) => {
      if (url === '/api/imports/batches/8/undo' && init?.method === 'POST') {
        if (answer === 'batch_locked') locked = true;
        return Response.json({ error: answer }, { status: 409 });
      }
      if (url === '/api/imports/batches/8') return Response.json(detail({ canUndo: !locked }));
      return undefined;
    });
    renderPage('/leads/import/manager?batch=8', admin);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this import…' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByText('Will be removed: 2 leads, 1 contact, 2 companies.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo import' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nothing was undone. Try again.');
    await waitFor(() => expect(calls(fetchFn, 'GET', '/api/imports/batches/8/undo')).toHaveLength(2));
    answer = 'batch_locked';
    await userEvent.click(within(dialog).getByRole('button', { name: 'Undo import' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('This import can no longer be undone.'));
    // The batch is asked for again: it can no longer be undone, so its Undo button goes (the dialog stays, with the reason).
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo this import…' })).toBeNull());
  });

  it('a preview refused with batch_locked shows why and offers no Undo', async () => {
    stubFetch((url, init) =>
      url === '/api/imports/batches/8/undo' && (init?.method ?? 'GET') === 'GET' ? Response.json({ error: 'batch_locked' }, { status: 409 }) : undefined);
    renderPage('/leads/import/manager?batch=8', admin);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo this import…' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This import can no longer be undone.');
    expect(within(dialog).getByRole('button', { name: 'Undo import' })).toBeDisabled();
  });
});

describe('Failed, Importing and not-imported batches', () => {
  const failed = detail({ id: 5, number: 'IMPORT-2026-11-10', status: 'Failed', importError: 'interrupted', canUndo: true, counts: { imported: 40, skipped: 0, errors: 0 } });
  const failedRoutes: Handler = (url) => {
    if (url === '/api/imports/batches/5') return Response.json(failed);
    if (url.startsWith('/api/imports/batches/5/rows?')) return Response.json({ items: [], total: 0, included: 0, tiles: {}, question: null });
    return undefined;
  };

  it('a Failed batch shows why, the Continue hint and "Continue import"', async () => {
    const fetchFn = stubFetch((url, init) => {
      if (url === '/api/imports/batches/5/import/continue' && init?.method === 'POST') return Response.json({ id: 5, status: 'Importing' }, { status: 202 });
      return failedRoutes(url, init);
    });
    renderPage('/leads/import/manager?batch=5');
    expect(await screen.findByText('The import was interrupted. Continue it to import the remaining rows.')).toHaveClass('note', 'danger');
    expect(screen.getByText(/A long import can be stopped by a deploy or a restart of the server/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue import' }));
    await waitFor(() => expect(calls(fetchFn, 'POST', '/api/imports/batches/5/import/continue')).toHaveLength(1));
    expect(await screen.findByText('Import continued')).toBeInTheDocument();
  });

  it('Continue refused: import_running and cannot_continue in words', async () => {
    let answer = 'import_running';
    stubFetch((url, init) => {
      if (url === '/api/imports/batches/5/import/continue' && init?.method === 'POST') return Response.json({ error: answer }, { status: 409 });
      return failedRoutes(url, init);
    });
    renderPage('/leads/import/manager?batch=5');
    await userEvent.click(await screen.findByRole('button', { name: 'Continue import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This import is already running.');
    answer = 'cannot_continue';
    await userEvent.click(screen.getByRole('button', { name: 'Continue import' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This import cannot be continued.'));
  });

  it('a batch not imported yet links back to its step in the wizard', async () => {
    stubFetch((url) => (url === '/api/imports/batches/9' ? Response.json(detail({ id: 9, number: 'IMPORT-2026-11-24', status: 'Researching', canUndo: false })) : undefined));
    renderPage('/leads/import/manager?batch=9', admin);
    const card = await screen.findByRole('region', { name: 'Batch IMPORT-2026-11-24' });
    expect(within(card).getByRole('link', { name: 'Continue in the wizard' })).toHaveAttribute('href', '/leads/import?batch=9');
    expect(within(card).queryByRole('tab')).toBeNull();
  });
});
