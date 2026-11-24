import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ResearchPage, ReviewView, RowsPage } from '../src/api/imports';
import { keys, type Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { ImportLeadsPage } from '../src/pages/imports/ImportLeadsPage';
import { LeadsList } from '../src/pages/leads/LeadsList';

const manager: Me = {
  id: 4, email: 'neha@daitpartners.com', name: 'Neha Kapoor', role: 'Manager', language: 'en', timezone: 'Europe/London',
  dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'view_all_leads', 'import_leads'],
};
const admin: Me = { ...manager, id: 1, name: 'Maya Pillai', role: 'Administrator', rights: [...manager.rights, 'manage_lookups', 'undo_imports'] };
const rep: Me = { ...manager, id: 2, name: 'Arjun Mehta', role: 'Sales Representative', rights: ['manage_leads', 'claim_leads'] };

const options = {
  languages: [
    { value: 'en', rules: [{ name: 'English market (US and Canada)', people: ['Deepak', 'Lakshita'] }] },
    { value: 'es', rules: [{ name: 'Spanish market (Español)', people: ['Carlos', 'Seba'] }] },
  ],
  claude: { on: true, runsThisMonth: 146, cap: 300, webSearch: true },
  limits: { maxFiles: 10, maxBytes: 20 * 1024 * 1024, maxRows: 5000 },
};
const batch = (status: string) => ({ id: 7, number: 'IMPORT-2026-11-24', status, language: 'en', leadType: 'Prospect', createdAt: '2026-11-24T14:20:00Z', rowCount: 6 });

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Stubs fetch: `handler` answers first; options, the batch count and an empty file list after it. */
function stubFetch(handler: Handler = () => undefined) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const res = handler(url, init);
    if (res) return res;
    if (url === '/api/imports/options') return Response.json(options);
    if (url.startsWith('/api/imports/batches?')) return Response.json({ items: [], total: 4, count: 4, tiles: {} });
    if (url === '/api/imports/batches/7/files') return Response.json({ items: [] });
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const calls = (fn: ReturnType<typeof stubFetch>, method: string, url: string | RegExp) =>
  fn.mock.calls.filter(([u, init]) => (init?.method ?? 'GET') === method && (typeof url === 'string' ? u === url : url.test(u)));
