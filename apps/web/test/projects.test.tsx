import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Me } from '../src/api/queries';
import type { ProjectFormOptions, ProjectList, ProjectRow } from '../src/api/projects';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { Sidebar } from '../src/components/Sidebar';
import { ToastProvider } from '../src/components/Toast';
import { ProjectsPage } from '../src/pages/projects/ProjectsPage';
import { ProjectModal } from '../src/pages/projects/ProjectModal';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const seller: Me = { ...rep, rights: [...rep.rights, 'manage_quotes', 'use_email'] };
const researcher: Me = { ...rep, id: 7, name: 'Dev Rao', role: 'Data Research User', rights: ['manage_companies'] };

function project(o: Partial<ProjectRow>): ProjectRow {
  return {
    id: 1, number: 'PRJ-1', name: 'Meridian · Warehouse automation', status: 'Active', startDate: '2026-11-20', value: 12000, currency: 'USD',
    company: { id: 4, name: 'Meridian' }, lead: { id: 5, number: 'LD-1005', visible: true }, quotation: { id: 3, number: 'Q-2026-003' },
    manager: { id: 2, name: 'Arjun Mehta' }, stakeholders: [{ id: 9, name: 'Tom Hale', email: 'tom@meridian.in' }, { id: 10, name: 'Priya Nair', email: null }],
    description: 'Scope', completedAt: null, createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z', canEdit: true, ...o,
  };
}

const ROWS: ProjectRow[] = [
  project({ id: 2, number: 'PRJ-2', name: 'Orbit · Advisory', status: 'On hold', value: 450000, currency: 'INR', company: { id: 6, name: 'Orbit Labs' },
    lead: { id: 8, number: 'LD-1008', visible: false }, quotation: null, stakeholders: [], canEdit: false }),
  project({}),
];

const LIST: ProjectList = {
  items: ROWS,
  total: 2,
  tiles: { active: 1, clients: 3, totals: [{ currency: 'USD', amount: 12000 }, { currency: 'INR', amount: 450000 }], completedThisYear: 4, onHold: 1 },
};

const OPTIONS: ProjectFormOptions = {
  company: { id: 4, name: 'Meridian', country: 'India', isClient: true, defaultCurrency: 'INR' },
  leads: [
    { id: 8, number: 'LD-1008', status: 'New', leadSource: 'Referral', contactId: null, contactName: null },
    { id: 5, number: 'LD-1005', status: 'Won', leadSource: 'Referral', contactId: 9, contactName: 'Tom Hale' },
  ],
  quotations: [{ id: 3, number: 'Q-2026-003', status: 'Accepted', subject: 'Advisory', currency: 'INR' }],
  contacts: [
    { id: 12, name: 'Amit Shah', designation: null, contactType: 'Other', email: null, isPrimary: false },
    { id: 10, name: 'Priya Nair', designation: 'CFO', contactType: 'Influencer', email: 'priya@meridian.in', isPrimary: true },
    { id: 11, name: 'Raj Kumar', designation: null, contactType: 'Decision Maker', email: 'raj@meridian.in', isPrimary: false },
    { id: 9, name: 'Tom Hale', designation: 'COO', contactType: 'Other', email: 'tom@meridian.in', isPrimary: false },
  ],
  users: [{ id: 2, name: 'Arjun Mehta' }, { id: 3, name: 'Carlos Ruiz' }],
};

const CLIENTS = {
  items: [{ id: 4, number: 'CO-0245', name: 'Meridian', status: 'Active', isClient: true }, { id: 6, number: 'CO-0300', name: 'Orbit Labs', status: 'Active', isClient: true }],
  total: 2, page: 1, pageSize: 100,
};

let signedIn: Me = seller;
type Call = { method: string; url: string; body?: Record<string, unknown> };

