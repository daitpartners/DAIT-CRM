import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { CompanyDetail } from '../src/api/companies';
import type { Me } from '../src/api/queries';
import type { ProjectFormOptions, ProjectRow } from '../src/api/projects';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { ToastProvider } from '../src/components/Toast';
import { CompanyProfile } from '../src/pages/companies/CompanyProfile';
import { ProjectsCard } from '../src/pages/projects/ProjectsCard';
import { makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const seller: Me = { ...rep, rights: [...rep.rights, 'manage_quotes', 'use_email'] };

function project(o: Partial<ProjectRow>): ProjectRow {
  return {
    id: 1, number: 'PRJ-1', name: 'Meridian · Warehouse automation', status: 'Active', startDate: '2026-11-20', value: 12000, currency: 'USD',
    company: { id: 4, name: 'Meridian', legalName: null }, lead: { id: 5, number: 'LD-1005', visible: true }, quotation: { id: 3, number: 'Q-2026-003' },
    manager: { id: 2, name: 'Arjun Mehta' }, stakeholders: [{ id: 9, name: 'Tom Hale', email: 'tom@meridian.in' }, { id: 10, name: 'Priya Nair', email: null }],
    description: null, completedAt: null, createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z', canEdit: true, ...o,
  };
}

const ROWS: ProjectRow[] = [
  project({ id: 2, number: 'PRJ-2', name: 'Meridian · Advisory', status: 'On hold', value: 450000, currency: 'INR', lead: { id: 8, number: 'LD-1008', visible: true },
    quotation: null, stakeholders: [], manager: { id: 3, name: 'Carlos Ruiz' } }),
  project({}),
];

const OPTIONS: ProjectFormOptions = {
  company: { id: 4, name: 'Meridian', legalName: null, country: 'India', isClient: true, defaultCurrency: 'INR' },
  leads: [
    { id: 8, number: 'LD-1008', status: 'New', leadSource: 'Referral', contactId: null, contactName: null },
    { id: 5, number: 'LD-1005', status: 'Won', leadSource: 'Referral', contactId: 9, contactName: 'Tom Hale' },
  ],
  quotations: [],
  contacts: [{ id: 9, name: 'Tom Hale', designation: 'COO', contactType: 'Other', email: 'tom@meridian.in', isPrimary: false }],
  users: [{ id: 2, name: 'Arjun Mehta' }],
};

const COMPANY = {
  id: 4, number: 'CO-0245', name: 'Meridian', legalName: null, status: 'Active', verificationStatus: 'Unverified', isClient: true,
  contactCount: 1, industry: null, city: null, country: 'India', employeeRange: null, domain: null, website: null,
  businessVerticals: [], targetMarkets: [], geographicMarkets: [],
} as unknown as CompanyDetail;

type Call = { method: string; url: string };

let signedIn: Me = seller;

function stub({ items = ROWS, isClient = true, status = 'Active', company = {} }: { items?: ProjectRow[]; isClient?: boolean; status?: string; company?: object } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url });
    if (url === '/api/me') return Response.json(signedIn);
    if (url === '/api/companies/4/projects') return Response.json({ items, isClient });
    if (url === '/api/companies/4') return Response.json({ ...COMPANY, isClient, status, ...company });
    if (url.startsWith('/api/projects/form-options')) return Response.json({ ...OPTIONS, company: { ...OPTIONS.company, isClient } });
    if (url.startsWith('/api/companies?')) return Response.json({ items: [], total: 0, page: 1, pageSize: 100 });
    if (url.startsWith('/api/leads') || url.startsWith('/api/contacts') || url.startsWith('/api/quotations')) {
      return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
    }
    if (url.endsWith('/locations')) return Response.json({ items: [] });
    if (url === '/api/companies/4/sources') return Response.json({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    if (url.endsWith('/pipeline')) return Response.json({ byStatus: [], open: 0, won: 0, lost: 0 });
    if (url.includes('/activities')) return Response.json({ items: [], total: 0, page: 1, pageSize: 20, summary: null });
    return Response.json({});
  }));
  return calls;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search + loc.hash}</div>;
}

