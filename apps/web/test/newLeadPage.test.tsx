import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { keys, type LookupValue, type Me, type UserSummary } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { NewLeadPage } from '../src/pages/leads/NewLeadPage';

const admin: Me = {
  id: 1, email: 'maya@daitpartners.com', name: 'Maya Pillai', role: 'Administrator', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'view_all_leads', 'manage_companies'],
};
const rep: Me = { ...admin, id: 2, name: 'Arjun Mehta', role: 'Sales Representative', rights: ['manage_leads', 'claim_leads'] };
const viewer: Me = { ...admin, id: 3, name: 'Dev Researcher', role: 'Data Research User', rights: [] };

const lookup = (group: LookupValue['group'], value: string, id: number): LookupValue => ({
  id, group, value, label: value, labelEs: null, labelFr: null, sortOrder: id, isActive: true,
});
const user = (id: number, name: string, isActive = true): UserSummary => ({
  id, name, email: `${id}@x.com`, role: 'Sales Representative', language: 'en', timezone: 'UTC', isActive, lastLoginAt: null,
});

// Companies the user may open come with their details (a hidden one carries id, number and name only).
const northwind = { id: 3, number: 'CO-0318', name: 'Northwind Logistics', legalName: null, domain: 'northwindlogistics.in', country: 'India', city: 'Pune' };
const meridian = { id: 4, number: 'CO-0245', name: 'Meridian Textiles', legalName: null, domain: null, country: 'United Kingdom', city: null };
const northwindDetail = {
  ...northwind, website: 'https://northwindlogistics.in', industry: 'Logistics', employeeRange: '201-500', status: 'Active',
  verificationStatus: 'Partially Verified', contactCount: 2,
};
const pipeline = { byStatus: [{ status: 'Contacted', count: 1 }], open: 1, won: 0, lost: 0 };
const emptyPage = { items: [], total: 0, page: 1, pageSize: 100 };
const contact = (id: number, firstName: string, isPrimary: boolean, businessEmail: string | null) => ({
  id, companyId: 3, firstName, lastName: 'Raman', designation: 'Head of Operations', contactType: 'Decision maker', isPrimary,
  isActive: true, businessEmail,
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Stubs fetch: `handler` answers first; Northwind's detail and pipeline, and empty picker pages, after it. */
function stubFetch(handler: Handler) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const res = handler(url, init);
    if (res) return res;
    if (url === '/api/companies/3') return Response.json(northwindDetail);
    if (url === '/api/companies/3/pipeline') return Response.json(pipeline);
    if (url.startsWith('/api/companies?') || url.startsWith('/api/contacts?')) return Response.json(emptyPage);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPage(me: Me = admin, path = '/leads/new') {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(keys.me, me);
  qc.setQueryData(keys.users, [user(1, 'Maya Pillai'), user(2, 'Arjun Mehta'), user(5, 'Gone Person', false)]);
  qc.setQueryData(keys.lookups, {
    country: [lookup('country', 'India', 1), lookup('country', 'Germany', 2)],
    lead_source: [lookup('lead_source', 'Manual Entry', 3), lookup('lead_source', 'Referral', 4)],
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/leads/new" element={<NewLeadPage />} />
            <Route path="/leads/:id" element={<p>lead page</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const sentBody = (fetchFn: ReturnType<typeof stubFetch>, url: string) => {
  const call = fetchFn.mock.calls.find(([u, init]) => u === url && init?.method === 'POST');
  return call ? JSON.parse(String(call[1]!.body)) : undefined;
};

afterEach(() => vi.unstubAllGlobals());

describe('NewLeadPage', () => {
  it('shows a domain match, uses the existing company, then creates the lead and opens it', async () => {
    const u = userEvent.setup();
    const fetchFn = stubFetch((url) => {
      if (url === '/api/leads/check-duplicates') return Response.json({ auto: northwind, review: [] });
      if (url === '/api/leads') return Response.json({ id: 9, number: 'LD-1009' }, { status: 201 });
      return undefined;
    });
    renderPage();
    await u.type(screen.getByLabelText(/Company name/), 'Northwind Logistics');
    await u.type(screen.getByLabelText(/Company website/), 'https://northwindlogistics.in');

    const title = await screen.findByText('Possible duplicate: 1 existing company matches');
    const panel = title.closest('.note') as HTMLElement;
    expect(panel).toHaveClass('warn');
    await waitFor(() => expect(panel).toHaveTextContent('Northwind Logistics · northwindlogistics.in · India · 2 contacts · 1 open leads'));
    expect(panel).toHaveTextContent('Matched on exact website domain · confidence High.');
    expect(within(panel).getByRole('link', { name: 'View' })).toHaveAttribute('href', '/companies/3');

    await u.click(within(panel).getByRole('button', { name: 'Use existing company' }));
    expect(screen.getByRole('combobox', { name: 'Company (existing record)' })).toHaveValue('CO-0318 · Northwind Logistics');
    expect(await screen.findByText('Linked to existing company CO-0318 · Northwind Logistics (matched on exact website domain).')).toBeVisible();
    const preview = screen.getByRole('region', { name: 'Linked company preview' });
    await waitFor(() => expect(preview).toHaveTextContent('Open leads1 · Contacted 1'));
    expect(preview).toHaveTextContent('Partially verified');

    await u.selectOptions(screen.getByLabelText(/Country/), 'India');
    await u.click(screen.getByRole('button', { name: 'Create lead' }));
    expect(await screen.findByText('lead page')).toBeInTheDocument();
    expect(sentBody(fetchFn, '/api/leads')).toMatchObject({
      companyName: 'Northwind Logistics', linkCompanyId: 3, country: 'India', leadSource: 'Manual Entry', status: 'New', assignedToId: 1,
    });
  });

  it('lists review matches as not auto-merged, and says when nothing matches', async () => {
    const u = userEvent.setup();
    stubFetch((url, init) => {
      if (url !== '/api/leads/check-duplicates') return undefined;
      const name = JSON.parse(String(init!.body)).name as string;
      return Response.json(name.startsWith('Meridian') ? { auto: null, review: [{ candidate: meridian, how: 'name_country' }] } : { auto: null, review: [] });
    });
    renderPage();
    await u.type(screen.getByLabelText(/Company name/), 'Meridian Textiles');
    const panel = (await screen.findByText('Possible duplicate: 1 existing company matches')).closest('.note') as HTMLElement;
    expect(panel).toHaveTextContent('Matched on normalised name + country · confidence Medium. Not auto-merged: please confirm.');

    await u.clear(screen.getByLabelText(/Company name/));
    await u.type(screen.getByLabelText(/Company name/), 'Brand New Co');
    expect(await screen.findByText(/No duplicate found for this name, website or email domain/)).toHaveClass('ok');
  });

  it('maps a 400 with array issue paths onto the field and shows the form note', async () => {
    const u = userEvent.setup();
    stubFetch((url) => {
      if (url === '/api/leads/check-duplicates') return Response.json({ auto: null, review: [] });
      if (url === '/api/leads') {
        return Response.json({ error: 'validation', issues: [{ path: ['website'], message: 'x' }] }, { status: 400 });
      }
      return undefined;
    });
    renderPage();
    await u.type(screen.getByLabelText(/Company name/), 'Acme Retail');
    await u.type(screen.getByLabelText(/Company website/), 'https://acme.example');
    await u.selectOptions(screen.getByLabelText(/Country/), 'Germany');
    await u.click(screen.getByRole('button', { name: 'Create lead' }));

    const msg = 'Enter a valid web address, for example https://example.com';
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.getByLabelText(/Company website/)).toHaveAccessibleDescription(msg);
    expect(await screen.findByText('Please check the highlighted fields')).toHaveClass('note');
  });

  it('offers a sales representative only themselves or the allocation rules, defaulting to themselves', () => {
    stubFetch(() => undefined);
    renderPage(rep);
    const select = screen.getByLabelText('Assigned to') as HTMLSelectElement;
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Leave unassigned · allocation rules decide', 'Arjun Mehta (me)']);
    expect(select.value).toBe('2');
  });

  it('?company= links the company, fills its details and preselects the primary contact', async () => {
    stubFetch((url) => {
      if (url === '/api/leads/check-duplicates') return Response.json({ auto: null, review: [{ candidate: northwind, how: 'name_country' }] });
      if (url.startsWith('/api/contacts?companyId=3')) {
        return Response.json({ ...emptyPage, items: [contact(11, 'Anil', false, null), contact(12, 'Priya', true, 'priya@northwindlogistics.in')], total: 2 });
      }
      return undefined;
    });
    renderPage(admin, '/leads/new?company=3');
    await waitFor(() => expect(screen.getByLabelText(/Company name/)).toHaveValue('Northwind Logistics'));
    expect(screen.getByRole('combobox', { name: 'Company (existing record)' })).toHaveValue('CO-0318 · Northwind Logistics');
    await waitFor(() => expect(screen.getByLabelText('Contact person')).toHaveValue('12'));
    expect(screen.getByLabelText(/Business email/)).toHaveValue('priya@northwindlogistics.in');
    expect(screen.getByLabelText(/City/)).toHaveValue('Pune');
    expect(await screen.findByText('Linked to existing company CO-0318 · Northwind Logistics (matched on normalised name + country).')).toBeVisible();
  });

  it('denies a user without manage_leads', () => {
    stubFetch(() => undefined);
    renderPage(viewer);
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have access');
    expect(screen.queryByRole('button', { name: 'Create lead' })).toBeNull();
  });
});