/** `patchStatus`: what PATCH answers (409 → stale). */
function stub({ list = LIST, patchStatus = 200 }: { list?: ProjectList; patchStatus?: number } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (url === '/api/me') return Response.json(signedIn);
    if (url.startsWith('/api/projects/form-options')) return Response.json(OPTIONS);
    if (url === '/api/projects' && method === 'POST') return Response.json(project({ id: 7, number: 'PRJ-7' }), { status: 201 });
    if (url.startsWith('/api/projects/') && method === 'PATCH') {
      return patchStatus === 409 ? Response.json({ error: 'stale' }, { status: 409 }) : Response.json(project({ status: 'On hold' }));
    }
    if (url.startsWith('/api/projects')) return Response.json(list);
    if (url.startsWith('/api/companies?')) return Response.json(CLIENTS);
    if (url === '/api/nav-counts') return Response.json({ leads: 3, overdueTasks: 0, unread: 0, mailUnread: 0, mailerLive: 0, projects: 5 });
    return Response.json({});
  }));
  return calls;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function mount(ui: React.ReactNode, { me = seller, at = '/projects', path = '/projects' }: { me?: Me; at?: string; path?: string } = {}) {
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

const tile = (label: string) => within(document.querySelector('.tiles') as HTMLElement).getByText(label).closest('.tile') as HTMLElement;

describe('Projects list (prototype V.projects)', () => {
  it('top bar, tiles from the API with sums per currency and ".00" dropped', async () => {
    stub();
    mount(<ProjectsPage />);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByText('Engagements won from leads. One client can have many projects, each from its own lead.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Email a project' })).toHaveAttribute('href', '/email?compose=1');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeTruthy();
    await waitFor(() => expect(tile('Active projects').querySelector('.v')).toHaveTextContent('1'));
    expect(tile('Active projects').querySelector('.m')).toHaveTextContent('3 clients');
    expect(tile('Total value').querySelector('.v')).toHaveTextContent('USD 12,000 · INR 4,50,000');
    expect(tile('Total value').querySelector('.m')).toHaveTextContent('across all projects');
    expect(tile('Completed').querySelector('.v')).toHaveTextContent('4');
    expect(tile('Completed').querySelector('.m')).toHaveTextContent('this year');
    expect(tile('On hold').querySelector('.v')).toHaveTextContent('1');
  });

  it('columns and rows as the prototype; a lead the user cannot open is plain text', async () => {
    stub();
    mount(<ProjectsPage />);
    await screen.findByText('PRJ-1');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Project', 'Client', 'From lead', 'Status', 'Start', 'Value', 'Project manager', 'Primary stakeholders', 'Quotation', '',
    ]);
    const rows = screen.getAllByRole('row').slice(1);
    const [orbit, meridian] = [rows[0]!, rows[1]!];
    expect(meridian).toHaveTextContent('Meridian · Warehouse automation');
    expect(within(meridian).getByRole('link', { name: 'Meridian' })).toHaveAttribute('href', '/companies/4#projects');
    expect(within(meridian).getByRole('link', { name: 'LD-1005' })).toHaveAttribute('href', '/leads/5');
    expect(within(meridian).getByText('Active')).toHaveClass('badge', 'b-ok');
    expect(meridian).toHaveTextContent('20/11/2026');
    expect(meridian).toHaveTextContent('USD 12,000');
    expect(meridian).not.toHaveTextContent('12,000.00');
    expect(meridian).toHaveTextContent('Arjun Mehta');
    expect(meridian).toHaveTextContent('Tom Hale, Priya Nair');
    expect(within(meridian).getByRole('link', { name: 'Q-2026-003' })).toHaveAttribute('href', '/quotations/3');
    expect(within(meridian).getByRole('link', { name: 'Email' })).toHaveAttribute('href', '/email?compose=1&company=4&lead=5&project=1');
    expect(within(meridian).getByRole('button', { name: 'Edit' })).toBeTruthy();

    expect(within(orbit).getByText('On hold')).toHaveClass('badge', 'b-warn');
    expect(within(orbit).getByText('LD-1008').closest('a')).toBeNull();
    expect(within(orbit).getByRole('link', { name: 'Email' })).toHaveAttribute('href', '/email?compose=1&company=6&project=2');
    // Not allowed to edit: no Edit button. No quotation, no stakeholders: dashes.
    expect(within(orbit).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(orbit).getAllByText('—')).toHaveLength(2);
  });

  it('the empty text as the prototype', async () => {
    stub({ list: { ...LIST, items: [], total: 0 } });
    mount(<ProjectsPage />);
    expect(await screen.findByText('No projects yet. Mark a lead as Won or accept a quotation, then create the project.')).toBeTruthy();
    expect(screen.getByText('0 projects')).toBeTruthy();
  });

  it('filters go to the URL and the request; Clear and the count', async () => {
    const calls = stub();
    const u = userEvent.setup();
    mount(<ProjectsPage />);
    expect(await screen.findByText('2 projects')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '✕ Clear' })).toBeNull();
    await u.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'On hold');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/projects?status=On+hold'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/projects?status=On+hold')).toBe(true));
    await u.click(screen.getByRole('combobox', { name: 'Client' }));
    await u.click(await screen.findByRole('option', { name: 'Meridian' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/projects?status=On+hold&company=4'));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/projects?company=4&status=On+hold')).toBe(true));
    expect(calls.some((c) => c.url.startsWith('/api/companies?') && c.url.includes('isClient=true'))).toBe(true);
    expect(screen.getByRole('link', { name: 'Email a project' })).toHaveAttribute('href', '/email?compose=1&company=4');
    await u.click(screen.getByRole('link', { name: '✕ Clear' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/projects'));
  });

  it('no Create project and no Email for a user without the rights', async () => {
    stub();
    mount(<ProjectsPage />, { me: researcher });
    await screen.findByText('PRJ-1');
    expect(screen.queryByRole('button', { name: 'Create project' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Email a project' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Email' })).toBeNull();
  });
});