function mount(ui: React.ReactNode, { me = seller, at = '/', path = '/' }: { me?: Me; at?: string; path?: string } = {}) {
  signedIn = me;
  render(
    <QueryClientProvider client={makeClient(me)}>
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
}

const card = () => screen.getByRole('region', { name: /^Projects/ });

describe('Projects card (prototype V.projectsCard)', () => {
  it('not a client: the unlock hint, no Create project', async () => {
    stub({ items: [], isClient: false });
    mount(<ProjectsCard companyId={4} leadId={5} />);
    expect(await screen.findByText(/Projects unlock when a lead at this company is marked/)).toBeTruthy();
    expect(card()).toHaveTextContent('Projects unlock when a lead at this company is marked Won or a quotation is accepted.');
    expect(within(card()).getByRole('heading')).toHaveTextContent('Projects 0');
    expect(within(card()).queryByRole('button', { name: '+ Create project' })).toBeNull();
  });

  it('a client without projects: Create project and the empty text', async () => {
    stub({ items: [] });
    mount(<ProjectsCard companyId={4} />);
    expect(await screen.findByText('No projects yet. Create the first one for this engagement.')).toBeTruthy();
    expect(within(card()).getByRole('button', { name: '+ Create project' })).toBeTruthy();
    expect(card()).not.toHaveTextContent('Projects unlock');
  });

  it('rows link to the client’s projects; this lead’s projects are highlighted; values without ".00"', async () => {
    stub();
    mount(<ProjectsCard companyId={4} leadId={5} />);
    const mine = (await screen.findByRole('link', { name: /Warehouse automation/ }));
    expect(within(card()).getByRole('heading')).toHaveTextContent('Projects 2');
    expect(mine).toHaveAttribute('href', '/projects?company=4');
    expect(mine).toHaveTextContent('PRJ-1 · from LD-1005 · USD 12,000 · Arjun Mehta');
    expect(mine).toHaveClass('link', 'pj-mine');
    expect(within(mine).getByText('Active')).toHaveClass('badge', 'b-ok');
    const other = screen.getByRole('link', { name: /Advisory/ });
    expect(other).toHaveTextContent('PRJ-2 · from LD-1008 · INR 4,50,000 · Carlos Ruiz');
    expect(other).not.toHaveClass('pj-mine');
    expect(within(other).getByText('On hold')).toHaveClass('badge', 'b-warn');
  });

  it('Create project opens the dialog preset with the client and this lead', async () => {
    const calls = stub();
    const u = userEvent.setup();
    mount(<ProjectsCard companyId={4} leadId={5} />);
    await u.click(await screen.findByRole('button', { name: '+ Create project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create project' });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'From lead' })).toHaveValue('5'));
    expect(calls.some((c) => c.url === '/api/projects/form-options?company=4')).toBe(true);
  });

  it('no Create project without quotation rights', async () => {
    stub();
    mount(<ProjectsCard companyId={4} />, { me: { ...rep } });
    await screen.findByRole('link', { name: /Warehouse automation/ });
    expect(screen.queryByRole('button', { name: '+ Create project' })).toBeNull();
  });
});

