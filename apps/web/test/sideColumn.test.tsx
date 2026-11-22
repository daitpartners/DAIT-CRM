import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Me } from '../src/api/queries';
import { CloseLeadModal } from '../src/pages/leads/CloseLeadModal';
import { SideColumn } from '../src/pages/leads/SideColumn';
import { Wrap, makeClient, makeLead, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const seller: Me = { ...rep, rights: [...rep.rights, 'manage_quotes'] };

const PROJECT = {
  id: 1, number: 'PRJ-1', name: 'Meridian · Warehouse automation', status: 'Active', startDate: '2026-11-20', value: 12000, currency: 'USD',
  company: { id: 4, name: 'Meridian Textiles' }, lead: { id: 5, number: 'LD-1005', visible: true }, quotation: null,
  manager: { id: 2, name: 'Arjun Mehta' }, stakeholders: [], description: null, completedAt: null,
  createdAt: '2026-11-20T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z', canEdit: true,
};

const OPTIONS = {
  company: { id: 4, name: 'Meridian Textiles', country: 'India', isClient: true, defaultCurrency: 'INR' },
  leads: [{ id: 5, number: 'LD-1005', status: 'Won', leadSource: 'Referral', contactId: 9, contactName: 'Tom Hale' }],
  quotations: [], contacts: [], users: [{ id: 2, name: 'Arjun Mehta' }],
};

/** `statusCode`: what POST /status answers. */
function stub({ isClient = true, statusCode = 200, me = seller }: { isClient?: boolean; statusCode?: number; me?: Me } = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/me') return Response.json(me);
    if (url === '/api/companies/4/projects') return Response.json({ items: isClient ? [PROJECT] : [], isClient });
    if (url.startsWith('/api/projects/form-options')) return Response.json(OPTIONS);
    if (url === '/api/leads/5/status') {
      return statusCode === 200
        ? Response.json(makeLead({ status: 'Won' }))
        : Response.json({ error: 'stale', message: 'Someone else changed this record.' }, { status: statusCode });
    }
    return Response.json({});
  }));
  return calls;
}

describe('SideColumn', () => {
  it('a lead without a company asks for the company before adding a contact', async () => {
    const u = userEvent.setup();
    render(
      <Wrap qc={makeClient()}>
        <SideColumn lead={makeLead({ contact: null, contactId: null, company: null, companyId: null })} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(screen.queryByRole('dialog', { name: 'Add contact' })).toBeNull();
    expect(await screen.findByText('Choose the company for this lead first, above.')).toBeInTheDocument();
  });

  it('shows Coming up only when something is scheduled', () => {
    const qc = makeClient();
    const { rerender } = render(
      <Wrap qc={qc}>
        <SideColumn lead={makeLead({ nextFollowUp: null, tasks: [] })} live />
      </Wrap>,
    );
    expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull();
    rerender(
      <Wrap qc={qc}>
        <SideColumn lead={makeLead({ nextFollowUp: '2030-01-02', tasks: [] })} live />
      </Wrap>,
    );
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument();
  });

  it('shows a call in Coming up as the prototype event: date and time, linking to its week', () => {
    const call = {
      id: 7, leadId: 1, lead: null, title: 'Call back about the proposal', dueDate: '2030-01-03', kind: 'call' as const, dueTime: '10:30',
      durationMinutes: 30, assignedTo: { id: 2, name: 'Arjun Mehta' }, isDone: false, doneAt: null, origin: 'manual' as const, closedReason: null,
      isOverdue: false, isToday: false, updatedAt: '2030-01-01T10:00:00.000Z',
    };
    render(
      <Wrap qc={makeClient()}>
        <SideColumn lead={makeLead({ nextFollowUp: null, tasks: [call] })} live />
      </Wrap>,
    );
    const link = screen.getByRole('link', { name: /Call back about the proposal/ });
    expect(link).toHaveAttribute('href', '/calendar?view=week&d=2030-01-03');
    expect(link.textContent).toMatch(/10:30$/);
  });

  it('the Projects card replaces the placeholder: this lead’s project highlighted', async () => {
    const calls = stub();
    render(
      <Wrap qc={makeClient(seller)}>
        <SideColumn lead={makeLead()} live />
      </Wrap>,
    );
    const link = await screen.findByRole('link', { name: /Warehouse automation/ });
    expect(link).toHaveClass('pj-mine');
    expect(link).toHaveAttribute('href', '/projects?company=4');
    expect(screen.getByRole('button', { name: '+ Create project' })).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/companies/4/projects')).toBe(true);
  });

  it('no Projects card for a lead without a company', () => {
    stub();
    render(
      <Wrap qc={makeClient(seller)}>
        <SideColumn lead={makeLead({ company: null, companyId: null })} live />
      </Wrap>,
    );
    expect(screen.queryByRole('region', { name: /^Projects/ })).toBeNull();
  });
});

describe('Won dialog: Mark Won and create project (prototype)', () => {
  it('says the project is a separate step and offers the three buttons', () => {
    stub();
    render(
      <Wrap qc={makeClient(seller)}>
        <CloseLeadModal lead={makeLead()} initialStatus="Won" onClose={() => {}} />
      </Wrap>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Close lead' });
    expect(dialog).toHaveTextContent('A client can have several projects, so the project is created as a separate step.');
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent).slice(-3)).toEqual(['Cancel', 'Mark Won', 'Mark Won and create project']);
  });

  it('marks the lead Won, then opens Create project preset with this client and lead', async () => {
    const calls = stub();
    const onClose = vi.fn();
    const u = userEvent.setup();
    render(
      <Wrap qc={makeClient(seller)}>
        <CloseLeadModal lead={makeLead()} initialStatus="Won" onClose={onClose} />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: 'Mark Won and create project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create project' });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/leads/5/status', body: { status: 'Won' } });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'From lead' })).toHaveValue('5'));
    expect(calls.some((c) => c.url === '/api/projects/form-options?company=4')).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Close lead' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('when marking Won fails the project dialog does not open', async () => {
    stub({ statusCode: 409 });
    const u = userEvent.setup();
    render(
      <Wrap qc={makeClient(seller)}>
        <CloseLeadModal lead={makeLead()} initialStatus="Won" onClose={() => {}} />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: 'Mark Won and create project' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Close lead' })).toHaveTextContent('Someone else changed this record'));
    expect(screen.queryByRole('dialog', { name: 'Create project' })).toBeNull();
  });

  it('no third button without quotation rights', () => {
    stub({ me: rep });
    render(
      <Wrap qc={makeClient(rep)}>
        <CloseLeadModal lead={makeLead()} initialStatus="Won" onClose={() => {}} />
      </Wrap>,
    );
    expect(screen.queryByRole('button', { name: 'Mark Won and create project' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark Won' })).toBeTruthy();
  });
});
