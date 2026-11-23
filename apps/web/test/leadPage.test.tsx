import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { LeadFull } from '../src/api/leads';
import { keys, type LookupValue, type Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { LeadModal } from '../src/pages/leads/LeadModal';
import { LeadPage } from '../src/pages/leads/LeadPage';
import { EmailForm } from '../src/pages/leads/EmailForm';
import { Wrap, makeLead } from './leadFixture';

const rep: Me = {
  id: 2, email: 'arjun@daitpartners.com', name: 'Arjun Mehta', role: 'Sales Representative', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'claim_leads', 'manage_companies'],
};

const lookup = (group: LookupValue['group'], value: string, id: number): LookupValue => ({
  id, group, value, label: value, labelEs: null, labelFr: null, sortOrder: id, isActive: true,
});

const baseLead: LeadFull = {
  id: 5, number: 'LD-1005', leadType: 'Lead', companyName: 'Meridian Textiles', companyId: 4, country: 'India', outreachLanguage: 'en' as const, city: null,
  leadSource: 'Referral', status: 'New', priority: 'Medium', assignedTo: null, assignedToId: null, nextFollowUp: null,
  isOverdue: false, archivedAt: null, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z',
  website: null, businessEmail: null, phone: null, sourceUrl: null, importBatch: null, notes: 'Mine', contactId: null,
  company: {
    id: 4, number: 'CO-0245', name: 'Meridian Textiles', industry: null, city: null, country: 'India', employeeRange: null,
    isClient: false, verificationStatus: null, contactCount: 0, openLeadCount: 1, legalName: null, website: null, domain: null,
    businessCategory: null, timezone: null,
  },
  contact: null, createdBy: null, activities: [], activityTotal: 0, callCount: 0, lastContact: null, assignments: [], tasks: [],
};

function setup(me: Me = rep) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  qc.setQueryData(keys.users, []);
  qc.setQueryData(keys.lookups, {
    country: [lookup('country', 'India', 1)],
    lead_source: [lookup('lead_source', 'Referral', 2)],
    lead_status: [lookup('lead_status', 'New', 3), lookup('lead_status', 'Contacted', 4)],
  });
  return qc;
}

afterEach(() => vi.unstubAllGlobals());

describe('lead page conflicts', () => {
  it('edit: a stale save reloads the form with the latest values and keeps the stamp it loaded', async () => {
    const u = userEvent.setup();
    const theirs = { ...baseLead, notes: 'Their change', updatedAt: '2026-11-21T09:00:00.000Z' };
    const patches: { notes?: string; updatedAt?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/leads/5' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        return body.updatedAt === theirs.updatedAt
          ? Response.json({ ...theirs, notes: body.notes })
          : Response.json({ error: 'stale' }, { status: 409 });
      }
      if (url === '/api/leads/5') return Response.json(theirs);
      throw new Error(`unexpected fetch ${url}`);
    }));
    const qc = setup();
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter>
            <LeadModal lead={baseLead} onClose={onClose} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    const notes = screen.getByLabelText('Notes');
    await u.clear(notes);
    await u.type(notes, 'My change');
    await u.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('This lead was changed by someone else. The form now shows the latest values; check them and save again.'),
    ).toBeInTheDocument();
    // The form shows the refetched lead, not the user's stale snapshot.
    await waitFor(() => expect(screen.getByLabelText('Notes')).toHaveValue('Their change'));
    expect(patches[0]).toMatchObject({ notes: 'My change', updatedAt: baseLead.updatedAt });
    expect(onClose).not.toHaveBeenCalled();

    // Saving again now carries the refreshed stamp.
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(patches[1]).toMatchObject({ notes: 'Their change', updatedAt: theirs.updatedAt });
  });

  it('claim: already_assigned refetches the lead and the Claim button goes away', async () => {
    const u = userEvent.setup();
    let claimed = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/leads/5/claim') {
        claimed = true;
        return Response.json({ error: 'already_assigned' }, { status: 409 });
      }
      if (url === '/api/leads/5') {
        return Response.json(
          claimed ? { ...baseLead, assignedTo: { id: 2, name: 'Arjun Mehta' }, assignedToId: 2, updatedAt: '2026-11-21T09:00:00.000Z' } : baseLead,
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
    }));
    const qc = setup();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/leads/5']}>
            <Routes>
              <Route path="/leads/:id" element={<LeadPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await u.click(within(await screen.findByRole('group', { name: 'Owner' })).getByRole('button', { name: 'Claim' }));
    expect(await screen.findByText('Someone has already taken this lead')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Owner' })).queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Owner' })).toHaveTextContent('Arjun Mehta');
  });

  it('composer: a draft survives switching tabs and folding the box', async () => {
    const u = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/leads/5') return Response.json(baseLead);
      throw new Error(`unexpected fetch ${url}`);
    }));
    const qc = setup();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/leads/5']}>
            <Routes>
              <Route path="/leads/:id" element={<LeadPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await u.click(await screen.findByRole('tab', { name: 'Meeting' }));
    await u.clear(screen.getByRole('textbox', { name: /Title/ }));
    await u.type(screen.getByRole('textbox', { name: /Title/ }), 'Kick-off with ops');
    await u.click(screen.getByRole('tab', { name: 'Call note' }));
    expect(screen.queryByRole('textbox', { name: /Title/ })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Hide' }));
    await u.click(screen.getByRole('tab', { name: 'Meeting' }));
    expect(screen.getByRole('textbox', { name: /Title/ })).toHaveValue('Kick-off with ops');
  });
});