const bodyOf = (fn: ReturnType<typeof stubFetch>, method: string, url: string) => {
  const call = calls(fn, method, url)[0];
  return call ? JSON.parse(String(call[1]!.body)) : undefined;
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function renderPage(path = '/leads/import', me: Me = manager) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  qc.setQueryData(keys.lookups, { country: [], lead_source: [], lead_status: [] });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/leads/import" element={<ImportLeadsPage view="wizard" />} />
            <Route path="/leads/import/manager" element={<ImportLeadsPage view="manager" />} />
            <Route path="/leads" element={<LeadsList />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const fileOf = (name: string, size = 10) => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

// jsdom has no scrolling: the wizard scrolls to the top on each step.
window.scrollTo = (() => undefined) as typeof window.scrollTo;

afterEach(() => vi.unstubAllGlobals());

describe('step 1: no default language or import type', () => {
  it('starts with nothing checked; continuing names both choices and marks both groups', async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText('English market (US and Canada) · Deepak, Lakshita')).toBeInTheDocument();
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sort the data →' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose the outreach language (English or Spanish) and whether to import them as Prospects or Leads before continuing.',
    );
    expect(screen.getByRole('alert')).toHaveClass('note', 'danger');
    expect(screen.getByText('Choose English or Spanish.')).toHaveClass('err-msg');
    expect(screen.getByText('Choose Prospects or Leads.')).toHaveClass('err-msg');
    // Each message is tied to its group.
    const lang = screen.getByRole('group', { name: 'Outreach language' });
    expect(lang).toHaveAttribute('aria-invalid', 'true');
    expect(lang).toHaveAttribute('aria-describedby', screen.getByText('Choose English or Spanish.').id);
    expect(screen.getByRole('group', { name: 'Import as' })).toHaveAttribute('aria-describedby', screen.getByText('Choose Prospects or Leads.').id);
  });

  it('a later step pill is refused the same way; choosing English leaves only the import type in the alert', async () => {
    stubFetch();
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /AI research/ }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /English leads/ }));
    expect(screen.getByRole('radio', { name: /English leads/ }).closest('label')).toHaveClass('radio-card', 'on');
    expect(screen.getByRole('alert')).toHaveTextContent('Choose whether to import them as Prospects or Leads before continuing.');
    expect(screen.queryByText('Choose English or Spanish.')).toBeNull();
    expect(screen.getByText('Choose Prospects or Leads.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: /Prospects/ }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('choosing files before both choices shows the alert and creates no batch', async () => {
    const fetchFn = stubFetch();
    renderPage();
    await userEvent.upload(screen.getByLabelText('Choose files'), fileOf('Expo.xlsx'));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the outreach language');
    expect(calls(fetchFn, 'POST', '/api/imports/batches')).toHaveLength(0);
  });

  it('with both chosen, a file creates the batch and is uploaded as raw bytes; the URL keeps the batch', async () => {
    const fetchFn = stubFetch((url, init) => {
      if (url === '/api/imports/batches' && init?.method === 'POST') return Response.json({ id: 7, number: 'IMPORT-2026-11-24', status: 'Uploading' }, { status: 201 });
      if (url.startsWith('/api/imports/batches/7/files?')) return Response.json({ id: 3, name: 'Expo.xlsx', ext: 'xlsx', size: 10, status: 'Reading' }, { status: 201 });
      if (url === '/api/imports/batches/7') return Response.json(batch('Uploading'));
      return undefined;
    });
    renderPage();
    await userEvent.click(screen.getByRole('radio', { name: /English leads/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Prospects/ }));
    await userEvent.upload(screen.getByLabelText('Choose files'), fileOf('Expo.xlsx'));
    await waitFor(() => expect(calls(fetchFn, 'POST', /^\/api\/imports\/batches\/7\/files\?/)).toHaveLength(1));
    expect(bodyOf(fetchFn, 'POST', '/api/imports/batches')).toEqual({ language: 'en', leadType: 'Prospect' });
    const [url, init] = calls(fetchFn, 'POST', /^\/api\/imports\/batches\/7\/files\?/)[0]!;
    expect(url).toBe('/api/imports/batches/7/files?name=Expo.xlsx');
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    expect(init!.body).toBeInstanceOf(File);
    expect(screen.getByTestId('where')).toHaveTextContent('/leads/import?batch=7&step=1');
  });

  it('refuses a file over 20 MB, another type, and more than 10 files before uploading', async () => {
    const fetchFn = stubFetch();
    renderPage();
    await userEvent.click(screen.getByRole('radio', { name: /Spanish leads/ }));
    await userEvent.click(screen.getByRole('radio', { name: /^Leads/ }));
    const input = screen.getByLabelText('Choose files') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileOf('big.xlsx', 21 * 1024 * 1024), fileOf('photo.png')] } });
    expect(await screen.findByText('big.xlsx is larger than 20 MB.')).toBeInTheDocument();
    expect(screen.getByText('photo.png: only .xlsx .xls .csv .pdf .docx .txt files can be imported.')).toBeInTheDocument();
    fireEvent.change(input, { target: { files: Array.from({ length: 11 }, (_, i) => fileOf(`f${i}.csv`)) } });
    expect(await screen.findByText('Up to 10 files per import.')).toBeInTheDocument();
    expect(calls(fetchFn, 'POST', '/api/imports/batches')).toHaveLength(0);
  });

  it('a second drop while the first upload is running makes no second batch', async () => {
    let release: () => void = () => undefined;
    const fetchFn = stubFetch((url, init) => {
      if (url === '/api/imports/batches' && init?.method === 'POST') {
        return new Promise<Response>((done) => { release = () => done(Response.json({ id: 7, number: 'IMPORT-2026-11-24', status: 'Uploading' }, { status: 201 })); }) as unknown as Response;
      }
      if (url.startsWith('/api/imports/batches/7/files?')) return Response.json({ id: 3, name: 'a.csv', ext: 'csv', size: 10, status: 'Reading' }, { status: 201 });
      if (url === '/api/imports/batches/7') return Response.json(batch('Uploading'));
      return undefined;
    });
    renderPage();
    await userEvent.click(screen.getByRole('radio', { name: /English leads/ }));
    await userEvent.click(screen.getByRole('radio', { name: /Prospects/ }));
    const zone = document.querySelector('.file-pick')!;
    fireEvent.drop(zone, { dataTransfer: { files: [fileOf('a.csv')] } });
    fireEvent.drop(zone, { dataTransfer: { files: [fileOf('b.csv')] } });
    await waitFor(() => expect(calls(fetchFn, 'POST', '/api/imports/batches')).toHaveLength(1));
    release();
    await waitFor(() => expect(calls(fetchFn, 'POST', /^\/api\/imports\/batches\/7\/files\?/)).toHaveLength(1));
    expect(calls(fetchFn, 'POST', '/api/imports/batches')).toHaveLength(1);
  });

  it('an unknown batch shows "Import not found" with a way back', async () => {
    stubFetch((url) => (url === '/api/imports/batches/999' ? Response.json({ error: 'not_found' }, { status: 404 }) : undefined));
    renderPage('/leads/import?batch=999');
    expect(await screen.findByText('Import not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a new import' })).toHaveAttribute('href', '/leads/import');
  });

  it('lists files with their read status: a scan cannot be read yet, a failed file says why', async () => {
    stubFetch((url) => {
      if (url === '/api/imports/batches/7') return Response.json(batch('Uploading'));
      if (url === '/api/imports/batches/7/files') {
        return Response.json({
          items: [
            { id: 1, name: 'Expo.xlsx', ext: 'xlsx', size: 1258291, status: 'Read', meta: { sheets: 3, rows: 412 }, error: null },
            { id: 2, name: 'Scanned cards.pdf', ext: 'pdf', size: 900000, status: 'Scan', meta: { pages: 6, textFound: false }, error: null },
            { id: 3, name: 'old.csv', ext: 'csv', size: 100, status: 'Failed', meta: null, error: 'too_many_rows' },
          ],
        });
      }
      return undefined;
    });
    renderPage('/leads/import?batch=7&step=1');
    const scan = (await screen.findByText('Scanned cards.pdf')).closest('li')!;
    expect(within(scan).getByText("Can't read scans yet")).toHaveClass('badge', 'b-warn');
    expect(within(scan).getByText('6 pages · images only, no text')).toBeInTheDocument();
    const xls = screen.getByText('Expo.xlsx').closest('li')!;
    expect(within(xls).getByText('XLS')).toHaveClass('conn-logo');
    expect(within(xls).getByText('3 sheets · 412 rows · 1.2 MB')).toBeInTheDocument();
    expect(within(xls).getByText('Read')).toHaveClass('b-ok');
    const bad = screen.getByText('old.csv').closest('li')!;
    expect(within(bad).getByText('Not read')).toHaveClass('b-bad');
    // The language and type come back with the batch.
    expect(screen.getByRole('radio', { name: /English leads/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Prospects/ })).toBeChecked();
  });
});

