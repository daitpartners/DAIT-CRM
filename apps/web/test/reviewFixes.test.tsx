import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { keys } from '../src/api/queries';
import { ComposeContext, ComposePanel } from '../src/pages/leads/ComposePanel';
import { FollowUpPanel } from '../src/pages/leads/FollowUpPanel';
import { SideColumn } from '../src/pages/leads/SideColumn';
import { STATUSES, Wrap, makeClient, makeLead, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const control = { tab: 'email', setTab: vi.fn(), closed: false, setClosed: vi.fn(), openEmail: vi.fn() };
const noContact = { contact: null, contactId: null };
const priya = {
  ...makeLead().contact!, id: 21, firstName: 'Priya', lastName: 'Raman', name: 'Priya Raman', email: 'priya@northwind.in',
};

describe('review fixes', () => {
  it('the Email form follows a newly linked contact (To and greeting)', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], total: 0, page: 1, pageSize: 100 })));
    const qc = makeClient();
    const view = (lead: ReturnType<typeof makeLead>) => (
      <Wrap qc={qc}>
        <ComposeContext.Provider value={control}>
          <ComposePanel lead={lead} statuses={STATUSES} live />
        </ComposeContext.Provider>
      </Wrap>
    );
    const { rerender } = render(view(makeLead(noContact)));
    expect(screen.getByLabelText('To')).toHaveValue('');
    rerender(view(makeLead({ contact: priya, contactId: 21 })));
    expect(screen.getByLabelText('To')).toHaveValue('priya@northwind.in');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toMatch(/^Hi Priya,/);
  });

  it('a contact that was added but could not be linked says so', async () => {
    const u = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/contacts' && init?.method === 'POST') return Response.json({ ...priya, firstName: 'Layla', lastName: 'Haddad', id: 30 });
      if (url === '/api/leads/5/contact') return Response.json({ error: 'stale' }, { status: 409 });
      if (url === '/api/me') return Response.json(rep);
      return Response.json({ items: [], total: 0, page: 1, pageSize: 25, candidates: [] });
    }));
    render(
      <Wrap qc={makeClient()}>
        <SideColumn lead={makeLead(noContact)} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: 'Add contact' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add contact' });
    await u.type(within(dialog).getByLabelText(/First name/), 'Layla');
    await u.type(within(dialog).getByLabelText(/Last name/), 'Haddad');
    await u.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Layla Haddad was added to the company but not linked to this lead. Use Switch contact in Edit profile.')).toBeInTheDocument();
  });

  it('on a closed lead the other closed statuses are disabled (reopen first)', () => {
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead({ status: 'Lost' })} statuses={STATUSES} live />
      </Wrap>,
    );
    const status = screen.getByLabelText('Status');
    expect(within(status).getByRole('option', { name: 'Won' })).toBeDisabled();
    expect(within(status).getByRole('option', { name: 'Not Relevant' })).toBeDisabled();
    expect(within(status).getByRole('option', { name: 'Contacted' })).toBeEnabled();
  });

  it('the Cc picker announces the highlighted person and ArrowDown from closed starts at the first', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], total: 0, page: 1, pageSize: 100 })));
    const qc = makeClient();
    qc.setQueryData(keys.users, [
      { id: 7, email: 'ana@daitpartners.com', name: 'Ana Silva', role: 'MANAGER', language: 'en', timezone: 'UTC', isActive: true, lastLoginAt: null },
      { id: 8, email: 'ben@daitpartners.com', name: 'Ben Ode', role: 'MANAGER', language: 'en', timezone: 'UTC', isActive: true, lastLoginAt: null },
    ]);
    render(
      <Wrap qc={qc}>
        <ComposeContext.Provider value={control}>
          <ComposePanel lead={makeLead(noContact)} statuses={STATUSES} live />
        </ComposeContext.Provider>
      </Wrap>,
    );
    const cc = screen.getByRole('combobox', { name: 'Cc stakeholders' });
    fireEvent.keyDown(cc, { key: 'ArrowDown' });
    const first = screen.getByRole('option', { name: /Ana Silva/ });
    expect(cc).toHaveAttribute('aria-activedescendant', first.id);
    expect(first.id).not.toBe('');
  });
});
