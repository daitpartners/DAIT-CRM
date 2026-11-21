import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { keys, type LookupValue, type Me, type UserSummary } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { LeadModal } from '../src/pages/leads/LeadModal';

const admin: Me = {
  id: 1, email: 'maya@daitpartners.com', name: 'Maya Pillai', role: 'Administrator', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'view_all_leads', 'manage_companies'],
};
const rep: Me = { ...admin, id: 2, name: 'Arjun Mehta', role: 'Sales Representative', rights: ['manage_leads', 'claim_leads'] };

const lookup = (group: LookupValue['group'], value: string, id: number): LookupValue => ({
  id, group, value, label: value, labelEs: null, labelFr: null, sortOrder: id, isActive: true,
});
const user = (id: number, name: string, isActive = true): UserSummary => ({
  id, name, email: `${id}@x.com`, role: 'Sales Representative', language: 'en', timezone: 'UTC', isActive, lastLoginAt: null,
});

// Companies the user may open come with their details (a hidden one carries id, number and name only).
const northwind = { id: 3, number: 'CO-0318', name: 'Northwind Logistics', legalName: null, domain: 'northwindlogistics.in', country: 'India', city: 'Pune' };
const meridian = { id: 4, number: 'CO-0245', name: 'Meridian Textiles', legalName: null, domain: null, country: 'United Kingdom', city: null };
const emptyPage = { items: [], total: 0, page: 1, pageSize: 100 };

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** Stubs fetch: `handler` answers first, then the company / contact pickers get empty pages. */
function stubFetch(handler: Handler) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const res = handler(url, init);
    if (res) return res;
    if (url.startsWith('/api/companies?') || url.startsWith('/api/contacts?')) return Response.json(emptyPage);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderModal(me: Me = admin, onClose = () => {}) {
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
        <MemoryRouter>
          <LeadModal onClose={onClose} />
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

describe('LeadModal', () => {
  it('offers an automatic company match without blocking, and links it', async () => {
    const u = userEvent.setup();
    const onClose = vi.fn();
    const fetchFn = stubFetch((url) => {
      if (url === '/api/leads/check-duplicates') return Response.json({ auto: northwind, review: [] });
      if (url === '/api/leads') return Response.json({ id: 9, number: 'LD-1009' }, { status: 201 });
      return undefined;
    });
    renderModal(admin, onClose);
    await u.type(screen.getByLabelText(/Company name/), 'Northwind Logistics');
    await u.type(screen.getByLabelText(/Website/), 'https://northwindlogistics.in');

    const note = await screen.findByText(/This company exists: CO-0318 Northwind Logistics/);
    expect(note.closest('.note')).not.toHaveClass('danger');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    await u.click(screen.getByRole('button', { name: 'Link to CO-0318' }));
    expect(screen.getByRole('combobox', { name: 'Link to existing company' })).toHaveValue('Northwind Logistics');

    await u.selectOptions(screen.getByLabelText(/Country/), 'India');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sentBody(fetchFn, '/api/leads')).toMatchObject({
      companyName: 'Northwind Logistics', linkCompanyId: 3, country: 'India', leadSource: 'Manual Entry', status: 'New',
    });
  });

  it('lists review matches in an amber note with a Link button each', async () => {
    const u = userEvent.setup();
    stubFetch((url) =>
      url === '/api/leads/check-duplicates'
        ? Response.json({ auto: null, review: [{ candidate: meridian, how: 'name_country' }] })
        : undefined,
    );
    renderModal();
    await u.type(screen.getByLabelText(/Company name/), 'Meridian Textiles');

    const note = (await screen.findByText('Possible duplicates')).closest('.note') as HTMLElement;
    expect(note).toHaveClass('warn');
    expect(note).toHaveTextContent('CO-0245 Meridian Textiles');
    expect(note).toHaveTextContent('the lead is saved without a company until one is chosen on the lead page');
    await u.click(within(note).getByRole('button', { name: 'Link' }));
    expect(screen.getByRole('combobox', { name: 'Link to existing company' })).toHaveValue('Meridian Textiles');
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
    renderModal();
    await u.type(screen.getByLabelText(/Company name/), 'Acme Retail');
    await u.type(screen.getByLabelText(/Website/), 'https://acme.example');
    await u.selectOptions(screen.getByLabelText(/Country/), 'Germany');
    await u.click(screen.getByRole('button', { name: 'Save' }));

    const msg = 'Enter a valid web address, for example https://example.com';
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.getByLabelText(/Website/)).toHaveAccessibleDescription(msg);
    expect(await screen.findByText('Please check the highlighted fields')).toHaveClass('note');
  });

  it('offers a sales representative only Me and Unassigned', () => {
    stubFetch(() => undefined);
    renderModal(rep);
    const options = within(screen.getByLabelText('Assigned to')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Unassigned', 'Me']);
  });
});
