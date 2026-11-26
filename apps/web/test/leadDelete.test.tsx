import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { LeadDeletePreview } from '@dait-crm/shared';
import type { Me } from '../src/api/queries';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { ToastProvider } from '../src/components/Toast';
import { LeadPage } from '../src/pages/leads/LeadPage';
import { DeleteLeadsModal } from '../src/pages/leads/DeleteLeadsModal';
import { Wrap, makeClient, makeLead } from './leadFixture';

const manager: Me = {
  id: 3, email: 'mona@daitpartners.com', name: 'Mona Rao', role: 'Manager', language: 'en', timezone: 'UTC', dateFormat: 'DD/MM/YYYY',
  rights: ['manage_leads', 'claim_leads', 'manage_companies', 'view_all_leads', 'transfer_leads', 'import_leads', 'view_all_companies'],
};
const admin: Me = { ...manager, id: 1, name: 'Deepak Singh', role: 'Administrator', rights: [...manager.rights, 'manage_lookups', 'undo_imports', 'delete_leads'] };

const preview: LeadDeletePreview = {
  remove: {
    leads: [{ id: 5, number: 'LD-1005', companyName: 'Meridian Textiles' }],
    companies: [{ id: 4, number: 'CO-0245', name: 'Meridian Textiles' }],
    contacts: [{ id: 9, name: 'Tom Hale' }, { id: 10, name: 'Rita Bose' }], draftQuotations: 1, tasks: 3,
  },
  keep: [],
  notFound: 0,
  plan: { leads: [5], companies: [4], contacts: [9, 10], quotations: [31] },
};

afterEach(() => vi.unstubAllGlobals());

function renderPage(me: Me, lead = makeLead()) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/leads/5') return Response.json(lead);
    if (url === '/api/leads/delete/preview') return Response.json(preview);
    throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
  }));
  render(
    <QueryClientProvider client={makeClient(me)}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/leads/5']}>
            <Routes>
              <Route path="/leads/:id" element={<LeadPage />} />
              <Route path="/leads" element={<p>Leads list</p>} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('delete lead: who sees it', () => {
  it('Administrators find Delete lead… in the Edit profile lead actions; Managers do not', async () => {
    const u = userEvent.setup();
    renderPage(admin);
    await u.click(await screen.findByRole('button', { name: 'Edit profile' }));
    const acts = screen.getByRole('group', { name: 'Lead LD-1005' });
    await u.click(within(acts).getByRole('button', { name: 'Delete lead…' }));
    expect(await screen.findByRole('dialog', { name: 'Delete lead?' })).toBeInTheDocument();
  });

  it('a Manager sees no delete action, on a live or an archived lead', async () => {
    const u = userEvent.setup();
    renderPage(manager);
    await u.click(await screen.findByRole('button', { name: 'Edit profile' }));
    expect(within(screen.getByRole('group', { name: 'Lead LD-1005' })).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete lead…' })).not.toBeInTheDocument();
  });

  it('an archived lead offers Delete lead… beside Restore to Administrators only', async () => {
    renderPage(admin, makeLead({ archivedAt: '2026-11-22T10:00:00.000Z' }));
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete lead…' })).toBeInTheDocument();
  });

  it('…and not to Managers', async () => {
    renderPage(manager, makeLead({ archivedAt: '2026-11-22T10:00:00.000Z' }));
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete lead…' })).not.toBeInTheDocument();
  });
});

describe('delete dialog', () => {
  function renderModal(p: LeadDeletePreview, onDeleted = vi.fn(), onArchiveInstead?: () => void, hold?: Promise<void>) {
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/leads/delete/preview') return Response.json(p);
      if (url === '/api/leads/delete') {
        posted.push(JSON.parse(String(init?.body)));
        await hold;
        return Response.json(p);
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    render(
      <Wrap qc={makeClient(admin)}>
        <DeleteLeadsModal ids={[5]} onClose={vi.fn()} onDeleted={onDeleted} onArchiveInstead={onArchiveInstead} />
      </Wrap>,
    );
    return posted;
  }

  it('lists what is removed and that emails stay, and deletes only after "delete" is typed', async () => {
    const u = userEvent.setup();
    const onDeleted = vi.fn();
    let release!: () => void;
    const posted = renderModal(preview, onDeleted, undefined, new Promise<void>((r) => { release = r; }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete lead?' });
    expect(await within(dialog).findByText(
      'Will be removed for good: 1 lead with their notes, tasks and timeline, 1 company, 2 contacts. 1 draft quotation goes too.',
    )).toBeInTheDocument();
    expect(within(dialog).getByText('LD-1005 · Meridian Textiles')).toBeInTheDocument();
    expect(within(dialog).getByText('CO-0245 · Meridian Textiles')).toBeInTheDocument();
    expect(within(dialog).getByText('Contacts removed with their company:')).toBeInTheDocument();
    expect(within(dialog).getByText('Tom Hale')).toBeInTheDocument();
    expect(within(dialog).getByText('Rita Bose')).toBeInTheDocument();
    expect(within(dialog).getByText(/Emails and calendar events are not deleted/)).toBeInTheDocument();
    const button = within(dialog).getByRole('button', { name: 'Delete permanently' });
    expect(button).toBeDisabled();
    const input = within(dialog).getByLabelText('Type "delete" to confirm');
    await u.type(input, 'Delete');
    expect(button).toBeDisabled();
    await u.clear(input);
    await u.type(input, 'delet');
    expect(button).toBeDisabled();
    await u.type(input, 'e');
    expect(button).toBeEnabled();
    // Enter twice in the field sends once (the button's pending guard holds for Enter too).
    await u.type(input, '{Enter}{Enter}');
    expect(button).toBeDisabled();
    release();
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(posted).toEqual([{ ids: [5], plan: preview.plan, confirm: 'delete' }]);
  });

  it('shows what is kept and why, and offers Archive instead for a lead that cannot be deleted', async () => {
    const u = userEvent.setup();
    const archive = vi.fn();
    renderModal({
      remove: { leads: [], companies: [], contacts: [], draftQuotations: 0, tasks: 0 },
      keep: [{ kind: 'lead', id: 5, label: 'LD-1005 · Meridian Textiles', reason: 'quotations' }],
      notFound: 1,
      plan: { leads: [], companies: [], contacts: [], quotations: [] },
    }, vi.fn(), archive);
    const dialog = await screen.findByRole('dialog', { name: 'Delete lead?' });
    expect(await within(dialog).findByText('LD-1005 · Meridian Textiles — Has a sent quotation')).toBeInTheDocument();
    expect(within(dialog).getByText('Nothing can be deleted.')).toBeInTheDocument();
    expect(within(dialog).getByText('1 of the chosen leads was not found (already deleted).')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Type "delete" to confirm')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: 'Archive instead' }));
    expect(archive).toHaveBeenCalled();
  });

  it('a company kept for its other leads reads with its reason', async () => {
    renderModal({
      ...preview,
      remove: { ...preview.remove, companies: [], contacts: [], draftQuotations: 0 },
      keep: [{ kind: 'company', id: 4, label: 'CO-0245 · Meridian Textiles', reason: 'other_leads' }],
      plan: { leads: [5], companies: [], contacts: [], quotations: [] },
    });
    expect(await screen.findByText('CO-0245 · Meridian Textiles — Has other leads')).toBeInTheDocument();
    expect(screen.getByText('Will be removed for good: 1 lead with their notes, tasks and timeline, 0 companies, 0 contacts.')).toBeInTheDocument();
    expect(screen.queryByText('Contacts removed with their company:')).not.toBeInTheDocument();
  });
});