describe('Create / Edit project dialog (prototype V.projectModal)', () => {
  it('validation toasts: a client first, then a name', async () => {
    const calls = stub();
    const u = userEvent.setup();
    mount(<ProjectsPage />);
    await u.click(await screen.findByRole('button', { name: 'Create project' }));
    const dialog = screen.getByRole('dialog', { name: 'Create project' });
    expect(within(dialog).getByText('No contacts at this client yet. Add contacts on the company profile.')).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Choose a client first')).toBeTruthy();
    await u.click(within(dialog).getByRole('combobox', { name: /Client/ }));
    await u.click(await within(dialog).findByRole('option', { name: 'Meridian · client' }));
    const name = within(dialog).getByRole('textbox', { name: /Project name/ });
    await waitFor(() => expect(name).toHaveValue('Meridian · '));
    expect(name).toHaveAttribute('placeholder', 'e.g. Warehouse automation advisory');
    await u.clear(name);
    await u.type(name, '   ');
    await u.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('Project name is required')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('create preset with a lead: lead contact, primary and Decision Maker pre-ticked; posts and toasts', async () => {
    const calls = stub();
    const onClose = vi.fn();
    const u = userEvent.setup();
    mount(<ProjectModal preset={{ companyId: 4, leadId: 5 }} onClose={onClose} />, { at: '/leads/5', path: '/leads/:id' });
    const dialog = await screen.findByRole('dialog', { name: 'Create project' });
    const box = (name: RegExp) => within(dialog).getByRole('checkbox', { name });
    await waitFor(() => expect(box(/Tom Hale/)).toBeChecked());
    expect(box(/Priya Nair/)).toBeChecked();
    expect(box(/Raj Kumar/)).toBeChecked();
    expect(box(/Amit Shah/)).not.toBeChecked();
    expect(within(dialog).getByText(/Amit Shah/).closest("label")).toHaveTextContent('Amit Shah · Other · no email');
    expect(within(dialog).getByText(/Priya Nair/).closest("label")).toHaveTextContent('Priya Nair · CFO · priya@meridian.in');
    expect(within(dialog).getByText('(copied on every project email)')).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'From lead' })).toHaveValue('5');
    expect(within(within(dialog).getByRole('combobox', { name: 'From lead' })).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '— none —', 'LD-1008 · Referral · New', 'LD-1005 · Tom Hale · Won',
    ]);
    expect(within(dialog).getByRole('combobox', { name: 'Currency' })).toHaveValue('INR');
    expect(within(dialog).getByRole('combobox', { name: 'Status' })).toHaveValue('Active');
    expect(within(dialog).getByRole('combobox', { name: 'Project manager' })).toHaveValue('2');
    expect(within(dialog).getByRole('textbox', { name: /Project name/ })).toHaveValue('Meridian · ');
    await u.type(within(dialog).getByRole('textbox', { name: /Project name/ }), 'Advisory');
    await u.type(within(dialog).getByRole('spinbutton', { name: 'Value' }), '5000');
    await u.selectOptions(within(dialog).getByRole('combobox', { name: 'Linked quotation' }), '3');
    await u.click(box(/Raj Kumar/));
    await u.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText('PRJ-7 created · 2 stakeholders')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/projects',
      body: { companyId: 4, leadId: 5, quotationId: 3, name: 'Meridian · Advisory', status: 'Active', value: 5000, currency: 'INR', managerId: 2, stakeholderIds: [10, 9] },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('edit: Client locked, values loaded, PATCH carries updatedAt; a stale save shows the stale toast', async () => {
    const calls = stub({ patchStatus: 409 });
    const u = userEvent.setup();
    mount(<ProjectModal existing={project({})} onClose={() => {}} />, { at: '/projects' });
    const dialog = await screen.findByRole('dialog', { name: 'Edit project' });
    expect(within(dialog).getByRole('combobox', { name: /Client/ })).toBeDisabled();
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Tom Hale/ })).toBeChecked());
    expect(within(dialog).getByRole('checkbox', { name: /Raj Kumar/ })).not.toBeChecked();
    expect(within(dialog).getByRole('textbox', { name: /Project name/ })).toHaveValue('Meridian · Warehouse automation');
    expect(within(dialog).getByRole('combobox', { name: 'Linked quotation' })).toHaveValue('3');
    expect(within(dialog).getByRole('combobox', { name: 'Currency' })).toHaveValue('USD');
    await u.selectOptions(within(dialog).getByRole('combobox', { name: 'Status' }), 'On hold');
    await u.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Someone else changed this record. Reload and try again.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      url: '/api/projects/1',
      body: { status: 'On hold', leadId: 5, quotationId: 3, value: 12000, currency: 'USD', updatedAt: '2026-11-20T10:00:00.000Z', stakeholderIds: [10, 9] },
    });
    expect(calls.some((c) => c.url === '/api/projects/form-options?company=4&project=1')).toBe(true);
  });

  it('edit saves: "Project updated"', async () => {
    stub();
    const onClose = vi.fn();
    const u = userEvent.setup();
    mount(<ProjectModal existing={project({})} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Edit project' });
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /Tom Hale/ })).toBeChecked());
    await u.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Project updated')).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Sidebar', () => {
  it('Projects after Quotations with the nav count', async () => {
    stub();
    mount(<Sidebar me={seller} open={false} onNavigate={() => {}} />, { at: '/', path: '/' });
    const link = await screen.findByRole('link', { name: /Projects/ });
    expect(link).toHaveAttribute('href', '/projects');
    await waitFor(() => expect(link).toHaveTextContent('Projects5'));
    const names = screen.getAllByRole('link').map((a) => a.textContent ?? '');
    expect(names.findIndex((n) => n.startsWith('Projects'))).toBe(names.findIndex((n) => n.startsWith('Quotations')) + 1);
  });
});