describe('lead email form: Project picker (release 3B)', () => {
  const stakeholder = (id: number, name: string, email: string | null) => ({ id, name, email });
  const prj = (id: number, name: string, leadId: number | null, stakeholders: { id: number; name: string; email: string | null }[]) => ({
    id, number: `PRJ-${id}`, name, status: 'Active', startDate: '2026-11-01', value: null, currency: 'USD', company: { id: 4, name: 'Meridian Textiles' },
    lead: leadId ? { id: leadId, number: `LD-${1000 + leadId}`, visible: true } : null, quotation: null, manager: { id: 2, name: 'Arjun Mehta' },
    stakeholders, description: null, completedAt: null, createdAt: '', updatedAt: '', canEdit: true,
  });
  const client = { ...baseLead, contact: { ...makeLead().contact!, email: 'tom@meridian.in' }, company: { ...baseLead.company!, isClient: true } };

  function renderForm(lead: LeadFull, projects: { items: unknown[]; isClient: boolean }) {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ id: 1, fromAddress: 'arjun@daitpartners.com' }, { status: 201 });
      }
      if (url === '/api/companies/4/projects') return Response.json(projects);
      if (url === '/api/mailboxes') return Response.json({ mine: { id: 7, address: 'arjun@daitpartners.com', status: 'connected' } });
      return Response.json({ items: [], total: 0, page: 1, pageSize: 100 });
    }));
    render(
      <Wrap qc={setup()}>
        <EmailForm lead={lead} />
      </Wrap>,
    );
    return posts;
  }
  const chips = () => [...document.querySelectorAll('.cchip')].map((x) => x.getAttribute('title'));

  it('not a client: disabled, "available once the lead is Won"', async () => {
    renderForm(baseLead, { items: [], isClient: false });
    const pick = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    expect(pick.disabled).toBe(true);
    expect(pick.selectedOptions[0]!.textContent).toBe('available once the lead is Won');
  });

  it('a client with no projects: "no projects yet"', async () => {
    renderForm(client, { items: [], isClient: true });
    const pick = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    await waitFor(() => expect(pick.selectedOptions[0]!.textContent).toBe('no projects yet'));
  });

  it("defaults to this lead's project with its stakeholders ticked; switching swaps them and keeps hand-added Cc; sends projectId", async () => {
    const u = userEvent.setup();
    const posts = renderForm(client, {
      isClient: true,
      items: [
        prj(9, 'Other site', null, [stakeholder(31, 'Cleo', 'cleo@meridian.in'), stakeholder(32, 'Tom Hale', 'TOM@meridian.in')]),
        prj(3, 'Website', 5, [stakeholder(21, 'Ava', 'ava@meridian.in'), stakeholder(22, 'No Mail', null), stakeholder(23, 'Bo', 'bo@meridian.in')]),
      ],
    });
    const pick = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    await waitFor(() => expect(pick).toHaveValue('3'));
    expect(pick.disabled).toBe(false);
    expect(within(pick).getByRole('option', { name: '— no project —' })).toBeTruthy();
    expect(within(pick).getByRole('option', { name: 'PRJ-9 · Other site' })).toBeTruthy();
    expect(chips()).toEqual(['ava@meridian.in', 'bo@meridian.in']);
    const cc = screen.getByRole('combobox', { name: 'Cc stakeholders' });
    await u.type(cc, 'hand@meridian.in{Enter}');
    expect(chips()).toEqual(['ava@meridian.in', 'bo@meridian.in', 'hand@meridian.in']);
    // Tom is the To address: not copied.
    await u.selectOptions(pick, '9');
    expect(chips()).toEqual(['hand@meridian.in', 'cleo@meridian.in']);
    await u.selectOptions(pick, '');
    expect(chips()).toEqual(['hand@meridian.in']);
    await u.selectOptions(pick, '9');
    await u.click(screen.getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(posts[0]).toMatchObject({ url: '/api/leads/5/emails', body: { projectId: 9, cc: ['hand@meridian.in', 'cleo@meridian.in'] } }));
  });

  it('an empty Subject is marked and focused instead of sending (review #12); a server field issue is marked too', async () => {
    const u = userEvent.setup();
    const posts = renderForm(client, { items: [], isClient: true });
    const subject = screen.getByRole('textbox', { name: 'Subject' });
    await u.clear(subject);
    await u.click(screen.getByRole('button', { name: 'Send email' }));
    expect(subject).toHaveAttribute('aria-invalid', 'true');
    expect(subject).toHaveClass('err');
    expect(subject).toHaveFocus();
    expect(screen.getByText('Enter a subject')).toBeInTheDocument();
    expect(posts).toEqual([]);
    await u.type(subject, 'Hello');
    expect(subject).not.toHaveAttribute('aria-invalid', 'true');

    // The server rejects the message body: Message is marked, and the toast's "highlighted fields" is true.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ error: 'validation', issues: [{ path: ['body'], message: 'Too big' }] }, { status: 400 });
      if (url === '/api/mailboxes') return Response.json({ mine: { id: 7, address: 'arjun@daitpartners.com', status: 'connected' } });
      return Response.json({ items: [], total: 0, page: 1, pageSize: 100, isClient: true });
    }));
    await u.click(screen.getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('aria-invalid', 'true'));
  });
});

