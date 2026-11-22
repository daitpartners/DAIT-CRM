import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { CompanyDetail } from '../src/api/companies';
import type { Dashboard as DashboardData } from '../src/api/dashboard';
import type { Me } from '../src/api/queries';
import type { QuotationList, QuotationListItem } from '../src/api/quotations';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { Sidebar } from '../src/components/Sidebar';
import { ToastProvider } from '../src/components/Toast';
import { Dashboard } from '../src/pages/Dashboard';
import { CompanyProfile } from '../src/pages/companies/CompanyProfile';
import { QuotationsPage } from '../src/pages/quotations/QuotationsPage';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const seller: Me = { ...rep, rights: [...rep.rights, 'manage_quotes', 'use_email'] };
const researcher: Me = { ...rep, id: 7, name: 'Dev Rao', role: 'Data Research User', rights: ['manage_companies'] };

function quote(o: Partial<QuotationListItem>): QuotationListItem {
  return {
    id: 1, number: 'Q-2026-001', status: 'Draft', revision: 1, editingNewRevision: false,
    company: { id: 4, number: 'CO-0245', name: 'Meridian', legalName: 'Meridian Textiles Pvt Ltd' },
    contact: { id: 9, name: 'Tom Hale' }, lead: { id: 5, number: 'LD-1005', status: 'Qualified' }, owner: { id: 2, name: 'Arjun Mehta' },
    quotationDate: '2026-11-20', validUntil: '2026-12-20', subject: 'Advisory services for Meridian', currency: 'INR', total: 1180,
    projectId: null, expiringSoon: false, ...o,
  };
}

const ITEMS: QuotationListItem[] = [
  quote({ id: 3, number: 'Q-2026-003', status: 'Sent', revision: 2, total: 450000, validUntil: '2026-11-25', expiringSoon: true }),
  quote({
    id: 2, number: 'Q-2026-002', status: 'Accepted', currency: 'USD', total: 12000, contact: null, lead: null,
    company: { id: 6, number: 'CO-0300', name: 'Orbit Labs', legalName: null }, quotationDate: '2026-11-18', validUntil: null,
  }),
  quote({ id: 1 }),
];

const LIST: QuotationList = {
  items: ITEMS,
  counts: { all: 5, draft: 1, sent: 2, accepted: 1, closed: 1 },
  tiles: {
    openCount: 2,
    openSums: [{ currency: 'USD', amount: 12000 }, { currency: 'INR', amount: 450000.5 }],
    acceptedCount: 1,
    acceptedSums: [{ currency: 'USD', amount: 12000 }],
    expiringSoon: [{ id: 3, number: 'Q-2026-003', validUntil: '2026-11-25' }],
    winRate: 25,
    sentCount: 4,
  },
};

/** The user `mount` signs in (also answers `/api/me` refetches). */
let signedIn: Me = seller;

type Call = { method: string; url: string; body?: Record<string, unknown> };

/** Leads the user can see at company 4 (newest first, as the API lists them). */
const COMPANY_LEADS = [
  { id: 8, number: 'LD-1008', companyId: 4, companyName: 'Meridian', contact: { id: 9, name: 'Tom Hale' }, status: 'New', archivedAt: null },
  { id: 5, number: 'LD-1005', companyId: 4, companyName: 'Meridian', contact: null, status: 'Qualified', archivedAt: null },
];

/** `fixed` answers exact GET URLs (the company detail, the dashboard). */
function stub(list: QuotationList = LIST, leads = COMPANY_LEADS, fixed: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (url in fixed) return Response.json(fixed[url]);
    if (url === '/api/me') return Response.json(signedIn);
    if (url === '/api/quotations' && init?.method === 'POST') return Response.json({ id: 42, number: 'Q-2026-042' }, { status: 201 });
    if (url.startsWith('/api/quotations')) return Response.json(list);
    if (url.startsWith('/api/companies?')) {
      return Response.json({
        items: [{ id: 4, number: 'CO-0245', name: 'Meridian', status: 'Active' }, { id: 6, number: 'CO-0300', name: 'Orbit Labs', status: 'Active' }],
        total: 2, page: 1, pageSize: 100,
      });
    }
    if (url.startsWith('/api/leads')) return Response.json({ items: leads, total: leads.length, page: 1, pageSize: 100 });
    if (url.endsWith('/locations')) return Response.json({ items: [] });
    if (url.endsWith('/pipeline')) return Response.json({ byStatus: [], open: 2, won: 0, lost: 0 });
    if (url.includes('/activities')) return Response.json({ items: [], total: 0, page: 1, pageSize: 20, summary: null });
    if (url === '/api/nav-counts') return Response.json({ leads: 0, overdueTasks: 0, unread: 0, mailUnread: 0, mailerLive: 0 });
    return Response.json({});
  }));
  return calls;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function mount(ui: React.ReactNode, { me = seller, at = '/quotations', path = '/quotations' }: { me?: Me; at?: string; path?: string } = {}) {
  signedIn = me;
  const qc = makeClient(me);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[at]}>
            <Routes>
              <Route path={path} element={ui} />
              <Route path="*" element={null} />
            </Routes>
            <Where />
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return qc;
}

