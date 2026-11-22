import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import type { MailMeta } from '../src/api/mail';
import type { ProjectRow } from '../src/api/projects';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import { makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const me = { ...rep, rights: [...rep.rights, 'use_email' as const] };

const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T09:00:00.000Z' },
  unread: 0, unlinked: 0, companies: [{ id: 4, name: 'Acme', isClient: true }], leads: [{ id: 5, number: 'LD-1005', companyId: 4, companyName: 'Acme', status: 'Won' }],
  projects: [{ id: 3, number: 'PRJ-3', name: 'Website rebuild', companyId: 4 }],
};

const contact = (id: number, first: string, email: string, isPrimary = false) => ({
  id, companyId: 4, company: { id: 4, number: 'CO-0004', name: 'Acme' }, firstName: first, lastName: 'Ruiz', designation: null,
  department: null, businessEmail: email, phone: null, mobile: null, linkedinUrl: null, contactType: 'Decision Maker',
  isPrimary, isActive: true, updatedAt: '',
});

const project = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 3, number: 'PRJ-3', name: 'Website rebuild', status: 'Active', startDate: '2026-11-01', value: 1000, currency: 'USD',
  company: { id: 4, name: 'Acme' }, lead: { id: 5, number: 'LD-1005', visible: true }, quotation: null, manager: { id: 2, name: 'Arjun Mehta' },
  // Ana is the To address (primary contact): she is not copied. Carl has no email: skipped.
  stakeholders: [
    { id: 11, name: 'Ana Ruiz', email: 'ANA@acme.com' },
    { id: 12, name: 'Ben Ruiz', email: 'ben@acme.com' },
    { id: 13, name: 'Carl Ruiz', email: null },
  ],
  description: null, completedAt: null, createdAt: '', updatedAt: '', canEdit: true, ...over,
});

const leadRow = {
  id: 5, number: 'LD-1005', leadType: 'Lead', companyName: 'Acme', companyId: 4, company: { id: 4, number: 'CO-0004', name: 'Acme' }, contact: null,
  country: 'India', outreachLanguage: 'en', city: null, leadSource: 'Referral', status: 'Won', priority: 'Medium', assignedTo: null,
  nextFollowUp: null, isOverdue: false, archivedAt: null, createdAt: '', updatedAt: '',
};

function stub(companyProjects: { items: ProjectRow[]; isClient: boolean } = { items: [project()], isClient: true }) {
  const posts: { url: string; body: unknown }[] = [];
  const gets: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ id: 99 }, { status: 201 });
    }
    gets.push(url);
    if (url.startsWith('/api/mail?')) return Response.json({ items: [], total: 0, page: 1, pageSize: 50 });
    if (url === '/api/mail/meta') return Response.json(META);
    if (url === '/api/me') return Response.json(me);
    if (url === '/api/companies/4/projects') return Response.json(companyProjects);
    if (url.startsWith('/api/leads')) return Response.json({ items: [leadRow], total: 1, page: 1, pageSize: 100 });
    if (url.startsWith('/api/contacts')) {
      return Response.json({ items: [contact(11, 'Ana', 'ana@acme.com', true), contact(12, 'Ben', 'ben@acme.com')], total: 2, page: 1, pageSize: 100 });
    }
    if (url.startsWith('/api/companies')) return Response.json({ items: [], total: 0, page: 1, pageSize: 100 });
    return Response.json({ items: [] });
  }));
  return { posts, gets };
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function show(path: string) {
  return render(
    <QueryClientProvider client={makeClient(me)}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/email" element={<EmailPage />} />
              </Routes>
              <Where />
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Compose: Client → Lead → Project (release 3B, prototype V.compose)', () => {
  it('without a client the Project picker waits for one', async () => {
    const u = userEvent.setup();
    stub();
    show('/email');
    await u.click(await screen.findByRole('button', { name: '+ Compose' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    const pick = within(dialog).getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    expect(pick.disabled).toBe(true);
    expect(pick.selectedOptions[0]!.textContent).toBe('choose client first');
  });

  it("choosing a project fills its lead, copies its stakeholders with an email (not To) and sends projectId; clearing it empties Cc", async () => {
    const u = userEvent.setup();
    const { posts } = stub();
    show('/email?company=4');
    await u.click(await screen.findByRole('button', { name: '+ Compose' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    const pick = within(dialog).getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    await within(dialog).findByRole('option', { name: 'PRJ-3 · Website rebuild' });
    expect(pick.disabled).toBe(false);
    expect(pick.selectedOptions[0]!.textContent).toBe('— no project —');
    await waitFor(() => expect(within(dialog).getByLabelText('To')).toHaveValue('ana@acme.com'));
    await u.selectOptions(pick, '3');
    expect(within(dialog).getByRole('combobox', { name: 'Lead' })).toHaveValue('5');
    expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('ben@acme.com');
    expect(within(dialog).getByText('Acme · LD-1005 · Website rebuild')).toBeTruthy();
    await u.type(within(dialog).getByLabelText('Subject'), 'Kick-off');
    await u.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts[0]).toMatchObject({
      url: '/api/mail', body: { to: 'ana@acme.com', cc: ['ben@acme.com'], leadId: 5, companyId: 4, projectId: 3 },
    }));
  });

  it('clearing the project puts Cc back to how it was without one', async () => {
    const u = userEvent.setup();
    stub();
    show('/email?company=4');
    await u.click(await screen.findByRole('button', { name: '+ Compose' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    await within(dialog).findByRole('option', { name: 'PRJ-3 · Website rebuild' });
    const pick = within(dialog).getByRole('combobox', { name: 'Project' });
    await u.selectOptions(pick, '3');
    expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('ben@acme.com');
    await u.selectOptions(pick, '');
    expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('');
  });

  it('a client with no projects says so', async () => {
    const u = userEvent.setup();
    stub({ items: [], isClient: true });
    show('/email?company=4');
    await u.click(await screen.findByRole('button', { name: '+ Compose' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    const pick = within(dialog).getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    await waitFor(() => expect(pick.selectedOptions[0]!.textContent).toBe('no projects yet'));
  });

  it('/email?compose=1&company=&lead=&project= opens Compose preset with the project and its Cc', async () => {
    stub();
    show('/email?compose=1&company=4&lead=5&project=3');
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Project' })).toHaveValue('3'));
    // The client marked as in the prototype's Client picker.
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Client' })).toHaveValue('Acme · client'));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Lead' })).toHaveValue('5'));
    await waitFor(() => expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('ben@acme.com'));
    // The one-off open is not kept in the address (a refresh or Back does not reopen it); the filters stay.
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?company=4&lead=5&project=3'));
  });
});
