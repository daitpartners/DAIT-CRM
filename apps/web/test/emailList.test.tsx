import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import type { MailDetail, MailItem, MailMeta } from '../src/api/mail';
import type { Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import { commandState, rowTarget, selectionTarget } from '../src/pages/email/useMailCommands';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const me: Me = { ...rep, timezone: 'Europe/London', rights: [...rep.rights, 'use_email' as const] };
const admin: Me = { ...me, id: 1, name: 'Maya Iyer', role: 'Administrator', rights: [...me.rights, 'view_team_mail' as const] };

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, owner: { id: 2, name: 'Arjun Mehta' }, viewOnly: false, leadRestricted: false, folder: 'inbox', status: 'received', fromAddress: 'ana@acme.com',
  fromName: 'Ana Ruiz', toAddresses: ['arjun@daitpartners.com'], subject: 'Proposal', preview: 'Looks good', occurredAt: '2026-11-26T10:00:00.000Z',
  isRead: true, leadId: null, leadNumber: null, companyId: null, hasAttachments: false, projectId: null, projectNumber: null,
  flagStatus: 'notFlagged', flagDue: null, replied: false, conversationCount: 1, leadStatus: null, ...over,
});
const detail = (m: MailItem): MailDetail => ({
  ...m, ccAddresses: [], bodyText: 'Looks good', bodyHtml: null, attachmentNames: [], loggedAt: null, lead: null, contact: null, company: null,
  restrictedLead: null, leadPanel: null, thread: [],
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-26T09:00:00.000Z' },
  unread: 3, counts: { inbox: 3, drafts: 0, scheduled: 0, flagged: 1, awaiting: 0, due: 0, leads: 2 },
  companies: [], leads: [], projects: [], mailUsers: [{ id: 9, name: 'Carlos Torres' }], leadOwners: [],
};

/** Serves the list and messages; records every list request and POST, answering /change and /bulk like the API. */
function stub(items: MailItem[], user: Me = me) {
  const posts: { url: string; body: unknown }[] = [];
  const lists: URLSearchParams[] = [];
  const changed = (id: number, c: { type: string; folder?: string; isRead?: boolean; flag?: string }) => {
    const m = items.find((x) => x.id === id) ?? item({ id });
    return {
      id, removed: c.type === 'delete' && m.folder === 'deleted',
      folder: c.type === 'move' ? c.folder! : c.type === 'delete' ? 'deleted' : m.folder,
      isRead: c.type === 'read' ? c.isRead! : m.isRead,
      flagStatus: c.type === 'flag' ? (c.flag === 'clear' ? 'notFlagged' : c.flag === 'complete' ? 'complete' : 'flagged') : m.flagStatus,
      flagDue: null,
    };
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      const one = /^\/api\/mail\/(\d+)\/change$/.exec(url);
      if (one) return Response.json(changed(Number(one[1]), body));
      if (url === '/api/mail/bulk') return Response.json({ done: body.ids.map((id: number) => changed(id, body.change)), failed: [] });
      return Response.json({ id: 99 }, { status: 201 });
    }
    if (url === '/api/me') return Response.json(user);
    if (url.startsWith('/api/mail?')) {
      lists.push(new URL(url, 'http://x').searchParams);
      return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    }
    if (url.startsWith('/api/mail/meta')) return Response.json(META);
    const m = /^\/api\/mail\/(\d+)(\?peek=1)?$/.exec(url);
    if (m) return Response.json(detail(items.find((x) => x.id === Number(m[1])) ?? item({ id: Number(m[1]) })));
    return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
  }));
  return { posts, lists };
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function show(path = '/email', user: Me = me) {
  return render(
    <QueryClientProvider client={makeClient(user)}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/email" element={<EmailPage />} />
                <Route path="/email/:id" element={<EmailPage />} />
                <Route path="*" element={null} />
              </Routes>
              <Where />
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Thursday 26 Nov 2026, 15:00 in London (only Date is faked: the queries' timers stay real). */
function thursday() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-26T15:00:00.000Z'));
}

const region = () => screen.getByRole('region', { name: 'Message list' });
const rowOf = async (name: RegExp) => (await within(region()).findByRole('link', { name })).closest('.mrow') as HTMLElement;
const where = () => new URL(screen.getByTestId('where').textContent!, 'http://x');

const james = item({
  id: 1, fromName: 'James Whitaker', fromAddress: 'james@northwind.com', subject: 'Re: Discovery call notes', occurredAt: '2026-11-26T12:48:00.000Z',
  isRead: false, conversationCount: 4, leadId: 5, leadNumber: 'LD-1204', leadStatus: 'Proposal', replied: true, hasAttachments: true, flagStatus: 'flagged',
});
const laura = item({ id: 2, fromName: 'Laura Chen', subject: 'Re: Quotation', occurredAt: '2026-11-25T17:46:00.000Z' });

describe('Email message list (web-mail release 2, mockup states 1, 4, 5)', () => {
  it('rows: unread bold, icons, count, 24-hour time, lead chip with stage; groups Today / Yesterday', async () => {
    thursday();
    stub([james, laura]);
    show();
    const row = await screen.findByRole('link', { name: /James Whitaker.*Re: Discovery call/ });
    const r = row.closest('.mrow')! as HTMLElement;
    expect(r).toHaveClass('unread');
    expect(within(r).getByTitle('4 messages in this conversation')).toHaveTextContent('4');
    expect(within(r).getByText('LD-1204 · Proposal')).toBeInTheDocument();
    expect(within(r).getByTitle('You replied')).toBeInTheDocument();
    expect(within(r).getByTitle('Has attachments')).toBeInTheDocument();
    expect(within(r).getByTitle('Flagged')).toBeInTheDocument();
    expect(within(r).getByText('12:48')).toBeInTheDocument();
    const l = await rowOf(/Laura Chen/);
    expect(l).not.toHaveClass('unread');
    expect(within(l).getByText('Yesterday 17:46')).toBeInTheDocument();
    expect(within(l).queryByTitle(/messages in this conversation/)).toBeNull();
    // F11: scoped to the list, so the lead panel's own heading does not count.
    expect(within(region()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Today', 'Yesterday']);
    // The header: the view's name and the Inbox's unread count; no release-1 "Unlinked" badge on an unlinked row.
    expect(within(region()).getByRole('heading', { level: 2 })).toHaveTextContent('Inbox');
    expect(within(region()).getByText('3 unread')).toBeInTheDocument();
    expect(within(region()).queryByText('Unlinked · create lead?')).toBeNull();
  });

  it('date groups: Today, Yesterday, This week (from Monday), Last week, Older', async () => {
    thursday();
    stub([
      item({ id: 1, subject: 'A', occurredAt: '2026-11-26T08:00:00.000Z' }),
      item({ id: 2, subject: 'B', occurredAt: '2026-11-25T08:00:00.000Z' }),
      item({ id: 3, subject: 'C', occurredAt: '2026-11-23T08:00:00.000Z' }),
      item({ id: 4, subject: 'D', occurredAt: '2026-11-18T08:00:00.000Z' }),
      item({ id: 5, subject: 'E', occurredAt: '2026-11-01T08:00:00.000Z' }),
    ]);
    show();
    await waitFor(() => expect(within(region()).getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
      .toEqual(['Today', 'Yesterday', 'This week', 'Last week', 'Older']));
    expect(within(await rowOf(/, C$/)).getByText('Mon 23 Nov')).toBeInTheDocument();
  });

  it('chips and the Conversation view switch go into the request (chip=unread, conv=0)', async () => {
    const u = userEvent.setup();
    const { lists } = stub([laura]);
    show();
    await rowOf(/Laura Chen/);
    const chips = within(region()).getByRole('group', { name: 'Quick filters' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Unread', 'Flagged', 'Attachments']);
    expect(within(chips).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await u.click(within(chips).getByRole('button', { name: 'Unread' }));
    await waitFor(() => expect(where().searchParams.get('chip')).toBe('unread'));
    await waitFor(() => expect(lists.at(-1)!.get('chip')).toBe('unread'));
    const sw = within(region()).getByRole('switch', { name: 'Conversation view' });
    expect(sw).toBeChecked();
    expect(lists.at(-1)!.has('conv')).toBe(false);
    await u.click(sw);
    await waitFor(() => expect(where().searchParams.get('conv')).toBe('0'));
    await waitFor(() => expect(lists.at(-1)!.get('conv')).toBe('0'));
    expect(within(region()).getByRole('switch', { name: 'Conversation view' })).not.toBeChecked();
    // All goes back to no chip in the address.
    await u.click(within(region()).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(where().searchParams.has('chip')).toBe(false));
  });

  it('sort menu: Lead stage, Oldest on top → sort=stage&dir=asc; groups disappear', async () => {
    thursday();
    const u = userEvent.setup();
    const { lists } = stub([james, laura]);
    show();
    await rowOf(/Laura Chen/);
    expect(within(region()).getAllByRole('heading', { level: 3 })).toHaveLength(2);
    await u.click(within(region()).getByRole('button', { name: 'By date' }));
    const menu = screen.getByRole('menu', { name: 'Sort by' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent))
      .toEqual(['Date', 'From', 'Lead', 'Lead stage', 'Size', 'Newest on top', 'Oldest on top']);
    await u.click(within(menu).getByRole('menuitem', { name: 'Lead stage' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(where().searchParams.get('sort')).toBe('stage'));
    await u.click(within(region()).getByRole('button', { name: 'By lead stage' }));
    await u.click(within(screen.getByRole('menu', { name: 'Sort by' })).getByRole('menuitem', { name: 'Oldest on top' }));
    await waitFor(() => expect(lists.at(-1)!.get('sort')).toBe('stage'));
    await waitFor(() => expect(lists.at(-1)!.get('dir')).toBe('asc'));
    await waitFor(() => expect(within(region()).queryAllByRole('heading', { level: 3 })).toHaveLength(0));
    // From reads A to Z / Z to A, and starts A to Z.
    await u.click(within(region()).getByRole('button', { name: 'By lead stage' }));
    await u.click(within(screen.getByRole('menu', { name: 'Sort by' })).getByRole('menuitem', { name: 'From' }));
    await waitFor(() => expect(Object.fromEntries(where().searchParams)).toEqual({ sort: 'from', dir: 'asc' }));
    await u.click(within(region()).getByRole('button', { name: 'By from' }));
    expect(within(screen.getByRole('menu', { name: 'Sort by' })).getAllByRole('menuitem').slice(-2).map((b) => b.textContent)).toEqual(['A to Z', 'Z to A']);
  });

  it('hover Archive moves the row out at once and posts the change', async () => {
    const u = userEvent.setup();
    const { posts } = stub([item({ id: 1, subject: 'First' }), laura]);
    show();
    const row = await rowOf(/Laura Chen/);
    await u.click(within(row).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(within(region()).queryByRole('link', { name: /Laura Chen/ })).toBeNull());
    expect(posts.at(-1)).toEqual({ url: '/api/mail/2/change', body: { type: 'move', folder: 'archive' } });
  });

  it('a conversation row changes every message of its conversation in the view, in one bulk request (F24)', async () => {
    const u = userEvent.setup();
    const { posts } = stub([item({ id: 3, subject: 'Thread', conversationCount: 2, conversationIds: [3, 8] })]);
    show();
    const row = await rowOf(/Thread/);
    await u.click(within(row).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/mail/bulk', body: { ids: [3, 8], change: { type: 'move', folder: 'archive' } } }));
  });

  it('hover Mark as read / unread follows the row; Flag toggles; in Flagged a cleared flag drops the row', async () => {
    const u = userEvent.setup();
    const flagged = item({ id: 4, subject: 'Flag me', flagStatus: 'flagged', isRead: false });
    const { posts } = stub([flagged]);
    show('/email?folder=flagged');
    const row = await rowOf(/Flag me/);
    await u.click(within(row).getByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/mail/4/change', body: { type: 'read', isRead: true } }));
    expect(await within(row).findByRole('button', { name: 'Mark as unread' })).toBeInTheDocument();
    await u.click(within(row).getByRole('button', { name: 'Flag' }));
    await waitFor(() => expect(within(region()).queryByRole('link', { name: /Flag me/ })).toBeNull());
    expect(posts.at(-1)).toEqual({ url: '/api/mail/4/change', body: { type: 'flag', flag: 'clear' } });
  });

  it('team view: hover actions disabled on another mailbox with the view-only title; row names the mailbox', async () => {
    const u = userEvent.setup();
    const theirs = item({ id: 2, subject: 'Propuesta', viewOnly: true, owner: { id: 9, name: 'Carlos Torres' }, leadId: 5, leadNumber: 'LD-1212', leadStatus: 'Proposal' });
    const { posts } = stub([item({ id: 1, subject: 'Mine' }), theirs], admin);
    show('/email?mailof=all', admin);
    const row = await rowOf(/Propuesta/);
    expect(row).toHaveTextContent("Carlos's mailbox");
    for (const name of ['Delete', 'Archive', 'Flag', 'Mark as unread']) {
      const b = within(row).getByRole('button', { name });
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', "View only — Carlos's mailbox");
    }
    const mine = await rowOf(/Mine/);
    expect(mine).toHaveTextContent('Your mailbox');
    expect(within(mine).getByRole('button', { name: 'Archive' })).toBeEnabled();
    // Right-click: mailbox commands and Link to lead disabled; the CRM ones stay.
    await u.pointer({ keys: '[MouseRight]', target: within(row).getByRole('link') });
    const menu = screen.getByRole('menu', { name: 'Message actions' });
    for (const name of ['Reply', 'Delete', 'Move to', 'Link to lead']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeDisabled();
    }
    expect(within(menu).getByRole('menuitem', { name: 'Link to lead' })).toHaveAttribute('title', "View only — Carlos's mailbox");
    expect(within(menu).getByRole('menuitem', { name: 'Log as activity' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Open lead' })).toBeEnabled();
    expect(posts).toEqual([]);
  });

  it('checking two rows shows the bulk bar; Delete posts one bulk request for both', async () => {
    const u = userEvent.setup();
    const { posts } = stub([item({ id: 1, subject: 'First' }), laura]);
    show();
    const first = await rowOf(/First/);
    await u.click(within(first).getByRole('checkbox', { name: 'Select message' }));
    await u.click(within(await rowOf(/Laura Chen/)).getByRole('checkbox', { name: 'Select message' }));
    const list = region();
    expect(within(list).getByText('2 selected')).toBeInTheDocument();
    expect(within(list).queryByRole('switch', { name: 'Conversation view' })).toBeNull();
    for (const name of ['Delete', 'Archive', 'Move to ▾', 'Flag ▾', 'Mark as read', 'Clear selection']) {
      expect(within(list.querySelector('.ml-bulk') as HTMLElement).getByRole('button', { name })).toBeInTheDocument();
    }
    await u.click(within(list.querySelector('.ml-bulk') as HTMLElement).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/mail/bulk', body: { ids: [1, 2], change: { type: 'delete' } } }));
    // Both rows left the Inbox: the bulk bar goes with them.
    await waitFor(() => expect(within(list).queryByText(/selected/)).toBeNull());
  });

  it('the bulk bar: Flag ▾ sets a flag on both; Clear selection brings the header back', async () => {
    thursday();
    const u = userEvent.setup();
    const { posts } = stub([item({ id: 1, subject: 'First' }), laura]);
    show();
    await u.click(within(await rowOf(/First/)).getByRole('checkbox', { name: 'Select message' }));
    await u.click(within(await rowOf(/Laura Chen/)).getByRole('checkbox', { name: 'Select message' }));
    await u.click(within(region()).getByRole('button', { name: 'Flag ▾' }));
    const menu = screen.getByRole('menu', { name: 'Flag' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'TodayThu 26 Nov', 'TomorrowFri 27 Nov', 'This weekFri 27 Nov', 'Next weekMon 30 Nov', 'No date', 'Mark complete', 'Clear flag',
    ]);
    await u.click(within(menu).getByRole('menuitem', { name: /^Tomorrow/ }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/mail/bulk', body: { ids: [1, 2], change: { type: 'flag', flag: 'tomorrow' } } }));
    await u.click(within(region()).getByRole('button', { name: 'Clear selection' }));
    expect(within(region()).getByRole('switch', { name: 'Conversation view' })).toBeInTheDocument();
  });

  it('right-click opens the menu (state 4); Move to › opens Inbox / Archive / Deleted items; Esc closes it', async () => {
    const u = userEvent.setup();
    const { posts } = stub([item({ id: 1, subject: 'First', leadId: 5, leadNumber: 'LD-1005', leadStatus: 'Contacted' })]);
    show();
    const row = await rowOf(/First/);
    await u.pointer({ keys: '[MouseRight]', target: within(row).getByRole('link') });
    const menu = screen.getByRole('menu', { name: 'Message actions' });
    expect(within(menu).getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'Reply', 'Reply all', 'Forward', 'DeleteDel', 'ArchiveE', 'Move to›', 'Flag›', 'Mark as unreadCtrl+U',
      'Link to lead', 'Log as activity', 'Create task', 'Open lead',
    ]);
    expect(row).toHaveClass('hov');
    // The keyboard starts on the first item; ↓ moves on.
    expect(within(menu).getByRole('menuitem', { name: 'Reply' })).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Reply all' })).toHaveFocus();
    await u.click(within(menu).getByRole('menuitem', { name: /^Move to/ }));
    const sub = screen.getByRole('menu', { name: 'Move to' });
    expect(within(sub).getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Inbox', 'Archive', 'Deleted items']);
    expect(within(sub).getByRole('menuitem', { name: 'Inbox' })).toHaveFocus();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Move to' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: /^Move to/ })).toHaveFocus();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    // → opens the Flag submenu; choosing a folder runs it and closes everything.
    await u.pointer({ keys: '[MouseRight]', target: within(row).getByRole('link') });
    await u.hover(within(screen.getByRole('menu', { name: 'Message actions' })).getByRole('menuitem', { name: /^Move to/ }));
    await u.click(within(screen.getByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Archive' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/mail/1/change', body: { type: 'move', folder: 'archive' } }));
  });

  it('right-click: a click outside closes it; Open lead and Log as activity act on the row', async () => {
    const u = userEvent.setup();
    const { posts } = stub([item({ id: 1, subject: 'First', leadId: 5, leadNumber: 'LD-1005' })]);
    show();
    const row = await rowOf(/First/);
    await u.pointer({ keys: '[MouseRight]', target: within(row).getByRole('link') });
    await u.click(within(region()).getByRole('heading', { level: 2 }));
    expect(screen.queryByRole('menu')).toBeNull();
    await u.pointer({ keys: '[MouseRight]', target: within(row).getByRole('link') });
    await u.click(screen.getByRole('menuitem', { name: 'Log as activity' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/mail/1/log', body: undefined }));
    expect(await screen.findByText('Logged on LD-1005')).toBeInTheDocument();
    await u.pointer({ keys: '[MouseRight]', target: within(row).getByRole('link') });
    await u.click(screen.getByRole('menuitem', { name: 'Open lead' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/leads/5'));
  });

  it('right-click: CRM commands wait for a lead; Link to lead opens the link window', async () => {
    const u = userEvent.setup();
    stub([item({ id: 1, subject: 'First' })]);
    show();
    const row = await rowOf(/First/);
    await u.pointer({ keys: '[MouseRight]', target: within(row).getByRole('link') });
    const menu = screen.getByRole('menu', { name: 'Message actions' });
    for (const name of ['Log as activity', 'Create task', 'Open lead']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeDisabled();
      expect(within(menu).getByRole('menuitem', { name })).toHaveAttribute('title', 'Link it to a lead first');
    }
    await u.click(within(menu).getByRole('menuitem', { name: 'Link to lead' }));
    expect(await screen.findByRole('dialog', { name: 'Link email to a lead' })).toBeInTheDocument();
  });

  it('Delete in Deleted items asks to delete permanently first', async () => {
    const u = userEvent.setup();
    const gone = item({ id: 6, subject: 'Old one', folder: 'deleted' });
    const { posts } = stub([gone]);
    show('/email?folder=deleted');
    const row = await rowOf(/Old one/);
    await u.click(within(row).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete permanently?' });
    expect(dialog).toHaveTextContent('It is removed from Outlook too.');
    expect(posts).toEqual([]);
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(posts).toEqual([]);
    expect(within(region()).getByRole('link', { name: /Old one/ })).toBeInTheDocument();
    await u.click(within(row).getByRole('button', { name: 'Delete' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Delete permanently?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/mail/6/change', body: { type: 'delete' } }));
    await waitFor(() => expect(within(region()).queryByRole('link', { name: /Old one/ })).toBeNull());
  });

  it('an empty list says No lead mail matches this filter.', async () => {
    stub([]);
    show('/email?chip=unread');
    expect(await within(region()).findByText('No lead mail matches this filter.')).toBeInTheDocument();
  });
});

describe('commandState (the Email screen command rules, F10)', () => {
  const t = (p: string, v?: Record<string, string | number>) => p.replace(/\{(\w+)\}/g, (_, k) => String(v?.[k] ?? ''));
  const rules = { connected: true, canFollowUp: true };
  const state = (id: Parameters<typeof commandState>[0], target: Parameters<typeof commandState>[1], r = rules) => commandState(id, target, r, t);

  it('no target: only New mail', () => {
    expect(state('new', null).enabled).toBe(true);
    expect(state('delete', null).enabled).toBe(false);
  });
  it('a draft: only Delete', () => {
    const d = rowTarget(item({ status: 'draft', leadId: 5 }));
    expect(state('delete', d).enabled).toBe(true);
    for (const id of ['archive', 'reply', 'flag', 'log', 'link'] as const) expect(state(id, d).enabled).toBe(false);
  });
  it('queued or sending: mailbox commands disabled with Still sending; CRM commands stay', () => {
    const s = rowTarget(item({ status: 'sending', leadId: 5 }));
    expect(state('archive', s)).toEqual({ enabled: false, title: 'Still sending' });
    expect(state('log', s).enabled).toBe(true);
  });
  it('a multi-selection: Delete, Archive, Move, Flag and Mark as read only', () => {
    const sel = selectionTarget([item({ id: 1, leadId: 5 }), item({ id: 2, isRead: false })]);
    expect(sel.ids).toEqual([1, 2]);
    for (const id of ['delete', 'archive', 'move', 'flag'] as const) expect(state(id, sel).enabled).toBe(true);
    expect(state('toggleRead', sel)).toEqual({ enabled: true, label: 'Mark as read' });
    for (const id of ['reply', 'log', 'link', 'openLead'] as const) expect(state(id, sel).enabled).toBe(false);
  });
  it('view only: mailbox commands and Link to lead disabled with the title, also in a selection', () => {
    const theirs = item({ id: 2, viewOnly: true, owner: { id: 9, name: 'Carlos Torres' }, leadId: 5 });
    expect(state('link', rowTarget(theirs))).toEqual({ enabled: false, title: "View only — Carlos's mailbox" });
    expect(state('task', rowTarget(theirs)).enabled).toBe(true);
    expect(state('archive', selectionTarget([item(), theirs])).title).toBe("View only — Carlos's mailbox");
  });
  it('Follow-up needs manage_leads; toggleRead is labelled for what it does; not connected disables mailbox commands', () => {
    const linked = rowTarget(item({ leadId: 5 }));
    expect(state('followUp', linked).enabled).toBe(true);
    expect(state('followUp', linked, { connected: true, canFollowUp: false }).enabled).toBe(false);
    expect(state('toggleRead', linked).label).toBe('Mark as unread');
    expect(state('toggleRead', rowTarget(item({ isRead: false }))).label).toBe('Mark as read');
    expect(state('reply', linked, { connected: false, canFollowUp: true })).toEqual({ enabled: false, title: 'Mailbox not connected' });
  });
});