describe('Company profile: Projects', () => {
  it('the Projects tab sits between Leads & Prospects and Activities, with its count', async () => {
    stub();
    mount(<CompanyProfile />, { at: '/companies/4', path: '/companies/:id' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Projects/ })).toHaveTextContent('Projects 2'));
    const names = screen.getAllByRole('tab').map((x) => x.textContent ?? '');
    const at = names.findIndex((n) => n.startsWith('Projects'));
    expect(names[at - 1]).toMatch(/^Leads & Prospects/);
    expect(names[at + 1]).toMatch(/^Activities/);
  });

  it('the Research Sources tab carries its count, as the prototype ("Research Sources 5")', async () => {
    stub();
    mount(<CompanyProfile />, { at: '/companies/4', path: '/companies/:id' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Research Sources/ })).toHaveTextContent('Research Sources 3'));
    expect(screen.getByRole('tab', { name: /^AI Intelligence/ })).toHaveTextContent(/^AI Intelligence$/);
  });

  it('Overview legend as the prototype: "Empty fields stay NULL", last research with its time and status', async () => {
    stub({ company: { aiResearchStatus: 'Completed', aiLastResearchAt: '2026-11-18T09:51:00.000Z' } });
    mount(<CompanyProfile />, { at: '/companies/4', path: '/companies/:id' });
    const legend = await waitFor(() => {
      const el = document.querySelector('.legend');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(legend).toHaveTextContent('Empty fields stay NULL. Nothing is invented.');
    expect(legend).toHaveTextContent(/Last research: 18\/11\/2026,? \d\d:51 · Completed/);
  });

  it('tab: table in prototype columns, Create project for a client, and How projects work', async () => {
    stub();
    mount(<CompanyProfile />, { at: '/companies/4#projects', path: '/companies/:id' });
    expect(await screen.findByRole('heading', { name: 'Projects at Meridian' })).toBeTruthy();
    expect(screen.getByText('One client, many projects; each starts from its own lead.')).toBeTruthy();
    await screen.findByText('PRJ-1 · Q-2026-003');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Project', 'From lead', 'Status', 'Start', 'Value', 'Project manager', 'Primary stakeholders', '',
    ]);
    const row = screen.getByText('PRJ-1 · Q-2026-003').closest('tr')!;
    expect(row).toHaveTextContent('Meridian · Warehouse automation');
    expect(within(row).getByRole('link', { name: 'LD-1005' })).toHaveAttribute('href', '/leads/5');
    expect(within(row).getByText('Active')).toHaveClass('badge', 'b-ok');
    expect(row).toHaveTextContent('20/11/2026');
    expect(row).toHaveTextContent('USD 12,000.00');
    expect(row).toHaveTextContent('Arjun Mehta');
    expect(row).toHaveTextContent('Tom Hale, Priya Nair');
    expect(within(row).getByRole('link', { name: 'Email' })).toHaveAttribute('href', '/email?compose=1&company=4&lead=5&project=1');
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByText('PRJ-2').closest('tr')).toHaveTextContent('—');
    expect(screen.getByRole('button', { name: '+ Create project' })).toBeTruthy();
    const how = screen.getByRole('region', { name: 'How projects work' });
    expect(within(how).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'A company becomes a Client when a lead is Won or a quotation is accepted.',
      'Each project records the lead it came from, its stakeholders, manager, value and linked quotation.',
      'Emails composed with a project selected copy its primary stakeholders and stay attached to the project.',
    ]);
  });

  it('tab empty text for a client', async () => {
    stub({ items: [] });
    mount(<CompanyProfile />, { at: '/companies/4#projects', path: '/companies/:id' });
    expect(await screen.findByText('No projects yet. Create the first one.')).toBeTruthy();
  });

  it('tab empty text for a company that is not a client; no Create project', async () => {
    stub({ items: [], isClient: false });
    mount(<CompanyProfile />, { at: '/companies/4#projects', path: '/companies/:id' });
    expect(await screen.findByText('Projects unlock when a lead here is marked Won or a quotation is accepted.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create project/ })).toBeNull();
  });

  it('header Create project (client) opens the dialog for this client', async () => {
    const calls = stub();
    const u = userEvent.setup();
    mount(<CompanyProfile />, { at: '/companies/4#ai', path: '/companies/:id' });
    await u.click(await screen.findByRole('button', { name: 'Create project' }));
    expect(await screen.findByRole('dialog', { name: 'Create project' })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/projects/form-options?company=4')).toBe(true));
  });

  it('header Run AI research (release 4): live for an active company, disabled on a closed one like its neighbours', async () => {
    stub({ status: 'Closed' });
    mount(<CompanyProfile />, { at: '/companies/4', path: '/companies/:id' });
    const run = await screen.findByRole('button', { name: 'Run AI research' });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute('title', 'This company is closed');
    cleanup();
    stub();
    mount(<CompanyProfile />, { at: '/companies/4', path: '/companies/:id' });
    expect(await screen.findByRole('button', { name: 'Run AI research' })).toBeEnabled();
  });

  it('Overview side column: the real Projects card', async () => {
    stub();
    mount(<CompanyProfile />, { at: '/companies/4', path: '/companies/:id' });
    const link = await screen.findByRole('link', { name: /Warehouse automation/ });
    expect(link).toHaveAttribute('href', '/projects?company=4');
    expect(link).not.toHaveClass('pj-mine');
  });

  it('Leads tab: the Pipeline card lists the project numbers (prototype)', async () => {
    stub();
    mount(<CompanyProfile />, { at: '/companies/4#leads', path: '/companies/:id' });
    const pipeline = await screen.findByRole('region', { name: 'Pipeline at this company' });
    await waitFor(() => expect(within(pipeline).getByText('Projects').nextElementSibling?.textContent).toBe('PRJ-2, PRJ-1'));
  });

  it('Leads tab: no projects shows a dash', async () => {
    stub({ items: [] });
    mount(<CompanyProfile />, { at: '/companies/4#leads', path: '/companies/:id' });
    const pipeline = await screen.findByRole('region', { name: 'Pipeline at this company' });
    await waitFor(() => expect(within(pipeline).getByText('Projects').nextElementSibling?.textContent).toBe('—'));
  });
});