describe('Quotations list (prototype V.quotes)', () => {
  it('shows the prototype tiles, with sums per currency and ".00" dropped', async () => {
    stub();
    mount(<QuotationsPage />);
    await screen.findByText('Win rate');
    const tile = async (label: string) => within(document.querySelector('.tiles') as HTMLElement).getByText(label).closest('.tile') as HTMLElement;
    const open = await tile('Open value (sent + negotiating)');
    await waitFor(() => expect(open.querySelector('.v')).toHaveTextContent('2'));
    expect(open.querySelector('.m')).toHaveTextContent('USD 12,000 · INR 4,50,000.50');
    const accepted = await tile('Accepted');
    expect(accepted.querySelector('.v')).toHaveTextContent('1');
    expect(accepted.querySelector('.m.ok')).toHaveTextContent('USD 12,000');
    const expiring = await tile('Expiring within 7 days');
    expect(expiring.querySelector('.v')).toHaveTextContent('1');
    expect(expiring.querySelector('.m.bad')).toHaveTextContent('Q-2026-003 · 25/11/2026');
    const win = await tile('Win rate');
    expect(win.querySelector('.v')).toHaveTextContent('25%');
    expect(win.querySelector('.m')).toHaveTextContent('1 of 4 sent');
  });

  it('a dash when there is nothing to sum or nothing expiring', async () => {
    stub({ ...LIST, items: [], tiles: { ...LIST.tiles, openCount: 0, openSums: [], acceptedCount: 0, acceptedSums: [], expiringSoon: [], winRate: 0, sentCount: 0 } });
    mount(<QuotationsPage />);
    expect(await screen.findByText('No quotations.')).toBeTruthy();
    const open = screen.getByText('Open value (sent + negotiating)').closest('.tile') as HTMLElement;
    expect(open.querySelector('.m')).toHaveTextContent('—');
    expect((screen.getByText('Expiring within 7 days').closest('.tile') as HTMLElement).querySelector('.m')).toHaveTextContent('—');
  });

  it('tabs with counts, columns in prototype order, rows as the prototype', async () => {
    stub();
    mount(<QuotationsPage />);
    const tabs = await screen.findAllByRole('tab');
    await waitFor(() => expect(tabs[0]).toHaveTextContent('All 5'));
    expect(tabs.map((x) => x.textContent)).toEqual(['All 5', 'Draft 1', 'Sent / Negotiating 2', 'Accepted 1', 'Rejected / Expired 1']);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Quotation no.', 'Company', 'Contact', 'Lead', 'Date', 'Valid until', 'Total', 'Rev.', 'Status', 'Owner', '']);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const sent = rows[0]!;
    expect(within(sent).getByRole('link', { name: 'Q-2026-003' })).toHaveAttribute('href', '/quotations/3');
    expect(within(sent).getByRole('link', { name: 'Meridian Textiles Pvt Ltd' })).toHaveAttribute('href', '/companies/4');
    expect(within(sent).getByRole('link', { name: 'LD-1005' })).toHaveAttribute('href', '/leads/5');
    expect(sent).toHaveTextContent('Tom Hale');
    expect(sent).toHaveTextContent('20/11/2026');
    // Expiring within 7 days: the date in red.
    expect(within(sent).getByText('25/11/2026')).toHaveClass('q-exp');
    expect(sent).toHaveTextContent('INR 4,50,000.00');
    expect(sent).toHaveTextContent('rev 2');
    expect(within(sent).getByText('Sent')).toHaveClass('badge', 'b-purple');
    expect(sent).toHaveTextContent('Arjun Mehta');
    expect(within(sent).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/quotations/3');

    const acc = rows[1]!;
    expect(within(acc).getByRole('link', { name: 'Orbit Labs' })).toBeTruthy();
    expect(within(acc).getByText('Accepted')).toHaveClass('badge', 'b-ok');
    expect(acc).toHaveTextContent('USD 12,000.00');
    // No contact, no lead, no valid-until date: dashes.
    expect(within(acc).getAllByText('—')).toHaveLength(3);
    expect(within(acc).getByRole('link', { name: 'Convert to project' })).toHaveAttribute('href', '/quotations/2');

    expect(within(rows[2]!).getByText('Draft')).toHaveClass('badge', 'b-grey');
  });

  it('the tab and the search go to the URL and the request', async () => {
    const calls = stub();
    const u = userEvent.setup();
    mount(<QuotationsPage />);
    await u.click(await screen.findByRole('tab', { name: /Sent \/ Negotiating/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/quotations?tab=sent');
    await waitFor(() => expect(calls.some((c) => c.url.includes('tab=sent'))).toBe(true));
    await u.type(screen.getByRole('searchbox', { name: 'Search quotations' }), 'orbit');
    expect(screen.getByPlaceholderText('Search number, company, lead…')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/quotations?tab=sent&q=orbit'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/quotations?tab=sent&s=orbit')).toBe(true));
  });

  it('New quotation: pick a company and optionally its lead, create, open the editor', async () => {
    const calls = stub();
    const u = userEvent.setup();
    mount(<QuotationsPage />);
    await u.click(await screen.findByRole('button', { name: 'New quotation' }));
    const dialog = screen.getByRole('dialog', { name: 'New quotation' });
    await u.click(within(dialog).getByRole('button', { name: 'Create quotation' }));
    expect(await screen.findByText('Choose a company')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await u.click(within(dialog).getByRole('combobox', { name: /Company/ }));
    await u.click(await within(dialog).findByRole('option', { name: 'CO-0245 · Meridian' }));
    const lead = await within(dialog).findByRole('combobox', { name: 'Lead' });
    await waitFor(() => expect(within(lead).getAllByRole('option').map((o) => o.textContent)).toEqual(['— no lead —', 'LD-1008 · Tom Hale', 'LD-1005']));
    expect(calls.some((c) => c.url.startsWith('/api/leads?') && c.url.includes('companyId=4'))).toBe(true);
    await u.selectOptions(lead, '5');
    await u.click(within(dialog).getByRole('button', { name: 'Create quotation' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/quotations/42'));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/quotations', body: { companyId: 4, leadId: 5 } });
  });

  it('without a lead chosen the quotation is created for the company alone', async () => {
    const calls = stub();
    const u = userEvent.setup();
    mount(<QuotationsPage />);
    await u.click(await screen.findByRole('button', { name: 'New quotation' }));
    const dialog = screen.getByRole('dialog', { name: 'New quotation' });
    await u.click(within(dialog).getByRole('combobox', { name: /Company/ }));
    await u.click(await within(dialog).findByRole('option', { name: 'CO-0300 · Orbit Labs' }));
    await u.click(within(dialog).getByRole('button', { name: 'Create quotation' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/quotations/42'));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ companyId: 6 });
  });

  it('no New quotation for a user without manage_quotes (Data Research User)', async () => {
    stub();
    mount(<QuotationsPage />, { me: researcher });
    expect(await screen.findByText('Open value (sent + negotiating)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New quotation' })).toBeNull();
  });
});

const COMPANY = {
  id: 4, number: 'CO-0245', name: 'Meridian', legalName: null, status: 'Active', verificationStatus: 'Unverified', isClient: false,
  contactCount: 1, industry: null, city: null, country: 'India', employeeRange: null, domain: null, website: null,
} as unknown as CompanyDetail;

describe('Company page: New quotation (prototype views-companies.js)', () => {
  it("creates a quotation for the company with the first lead the user can see, then opens it", async () => {
    const calls = stub(LIST, COMPANY_LEADS, { '/api/companies/4': COMPANY });
    const u = userEvent.setup();
    mount(<CompanyProfile />, { at: '/companies/4#ai', path: '/companies/:id' });
    await u.click(await screen.findByRole('button', { name: 'New quotation' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/quotations/42'));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/quotations', body: { companyId: 4, leadId: 8 } });
  });

  it('no lead at the company: created for the company alone', async () => {
    const calls = stub(LIST, [], { '/api/companies/4': COMPANY });
    const u = userEvent.setup();
    mount(<CompanyProfile />, { at: '/companies/4#ai', path: '/companies/:id' });
    await u.click(await screen.findByRole('button', { name: 'New quotation' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/quotations/42'));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ companyId: 4 });
  });

  it('hidden without manage_quotes', async () => {
    stub(LIST, COMPANY_LEADS, { '/api/companies/4': COMPANY });
    mount(<CompanyProfile />, { me: researcher, at: '/companies/4#ai', path: '/companies/:id' });
    expect(await screen.findByRole('button', { name: 'Edit profile' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New quotation' })).toBeNull();
  });

  it("Leads tab: each lead's quotations and the open quotation value", async () => {
    stub({
      ...LIST,
      items: [
        quote({ id: 3, number: 'Q-2026-003', status: 'Sent', total: 450000, lead: { id: 8, number: 'LD-1008', status: 'New' } }),
        quote({ id: 1, number: 'Q-2026-001', status: 'Draft', total: 1180, lead: { id: 8, number: 'LD-1008', status: 'New' } }),
        quote({ id: 2, number: 'Q-2026-002', status: 'Accepted', currency: 'USD', total: 500, lead: null }),
      ],
    }, COMPANY_LEADS, { '/api/companies/4': COMPANY });
    mount(<CompanyProfile />, { at: '/companies/4#leads', path: '/companies/:id' });
    const row = (await screen.findByRole('link', { name: 'LD-1008' })).closest('tr')!;
    await waitFor(() => expect(within(row).getByRole('link', { name: 'Q-2026-003 · Sent' })).toHaveAttribute('href', '/quotations/3'));
    expect(within(row).getByRole('link', { name: 'Q-2026-001 · Draft' })).toBeTruthy();
    expect(row).toHaveTextContent('Q-2026-003 · Sent, Q-2026-001 · Draft');
    const pipeline = screen.getByRole('region', { name: 'Pipeline at this company' });
    expect(within(pipeline).getByText('Open quotation value').nextElementSibling).toHaveTextContent('INR 4,50,000.00 + INR 1,180.00');
  });
});

describe('Sidebar and dashboard', () => {
  it('Quotations sits after Calendar, with no badge', async () => {
    stub();
    mount(<Sidebar me={seller} open={false} onNavigate={() => {}} />, { at: '/', path: '/' });
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const links = within(nav).getAllByRole('link').map((a) => a.textContent);
    expect(links.indexOf('Quotations')).toBe(links.indexOf('Calendar') + 1);
    expect(within(nav).getByRole('link', { name: 'Quotations' })).toHaveAttribute('href', '/quotations');
    expect(within(nav).getByRole('link', { name: 'Quotations' }).querySelector('.cnt')).toBeNull();
  });

  const dash = (awaitingQuotes: DashboardData['awaitingQuotes']): DashboardData => ({
    greeting: { name: 'Arjun Mehta', date: '2026-11-22' },
    tiles: { myOpenLeads: 3, newSinceYesterday: 1, tasksDueToday: 2, overdue: 0, upcoming: 1, openTasks: 3, unreadNotifications: 0 },
    tasks: [], agenda: [], notifications: [], pipeline: [], closed: { won: 0, lost: 0 }, awaitingQuotes,
  });

  it('Quotes awaiting response: own Sent / Negotiating count, each total in the meta, links to the list', () => {
    stub(LIST, COMPANY_LEADS, { '/api/dashboard': dash([{ id: 3, currency: 'USD', total: 12000 }, { id: 4, currency: 'INR', total: 450000 }]) });
    mount(<Dashboard />, { at: '/', path: '/' });
    return waitFor(() => {
      const tile = screen.getByText('Quotes awaiting response').closest('a')!;
      expect(tile).toHaveAttribute('href', '/quotations');
      expect(tile.querySelector('.v')).toHaveTextContent('2');
      expect(tile.querySelector('.m')).toHaveTextContent('USD 12,000.00 · INR 4,50,000.00');
      expect(document.body.textContent).not.toMatch(/release 3/);
      expect(screen.getByText(/everything assigned to you across leads, email, calendar and quotations/)).toBeTruthy();
    });
  });

  it('none awaiting: 0 and a dash', async () => {
    stub(LIST, COMPANY_LEADS, { '/api/dashboard': dash([]) });
    mount(<Dashboard />, { at: '/', path: '/' });
    await waitFor(() => {
      const tile = screen.getByText('Quotes awaiting response').closest('a')!;
      expect(tile.querySelector('.v')).toHaveTextContent('0');
      expect(tile.querySelector('.m')).toHaveTextContent('—');
    });
  });
});
