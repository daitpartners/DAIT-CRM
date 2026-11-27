import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import { UndoSendProvider } from '../src/components/send/UndoSend';
import type { MailMeta } from '../src/api/mail';
import type { ProjectRow } from '../src/api/projects';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import { draftApi, draftView } from './draftFixture';
import { makeClient, makeLead, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const me = { ...rep, rights: [...rep.rights, 'use_email' as const] };

const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T09:00:00.000Z' },
  unread: 0, counts: { inbox: 0, drafts: 0, scheduled: 0, flagged: 0, awaiting: 0, due: 0, leads: 0 }, leadOwners: [], companies: [{ id: 4, name: 'Acme', legalName: null, isClient: true }], leads: [{ id: 5, number: 'LD-1005', companyId: 4, companyName: 'Acme', status: 'Won' }],
  projects: [{ id: 3, number: 'PRJ-3', name: 'Website rebuild', companyId: 4 }], mailUsers: [],
};

const project = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 3, number: 'PRJ-3', name: 'Website rebuild', status: 'Active', startDate: '2026-11-01', value: 1000, currency: 'USD',
  company: { id: 4, name: 'Acme', legalName: null }, lead: { id: 5, number: 'LD-1005', visible: true }, quotation: null, manager: { id: 2, name: 'Arjun Mehta' },
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

function stub(companyProjects: { items: ProjectRow[]; isClient: boolean } = { items: [project()], isClient: true }, meta: MailMeta = META) {
  const api = draftApi({
    made: (n, b) => draftView({
      id: n, replyToId: null, to: [], subject: '', quotedHtml: null, leadId: (b.leadId as number | undefined) ?? null,
      projectId: (b.projectId as number | undefined) ?? null, lead: null,
    }),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const handled = api.handle(url, init);
    if (handled) return handled;
    if (url.startsWith('/api/mail?')) return Response.json({ items: [], total: 0, page: 1, pageSize: 50 });
    if (url === '/api/mail/meta') return Response.json(meta);
    if (url === '/api/me') return Response.json(me);
    if (url === '/api/email-templates') return Response.json({ items: [] });
    if (url === '/api/companies/4/projects') return Response.json(companyProjects);
    if (url === '/api/leads/5') {
      return Response.json(makeLead({
        companyName: 'Acme', status: 'Won',
        contact: { ...makeLead().contact!, name: 'Ana Ruiz', email: 'ana@acme.com', businessEmail: 'ana@acme.com' },
      }));
    }
    if (url.startsWith('/api/leads')) return Response.json({ items: [leadRow], total: 1, page: 1, pageSize: 8 });
    return Response.json({ items: [] });
  }));
  return api;
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
            <UndoSendProvider>
              <MemoryRouter initialEntries={[path]}>
                <Routes>
                  <Route path="/email" element={<EmailPage />} />
                  <Route path="/email/new" element={<EmailPage />} />
                </Routes>
                <Where />
              </MemoryRouter>
            </UndoSendProvider>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const form = () => screen.findByRole('form', { name: 'New message' });

describe('New message: Lead → Project (release 3B tagging on the full page, plan decision 13)', () => {
  it('without a lead or a client there is no Project field', async () => {
    const u = userEvent.setup();
    stub();
    show('/email');
    await u.click(await screen.findByRole('button', { name: 'New mail' }));
    const f = await form();
    expect(within(f).queryByRole('combobox', { name: 'Project' })).toBeNull();
  });

  it("a lead of a client with projects shows Project; choosing one copies its stakeholders with an email (not To) and files projectId", async () => {
    const u = userEvent.setup();
    const api = stub();
    show('/email?lead=5');
    await u.click(await screen.findByRole('button', { name: 'New mail' }));
    const f = await form();
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'new', leadId: 5 }]);
    const pick = await within(f).findByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    await within(f).findByRole('option', { name: 'PRJ-3 · Website rebuild' });
    expect(pick.disabled).toBe(false);
    expect(pick.selectedOptions[0]!.textContent).toBe('— no project —');
    await waitFor(() => expect(within(f).getByText('ana@acme.com')).toBeInTheDocument());
    await u.selectOptions(pick, '3');
    expect(await within(f).findByText('ben@acme.com')).toBeInTheDocument();
    expect(within(f).getAllByText('ana@acme.com')).toHaveLength(1);
    await u.type(within(f).getByRole('textbox', { name: 'Subject' }), 'Kick-off');
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({
      to: ['ana@acme.com'], cc: ['ben@acme.com'], subject: 'Kick-off', leadId: 5, projectId: 3,
    }), { timeout: 4000 });
  });

  it('clearing the project files none', async () => {
    const u = userEvent.setup();
    const api = stub();
    show('/email?lead=5');
    await u.click(await screen.findByRole('button', { name: 'New mail' }));
    const f = await form();
    await within(f).findByRole('option', { name: 'PRJ-3 · Website rebuild' });
    const pick = within(f).getByRole('combobox', { name: 'Project' });
    await u.selectOptions(pick, '3');
    await u.selectOptions(pick, '');
    expect(pick).toHaveValue('');
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({ leadId: 5, projectId: null }), { timeout: 4000 });
  });

  it('a lead of a client with no projects shows no Project field', async () => {
    const u = userEvent.setup();
    stub({ items: [], isClient: true });
    show('/email?lead=5');
    await u.click(await screen.findByRole('button', { name: 'New mail' }));
    const f = await form();
    await waitFor(() => expect(within(f).getByText('ana@acme.com')).toBeInTheDocument());
    expect(within(f).queryByRole('combobox', { name: 'Project' })).toBeNull();
  });

  it('/email?compose=1&company=&lead=&project= opens the New message page with the lead, the project and its Cc', async () => {
    const api = stub();
    show('/email?compose=1&company=4&lead=5&project=3');
    const f = await form();
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'new', leadId: 5, projectId: 3 }]);
    await waitFor(() => expect(within(f).getByRole('combobox', { name: 'Project' })).toHaveValue('3'));
    expect(await within(f).findByRole('button', { name: 'LD-1005 · Acme · Won' })).toBeInTheDocument();
    await waitFor(() => expect(within(f).getByText('ben@acme.com')).toBeInTheDocument());
    // The one-off link is not kept in the address (a refresh or Back does not make another draft).
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email/new?draft=50&company=4'));
  });
});