const row = (id: number, fields: Record<string, string>, status = 'Missing details', extra = {}) => ({
  id, fields, status, include: true, problems: [], matched: null, from: 'Expo xlsx · row 14', fileName: 'Expo.xlsx',
  origin: { word: 'Expo', ext: 'xlsx', kind: 'row', n: 14 }, ...extra,
});
const rowsPage: RowsPage = {
  items: [
    row(11, { companyName: 'Al Noor Logistics LLC', country: 'United Arab Emirates', email: 'omar.h@alnoorlogistics.ae' }, 'Ready'),
    row(12, { companyName: 'Meridian Textiles Ltd' }, 'Already in CRM', { matched: { id: 9, number: 'CO-1042' }, include: false }),
  ],
  total: 2,
  included: 1,
  tiles: { rows: 2, files: 1, ready: 1, missing: 0, already: 1, notLead: 0 },
  question: { sheet: 'Sheet1', col: 0, header: 'Firma', guess: 'companyName', samples: ['Al Noor Logistics LLC', 'Meridian Textiles Ltd'], fileId: 3, fileName: 'Expo.xlsx' },
};

describe('step 2: sorting', () => {
  const handler: Handler = (url, init) => {
    if (url === '/api/imports/batches/7') return Response.json(batch('Sorting'));
    if (url.startsWith('/api/imports/batches/7/rows?')) return Response.json(rowsPage);
    if (url === '/api/imports/files/3/columns' && init?.method === 'POST') return Response.json({ done: 'contactName' });
    if (url.startsWith('/api/imports/rows/') && init?.method === 'PATCH') return Response.json(rowsPage.items[0]);
    return undefined;
  };

  it('asks the unsure column in a note; Confirm sends the chosen field and says what changed', async () => {
    const fetchFn = stubFetch(handler);
    renderPage('/leads/import?batch=7&step=2');
    const note = (await screen.findByText(/is this the/)).closest('.note')!;
    expect(note).toHaveClass('warn');
    expect(within(note as HTMLElement).getByText('First values: Al Noor Logistics LLC, Meridian Textiles Ltd')).toHaveClass('dim');
    await userEvent.selectOptions(screen.getByLabelText('CRM field for column Firma'), 'Contact name');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Column "Firma" in Expo.xlsx is now the Contact name.')).toHaveClass('note', 'ok');
    expect(bodyOf(fetchFn, 'POST', '/api/imports/files/3/columns')).toEqual({ sheet: 'Sheet1', col: 0, field: 'contactName' });
    // No per-column mapping dropdowns in the table itself.
    expect(within(screen.getByRole('table')).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('shows statuses, "missing" cells and the tiles; an edited cell is saved on blur, Escape puts it back', async () => {
    const fetchFn = stubFetch(handler);
    renderPage('/leads/import?batch=7&step=2');
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Ready')).toHaveClass('badge', 'b-ok');
    expect(within(table).getByText('Already in CRM · CO-1042')).toHaveClass('badge', 'b-info');
    expect(within(table).getByText('Al Noor Logistics LLC')).toHaveClass('strong');
    expect(within(table).getAllByText('missing')[0]).toHaveClass('dim');
    expect(screen.getByRole('option', { name: 'All rows (2)' })).toBeInTheDocument();

    const al = within(table).getByText('Al Noor Logistics LLC').closest('tr')!;
    const city = al.querySelectorAll('td')[4]!;
    fireEvent.focus(city);
    city.textContent = 'Dubai';
    fireEvent.blur(city);
    await waitFor(() => expect(calls(fetchFn, 'PATCH', '/api/imports/rows/11')).toHaveLength(1));
    expect(bodyOf(fetchFn, 'PATCH', '/api/imports/rows/11')).toEqual({ field: 'city', value: 'Dubai' });

    const cells = within(table).getByText('Al Noor Logistics LLC').closest('tr')!.querySelectorAll('td');
    const email = cells[7]!;
    fireEvent.focus(email);
    email.textContent = 'changed@x.com';
    fireEvent.keyDown(email, { key: 'Escape' });
    fireEvent.blur(email);
    expect(calls(fetchFn, 'PATCH', '/api/imports/rows/11')).toHaveLength(1);
    await waitFor(() => expect(within(table).getByText('Al Noor Logistics LLC').closest('tr')!.querySelectorAll('td')[7]).toHaveTextContent('omar.h@alnoorlogistics.ae'));
  });
});

describe('step 2: the header tick reads the whole filter; refused changes come back with the reason', () => {
  const page = (over: Partial<RowsPage>): RowsPage => ({ ...rowsPage, question: null, ...over });
  const renderRows = (view: RowsPage, patch?: Response) => {
    const fetchFn = stubFetch((url, init) => {
      if (url === '/api/imports/batches/7') return Response.json(batch('Sorting'));
      if (url.startsWith('/api/imports/batches/7/rows?')) return Response.json(view);
      if (url === '/api/imports/batches/7/include' && init?.method === 'POST') return Response.json({ changed: 1 });
      if (url.startsWith('/api/imports/rows/') && init?.method === 'PATCH') return patch ?? Response.json(view.items[0]);
      return undefined;
    });
    renderPage('/leads/import?batch=7&step=2');
    return fetchFn;
  };

  it('some rows of the filter ticked (on any page): mixed; a click ticks every row of the filter', async () => {
    // Every row on this page is ticked, but 168 of the 468 are not: the header is mixed, not checked.
    const fetchFn = renderRows(page({
      items: [row(11, { companyName: 'Al Noor Logistics LLC' }, 'Ready')], total: 468, included: 300,
    }));
    const head = await screen.findByRole('checkbox', { name: 'Include all 468 rows in this view' });
    await waitFor(() => expect((head as HTMLInputElement).indeterminate).toBe(true));
    expect(head).not.toBeChecked();
    await userEvent.click(head);
    await waitFor(() => expect(calls(fetchFn, 'POST', '/api/imports/batches/7/include')).toHaveLength(1));
    expect(bodyOf(fetchFn, 'POST', '/api/imports/batches/7/include')).toEqual({ filter: 'all', include: true });
  });

  it('every row of the filter ticked: checked; a click leaves them all out', async () => {
    const fetchFn = renderRows(page({ items: [row(11, { companyName: 'A' }, 'Ready')], total: 468, included: 468 }));
    const head = await screen.findByRole('checkbox', { name: 'Include all 468 rows in this view' });
    await waitFor(() => expect(head).toBeChecked());
    expect((head as HTMLInputElement).indeterminate).toBe(false);
    await userEvent.click(head);
    await waitFor(() => expect(bodyOf(fetchFn, 'POST', '/api/imports/batches/7/include')).toEqual({ filter: 'all', include: false }));
  });

  it('the From column is worded on screen', async () => {
    renderRows(page({ items: [row(11, { companyName: 'A' }, 'Ready', { origin: { word: 'GITEX', ext: 'pdf', kind: 'page', n: 7 } })] }));
    expect(await screen.findByText('GITEX pdf · p.7')).toHaveClass('muted');
  });

  it('a refused edit (the import has started) shows the reason and puts the old value back', async () => {
    renderRows(page({}), Response.json({ error: 'batch_locked' }, { status: 409 }));
    const table = await screen.findByRole('table');
    const cells = (await within(table).findByText('Al Noor Logistics LLC')).closest('tr')!.querySelectorAll('td');
    const email = cells[7]!;
    fireEvent.focus(email);
    email.textContent = 'new@x.com';
    fireEvent.blur(email);
    // Shown at once while saving.
    expect(within(table).getByText('Al Noor Logistics LLC').closest('tr')!.querySelectorAll('td')[7]).toHaveTextContent('new@x.com');
    expect(await screen.findByText('This import has already started and can no longer be changed.')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(table).getByText('Al Noor Logistics LLC').closest('tr')!.querySelectorAll('td')[7]).toHaveTextContent('omar.h@alnoorlogistics.ae'));
  });

  it('a refused tick is rolled back with the reason', async () => {
    renderRows(page({}), Response.json({ error: 'batch_locked' }, { status: 409 }));
    const table = await screen.findByRole('table');
    const tick = within((await within(table).findByText('Al Noor Logistics LLC')).closest('tr')!).getByRole('checkbox');
    expect(tick).toBeChecked();
    await userEvent.click(tick);
    expect(await screen.findByText('This import has already started and can no longer be changed.')).toBeInTheDocument();
    await waitFor(() => expect(within(within(table).getByText('Al Noor Logistics LLC').closest('tr')!).getByRole('checkbox')).toBeChecked());
  });
});

const research = (over: Partial<ResearchPage> = {}): ResearchPage => ({
  status: 'Researching', paused: false, stopReason: null, total: 3, done: 1, etaMinutes: 25,
  tiles: { everything: 0, some: 0, nothing: 1 },
  claude: { on: true, runsThisMonth: 146, cap: 300 },
  engine: { claude: 'sonnet' },
  items: [
    row(21, { companyName: 'Quantum Pharma Pvt Ltd', country: 'India' }, 'Missing details', {
      researchStatus: 'failed', researchNote: [{ k: 'researchFailed' }],
    }),
    row(22, { companyName: 'Brightline Dental Clinics', country: 'Canada' }, 'Missing details', {
      researchStatus: 'everything',
      research: { website: { value: 'brightlinedental.ca', sourceUrl: 'https://brightlinedental.ca', sourceLabel: 'website search', confidence: 90 } },
    }),
  ],
  activity: [{ at: '2026-11-24T14:29:00Z', code: 'started', params: { n: 3, engine: { claude: 'sonnet' } } }],
  ...over,
});

describe('step 3: AI research', () => {
  const renderResearch = (view: ResearchPage) => {
    const fetchFn = stubFetch((url, init) => {
      if (url === '/api/imports/batches/7') return Response.json(batch('Researching'));
      if (url.startsWith('/api/imports/batches/7/research?')) return Response.json(view);
      if (url === '/api/imports/batches/7/research/pause' && init?.method === 'POST') return Response.json({ paused: true });
      return undefined;
    });
    renderPage('/leads/import?batch=7&step=3');
    return fetchFn;
  };

  it('running: badge, progress, a failed row reads Found nothing with its note, AI values with source; Pause calls the route', async () => {
    const fetchFn = renderResearch(research());
    expect(await screen.findByText('Running · one company at a time')).toHaveClass('badge', 'b-purple');
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    expect(screen.getByText('about 25 min left')).toBeInTheDocument();
    expect(screen.getByText('146 / 300')).toBeInTheDocument();
    const failed = screen.getByText('Quantum Pharma Pvt Ltd').closest('tr')!;
    expect(within(failed).getByText('Found nothing')).toHaveClass('badge', 'b-grey');
    expect(within(failed).getByText('Research failed')).toHaveClass('cell-sub');
    const bright = screen.getByText('Brightline Dental Clinics').closest('tr')!;
    expect(within(bright).getByText('Done')).toHaveClass('b-ok');
    expect(within(bright).getByText('website search · 90%')).toHaveClass('cell-sub');
    // A website value is never a link here.
    expect(within(bright).queryByRole('link')).toBeNull();
    expect(screen.getByText('Started research for 3 rows · Website reader + Claude Code sonnet')).toBeInTheDocument();
    expect(screen.getByText('14:29')).toHaveClass('ag-time');
    expect(screen.queryByText(/daily/i)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls(fetchFn, 'POST', '/api/imports/batches/7/research/pause')).toHaveLength(1));
  });

  it('Claude off: only the website reader runs', async () => {
    renderResearch(research({ claude: { on: false, runsThisMonth: 0, cap: 300 } }));
    expect(await screen.findByText('Claude Code is off: only the website reader runs.')).toHaveClass('note', 'info');
  });

  it('a cap stop: Stopped, the cap note, and Resume disabled while the cap is still reached', async () => {
    renderResearch(research({ status: 'Waiting for review', stopReason: 'cap', claude: { on: true, runsThisMonth: 300, cap: 300 } }));
    expect(await screen.findByText('Stopped')).toHaveClass('b-warn');
    // One note for the one problem: stopped at the cap, and what to do before Resume works.
    expect(
      screen.getByText("Claude's monthly run cap is reached. Research stopped; the remaining rows stay Missing details. Raise the cap in Settings or switch Claude off to resume."),
    ).toHaveClass('note', 'warn');
    expect(document.querySelectorAll('.note.warn')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByText(/daily/i)).toBeNull();
  });
});

const review = (over: Partial<ReviewView> = {}): ReviewView => ({
  willImport: 412, newCompanies: 371, existingCompanies: 41,
  skipped: { total: 56, alreadyInCrm: 39, notLead: 7, unticked: 10, other: 0 },
  noContactRows: 14, researchOnlyCountry: 0, unknownCountries: [{ value: 'Chile', count: 2 }, { value: 'Mexico', count: 1 }],
  leadType: 'Prospect', language: 'en', source: 'Import · IMPORT-2026-11-24',
  allocation: [{ name: 'English market (US and Canada)', people: ['Deepak', 'Lakshita'] }],
  ...over,
});

describe('step 4: review and import', () => {
  const renderReview = (view: ReviewView, me: Me = manager, extra: Handler = () => undefined) => {
    const fetchFn = stubFetch((url, init) => {
      const more = extra(url, init);
      if (more) return more;
      if (url === '/api/imports/batches/7') return Response.json(batch('Waiting for review'));
      // As the server: rows with no email or phone count as imports only with "Import them" (undecided or left out: not).
      if (url.startsWith('/api/imports/batches/7/review?')) {
        return Response.json(url.includes('noContactRows=import') ? view : { ...view, willImport: view.willImport - view.noContactRows });
      }
      if (url === '/api/imports/batches/7/import' && init?.method === 'POST') return Response.json({ id: 7, status: 'Importing' }, { status: 202 });
      return undefined;
    });
    renderPage('/leads/import?batch=7&step=4', me);
    return fetchFn;
  };

  it('both boxes start unticked and neither choice is made; Import stays off (undecided rows not counted) until chosen', async () => {
    const fetchFn = renderReview(review());
    expect(await screen.findByRole('checkbox', { name: 'Accept research values with confidence 80% or higher' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Send each assignee one notification for the batch' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Import them' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Leave them out' })).not.toBeChecked();
    expect(screen.getByText('as Prospects · English')).toBeInTheDocument();
    expect(screen.getByText('39 already in CRM · 7 not leads · 10 unticked')).toBeInTheDocument();
    expect(screen.getByText('English market (US and Canada) → Deepak, Lakshita')).toBeInTheDocument();
    expect(screen.getByText('Import · IMPORT-2026-11-24')).toBeInTheDocument();
    // 412 includes the 14 rows with no email or phone: until the choice they are not counted, and Import is off.
    const off = screen.getByRole('button', { name: 'Import 398 prospects' });
    expect(off).toBeDisabled();
    const hint = screen.getByText('Choose Import them or Leave them out to continue.');
    expect(hint).toHaveAttribute('role', 'status');
    expect(off).toHaveAttribute('aria-describedby', hint.id);
    expect(screen.getByRole('radiogroup', { name: 'Rows with no email or phone' })).toHaveAttribute('aria-describedby', hint.id);
    await userEvent.click(off);
    expect(calls(fetchFn, 'POST', '/api/imports/batches/7/import')).toHaveLength(0);

    await userEvent.click(screen.getByRole('radio', { name: 'Import them' }));
    expect(await screen.findByRole('button', { name: 'Import 412 prospects' })).toBeEnabled();
    expect(screen.queryByText('Choose Import them or Leave them out to continue.')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Leave them out' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Import 398 prospects' }));
    await waitFor(() => expect(calls(fetchFn, 'POST', '/api/imports/batches/7/import')).toHaveLength(1));
    expect(bodyOf(fetchFn, 'POST', '/api/imports/batches/7/import')).toEqual({ acceptHigh: false, noContactRows: 'leave', notify: false });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/leads/import/manager?batch=7'));
  });

  it('unknown countries: a Manager is told to ask an Administrator; an Administrator gets the link', async () => {
    renderReview(review());
    expect(await screen.findByText(/Ask an Administrator to add these countries/)).toBeInTheDocument();
    expect(screen.getByText(/3 rows have a country the CRM doesn't know yet \(Chile ×2, Mexico ×1\)/)).toHaveClass('note', 'warn');
    expect(screen.queryByRole('link', { name: 'Add these countries' })).toBeNull();
  });

  it('an Administrator corrects the names in a dialog; the server adds them, maps the file spelling and matches again', async () => {
    const fetchFn = renderReview(review(), admin, (url, init) => {
      if (url === '/api/imports/batches/7/countries' && init?.method === 'POST') return Response.json({ countries: ['Chile', 'México'], tiles: {} });
      if (url === '/api/lookups') return Response.json({ groups: {} });
      return undefined;
    });
    await userEvent.click(await screen.findByRole('link', { name: 'Add these countries' }));
    const dialog = screen.getByRole('dialog', { name: 'Add these countries' });
    expect(within(dialog).getByLabelText('Chile (2 rows)')).toHaveValue('Chile');
    const mexico = within(dialog).getByLabelText('Mexico (1 row)');
    await userEvent.clear(mexico);
    await userEvent.type(mexico, 'México');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add countries' }));
    await waitFor(() => expect(calls(fetchFn, 'POST', '/api/imports/batches/7/countries')).toHaveLength(1));
    expect(bodyOf(fetchFn, 'POST', '/api/imports/batches/7/countries')).toEqual({
      countries: [{ from: 'Chile', to: 'Chile' }, { from: 'Mexico', to: 'México' }],
    });
    expect(calls(fetchFn, 'POST', '/api/lookups')).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a refused "Add these countries" is shown in the dialog, and the error is gone when it is opened again', async () => {
    renderReview(review(), admin, (url) => {
      if (url === '/api/imports/batches/7/countries') return Response.json({ error: 'batch_locked' }, { status: 409 });
      return undefined;
    });
    await userEvent.click(await screen.findByRole('link', { name: 'Add these countries' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add countries' }));
    expect(await within(screen.getByRole('dialog')).findByText('This import has already started and can no longer be changed.')).toHaveClass('note', 'danger');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('link', { name: 'Add these countries' }));
    expect(within(screen.getByRole('dialog')).queryByText('This import has already started and can no longer be changed.')).toBeNull();
  });

  it('a country only from research is a plain line with no extra choice; the download carries the choices', async () => {
    renderReview(review({ noContactRows: 0, researchOnlyCountry: 2, unknownCountries: [] }));
    expect(
      await screen.findByText('2 rows have a country only from research. Tick Accept research values with confidence 80% or higher, or fix them in the rows-to-fix download.'),
    ).toHaveClass('info-text');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Download rows to fix (Excel)' })).toHaveAttribute('href', '/api/imports/batches/7/rows-to-fix.xlsx?acceptHigh=0');
  });

  it('nothing needs the user: says so', async () => {
    renderReview(review({ noContactRows: 0, researchOnlyCountry: 0, unknownCountries: [], willImport: 1, leadType: 'Lead' }));
    expect(await screen.findByText('No rows need you.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 lead' })).toBeEnabled();
  });
});

describe('page and Leads list', () => {
  const leadsHandler: Handler = (url) => {
    if (url.startsWith('/api/leads?')) {
      return Response.json({
        items: [], total: 0, page: 1, pageSize: 50,
        tiles: { newThisWeek: 0, followUpsDueToday: 0, unassigned: 0, unassignedProspects: 0, unassignedLeads: 0 },
        counts: { all: 0, lead: 0, prospect: 0, mine: 0, overdue: 0 },
      });
    }
    if (url === '/api/users') return Response.json([]);
    if (url === '/api/mailboxes') return Response.json({ mine: null });
    return undefined;
  };

  it('a Manager has "Import leads" (no "Import CSV"); it opens the import page', async () => {
    stubFetch(leadsHandler);
    renderPage('/leads', manager);
    const link = await screen.findByRole('link', { name: 'Import leads' });
    expect(link).toHaveAttribute('href', '/leads/import');
    expect(screen.queryByText('Import CSV')).toBeNull();
  });

  it('a Sales Representative has no Import leads button and is refused the page', async () => {
    stubFetch(leadsHandler);
    renderPage('/leads', rep);
    expect(await screen.findByRole('button', { name: /New lead/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import leads' })).toBeNull();
    expect(screen.queryByText('Import CSV')).toBeNull();
  });

  it('a Sales Representative opening /leads/import sees AccessDenied', () => {
    stubFetch();
    renderPage('/leads/import', rep);
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have access');
  });

  it('page chrome: crumb, title, tabs with the batch count', async () => {
    stubFetch();
    renderPage('/leads/import');
    expect(screen.getByRole('heading', { level: 1, name: 'Import leads' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Leads' })).toHaveClass('btn');
    const tabs = screen.getByRole('tablist', { name: 'Import views' });
    expect(tabs).toHaveClass('tabs', 'profile-tabs');
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: /Data manager/ })).toHaveTextContent('Data manager 4'));
  });
});
