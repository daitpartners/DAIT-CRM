import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import type { MailDetail, MailItem, MailMeta } from '../src/api/mail';
import type { Me } from '../src/api/queries';
import type { EmailTemplate } from '../src/api/templates';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import { shortcutFor } from '../src/pages/email/useMailShortcuts';
import { makeClient, rep } from './leadFixture';

const widthGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthGetter);
});

const me: Me = { ...rep, timezone: 'Europe/London', language: 'en', rights: [...rep.rights, 'use_email' as const, 'manage_leads' as const] };
const admin: Me = { ...me, id: 1, name: 'Maya Iyer', role: 'Administrator', rights: [...me.rights, 'view_team_mail' as const] };

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, owner: { id: 2, name: 'Arjun Mehta' }, viewOnly: false, leadRestricted: false, folder: 'inbox', status: 'received', fromAddress: 'ana@acme.com',
  fromName: 'Ana Ruiz', toAddresses: ['arjun@daitpartners.com', 'tom@acme.com'], subject: 'Proposal', preview: 'Looks good',
  occurredAt: '2026-11-26T10:00:00.000Z', isRead: true, leadId: 5, leadNumber: 'LD-1204', companyId: 4, hasAttachments: false, projectId: null,
  projectNumber: null, flagStatus: 'notFlagged', flagDue: null, replied: false, conversationCount: 1, leadStatus: 'Proposal', ...over,
});
const detail = (m: MailItem): MailDetail => ({
  ...m, ccAddresses: ['li@acme.com', 'arjun@daitpartners.com'], bodyText: 'Looks good', bodyHtml: null, attachmentNames: [], loggedAt: null, lead: null,
  contact: null, company: null, restrictedLead: null, leadPanel: null, thread: [],
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-26T09:00:00.000Z' },
  unread: 0, counts: { inbox: 0, drafts: 0, scheduled: 0, flagged: 0, awaiting: 0, due: 0, leads: 1 },
  companies: [], leads: [], projects: [], mailUsers: [{ id: 9, name: 'Carlos Torres' }], leadOwners: [],
};
const template = (over: Partial<EmailTemplate>): EmailTemplate => ({
  id: 1, name: 'Intro', language: 'en', subject: 'Hello from {me}', body: 'Hi {first_name},', bodyHtml: null, sourceType: 'manual', fileName: null,
  fileSize: null, attachments: [], createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});

/** Serves the list, messages, templates and lead searches; records every POST. */
function stub(items: MailItem[], opts: { user?: Me; templates?: EmailTemplate[] } = {}) {
  const posts: { url: string; body: unknown }[] = [];
  const leadSearches: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      const one = /^\/api\/mail\/(\d+)\/change$/.exec(url);
      if (one) {
        const m = items.find((x) => x.id === Number(one[1]))!;
        return Response.json({
          id: m.id, removed: false, folder: body.type === 'move' ? body.folder : body.type === 'delete' ? 'deleted' : m.folder,
          isRead: body.type === 'read' ? body.isRead : m.isRead, flagStatus: body.type === 'flag' ? 'flagged' : m.flagStatus, flagDue: null,
        });
      }
      if (url.endsWith('/follow-up')) return Response.json({ leadId: 5, nextFollowUp: body.date ?? null, taskId: 3 });
      if (url.endsWith('/unlink')) return Response.json({ id: 1, leadId: null });
      return Response.json({ id: 1, leadId: 5 });
    }
    if (url === '/api/me') return Response.json(opts.user ?? me);
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (url.startsWith('/api/mail/meta')) return Response.json(META);
    if (url === '/api/email-templates') return Response.json({ items: opts.templates ?? [] });
    if (/^\/api\/mail\/\d+\/lead-suggestions$/.test(url)) {
      return Response.json({ items: [{ id: 6, number: 'LD-1178', companyName: 'Acme Logistics', status: 'Contacted' }] });
    }
    if (url.startsWith('/api/leads?')) {
      leadSearches.push(url);
      return Response.json({ items: [{ id: 8, number: 'LD-1300', companyName: 'Orbit Labs', status: 'New', archivedAt: null }], total: 1, page: 1, pageSize: 8 });
    }
    const m = /^\/api\/mail\/(\d+)(\?peek=1)?$/.exec(url);
    if (m) return Response.json(detail(items.find((x) => x.id === Number(m[1])) ?? item({ id: Number(m[1]) })));
    return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
  }));
  return { posts, leadSearches };
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function show(path = '/email/1', user: Me = me) {
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

const bar = () => screen.getByRole('toolbar', { name: 'Mail commands' });
const cmd = (name: string) => within(bar()).getByRole('button', { name });
const where = () => screen.getByTestId('where').textContent;
/** The open message is loaded (the reading pane's copy), so the bar acts on it. */
const ready = async (subject = 'Proposal') => {
  await screen.findByRole('heading', { name: subject, level: 2 }).catch(() => undefined);
  await waitFor(() => expect(cmd('Reply')).toBeEnabled());
};

describe('Email command bar, menus and shortcuts (web-mail release 2, Task 14)', () => {
  it('New mail ▾ lists the real templates (your language first) and Manage templates…', async () => {
    const user = userEvent.setup();
    stub([item()], { templates: [template({ id: 2, name: 'Intro ES', language: 'es' }), template({ id: 1, name: 'Intro' })] });
    show();
    await user.click(await screen.findByRole('button', { name: 'More new mail options' }));
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New mail', 'Intro', 'Intro ES', 'Manage templates…']));
    expect(within(menu).getByText('New from template')).toBeInTheDocument();
    // A template opens Compose filled the way release 1's folder template list did.
    await user.click(within(menu).getByRole('menuitem', { name: 'Intro' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    expect(within(dialog).getByLabelText('Subject')).toHaveValue(`Hello from ${me.name}`);
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await user.click(screen.getByRole('button', { name: 'More new mail options' }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Manage templates…' }));
    expect(where()).toBe('/settings/templates');
  });

  it('New mail opens Compose with the link’s client; an .oft template is marked', async () => {
    const user = userEvent.setup();
    stub([item()], { templates: [template({ id: 3, name: 'Brochure', sourceType: 'oft' })] });
    show('/email?company=4');
    await user.click(await screen.findByRole('button', { name: 'New mail' }));
    expect(await screen.findByRole('dialog', { name: 'Compose email' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.click(screen.getByRole('button', { name: 'More new mail options' }));
    expect(await within(screen.getByRole('menu')).findByRole('menuitem', { name: /Brochure/ })).toHaveTextContent('Brochure.oft');
  });

  it('Flag ▾ Tomorrow posts flag tomorrow; Move to ▾ Deleted items posts move deleted', async () => {
    const user = userEvent.setup();
    const { posts } = stub([item()]);
    show();
    await ready();
    await user.click(cmd('Flag'));
    await user.click(within(screen.getByRole('menu', { name: 'Flag' })).getByRole('menuitem', { name: /^Tomorrow/ }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/change', body: { type: 'flag', flag: 'tomorrow' } }));
    await user.click(cmd('Move to'));
    await user.click(within(screen.getByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Deleted items' }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/change', body: { type: 'move', folder: 'deleted' } }));
  });

  it("view only: Delete, Archive, Move, Reply, Reply all, Forward, Flag, Mark as unread and Link to lead disabled with the title; Follow-up, Log, Create task, Schedule meeting enabled", async () => {
    const user = userEvent.setup();
    const theirs = item({ viewOnly: true, owner: { id: 9, name: 'Carlos Torres' } });
    const { posts } = stub([theirs], { user: admin });
    show('/email/1?mailof=9', admin);
    await waitFor(() => expect(cmd('Log as activity')).toBeEnabled());
    for (const name of ['Delete', 'Archive', 'Move to', 'Reply', 'Reply all', 'Forward', 'Flag', 'Mark as unread', 'Link to lead']) {
      expect(cmd(name)).toBeDisabled();
      expect(cmd(name)).toHaveAttribute('title', "View only — Carlos's mailbox");
    }
    expect(screen.getByRole('button', { name: 'Reply all' })).toHaveAttribute('title', "View only — Carlos's mailbox");
    for (const name of ['Follow-up', 'Log as activity', 'Create task', 'Schedule meeting']) expect(cmd(name)).toBeEnabled();
    // Shortcuts go through the same rules: nothing changes in another user's mailbox.
    await user.keyboard('e{Delete}{Control>}u{/Control}');
    expect(posts).toEqual([]);
  });

  it('Follow-up ▾ at 14:30: Later today 17:00 … posts date and time; Clear follow-up posts clear; Choose date and time…', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T14:30:00.000Z'));
    const user = userEvent.setup();
    const { posts } = stub([item()]);
    show();
    await ready();
    expect(cmd('Follow-up')).toHaveAttribute('title', "Set the lead's next follow-up date (CRM)");
    await user.click(cmd('Follow-up'));
    let menu = screen.getByRole('menu', { name: 'Follow-up' });
    expect(within(menu).getByText('Lead follow-up · LD-1204')).toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Later today26 Nov, 17:00', 'Tomorrow27 Nov, 09:00', 'Next week30 Nov, 09:00', 'In 2 weeks10 Dec, 09:00', 'Choose date and time…', 'Clear follow-up',
    ]);
    expect(within(menu).getByText("Sets the lead's next follow-up and adds it to Tasks. Replaces Outlook's Snooze.")).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /^Later today/ }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/follow-up', body: { date: '2026-11-26', time: '17:00' } }));
    expect(await screen.findByText('Follow-up set for 26 Nov, 17:00')).toBeInTheDocument();

    await user.click(cmd('Follow-up'));
    await user.click(within(screen.getByRole('menu', { name: 'Follow-up' })).getByRole('menuitem', { name: 'Clear follow-up' }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/follow-up', body: { clear: true } }));

    await user.click(cmd('Follow-up'));
    menu = screen.getByRole('menu', { name: 'Follow-up' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Choose date and time…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose date and time' });
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-11-27');
    expect(within(dialog).getByLabelText('Time')).toHaveValue('09:00');
    await user.clear(within(dialog).getByLabelText('Date'));
    await user.type(within(dialog).getByLabelText('Date'), '2026-12-03');
    await user.clear(within(dialog).getByLabelText('Time'));
    await user.type(within(dialog).getByLabelText('Time'), '10:30');
    await user.click(within(dialog).getByRole('button', { name: 'Set follow-up' }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/follow-up', body: { date: '2026-12-03', time: '10:30' } }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Link to lead ▾: suggestions from the address link the message; a search finds leads; Unlink posts unlink', async () => {
    const user = userEvent.setup();
    const { posts, leadSearches } = stub([item({ leadId: null, leadNumber: null, leadStatus: null })]);
    show();
    await waitFor(() => expect(cmd('Link to lead')).toBeEnabled());
    await user.click(cmd('Link to lead'));
    let menu = screen.getByRole('menu', { name: 'Link to lead' });
    expect(within(menu).getByRole('searchbox', { name: 'Search leads by LD number or company' })).toHaveFocus();
    expect(within(menu).getByText('Suggested from the address')).toBeInTheDocument();
    const suggestion = await within(menu).findByRole('menuitem', { name: /LD-1178 · Acme Logistics/ });
    expect(suggestion).toHaveTextContent('Contacted');
    // Not linked: no Unlink.
    expect(within(menu).queryByRole('menuitem', { name: 'Unlink' })).toBeNull();
    await user.click(suggestion);
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/link', body: { leadId: 6 } }));
    expect(await screen.findByText('Linked to LD-1178')).toBeInTheDocument();

    await user.click(cmd('Link to lead'));
    menu = screen.getByRole('menu', { name: 'Link to lead' });
    await user.type(within(menu).getByRole('searchbox'), 'orbit');
    await within(menu).findByRole('menuitem', { name: /LD-1300 · Orbit Labs/ }, { timeout: 2000 });
    expect(leadSearches.some((u) => new URL(u, 'http://x').searchParams.get('q') === 'orbit')).toBe(true);
    // Create lead from this email… opens the existing Link email to a lead window.
    await user.click(within(menu).getByRole('menuitem', { name: 'Create lead from this email…' }));
    expect(await screen.findByRole('dialog', { name: 'Link email to a lead' })).toBeInTheDocument();
  });

  it('Unlink (a linked message) posts unlink', async () => {
    const user = userEvent.setup();
    const { posts } = stub([item()]);
    show();
    await ready();
    await user.click(cmd('Link to lead'));
    await user.click(within(screen.getByRole('menu', { name: 'Link to lead' })).getByRole('menuitem', { name: 'Unlink' }));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/unlink', body: undefined }));
    expect(await screen.findByText('Unlinked from LD-1204')).toBeInTheDocument();
  });

  it('Reply all and Forward open Compose with the computed To/Cc and subject', async () => {
    const user = userEvent.setup();
    stub([item()]);
    show();
    await ready();
    await user.click(cmd('Reply all'));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('To')).toHaveValue('ana@acme.com, tom@acme.com');
    expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('li@acme.com');
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Re: Proposal');
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await user.click(cmd('Forward'));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('To')).toHaveValue('');
    expect(within(dialog).getByLabelText('Subject')).toHaveValue('Fw: Proposal');
  });

  it('Schedule meeting opens the calendar for the lead; Log as activity posts log', async () => {
    const user = userEvent.setup();
    const { posts } = stub([item()]);
    show();
    await ready();
    await user.click(cmd('Log as activity'));
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/log', body: undefined }));
    await user.click(cmd('Schedule meeting'));
    expect(where()).toBe('/calendar?new=1&lead=5');
  });

  it('shortcuts: E archives, Ctrl+U marks unread, Shift+R opens Reply all, N opens New mail, Delete deletes', async () => {
    const user = userEvent.setup();
    const { posts } = stub([item(), item({ id: 2, subject: 'Second', occurredAt: '2026-11-25T10:00:00.000Z' })]);
    show();
    await ready();
    await user.keyboard('{Control>}u{/Control}');
    await waitFor(() => expect(posts).toEqual([{ url: '/api/mail/1/change', body: { type: 'read', isRead: false } }]));
    await user.keyboard('{Shift>}R{/Shift}');
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('li@acme.com');
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await user.keyboard('n');
    dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await user.keyboard('e');
    await waitFor(() => expect(posts).toContainEqual({ url: '/api/mail/1/change', body: { type: 'move', folder: 'archive' } }));
    await waitFor(() => expect(cmd('Delete')).toBeEnabled());
    await user.keyboard('{Delete}');
    await waitFor(() => expect(posts.filter((p) => (p.body as { type?: string })?.type === 'delete')).toHaveLength(1));
  });

  it('shortcuts never fire while typing in the search box, a filter field, the Link search or Compose (Review Focus 4)', async () => {
    const user = userEvent.setup();
    const { posts } = stub([item()]);
    show();
    await ready();
    // The search box last: what it types may narrow the list away from the open message.
    const contexts: [string, () => Promise<HTMLElement>, number][] = [
      ['Link search', async () => {
        await user.click(cmd('Link to lead'));
        return within(screen.getByRole('menu', { name: 'Link to lead' })).getByRole('searchbox');
      }, 0],
      ['Compose', async () => {
        await user.click(cmd('Reply'));
        return within(await screen.findByRole('dialog')).getByLabelText('Message');
      }, 1],
      ['filter field', async () => {
        await user.click(screen.getByRole('button', { name: /Filters/ }));
        return within(screen.getByRole('group', { name: 'Search filters' })).getByLabelText('Subject');
      }, 0],
      ['search box', async () => screen.getByRole('searchbox', { name: 'Search lead mail' }), 0],
    ];
    for (const [where, open, dialogs] of contexts) {
      const field = await open();
      await user.click(field);
      await user.type(field, 'ern{Delete}');
      expect(posts, where).toEqual([]);
      expect(screen.queryAllByRole('dialog'), where).toHaveLength(dialogs);
      await user.keyboard('{Escape}');
    }
  });

  it('shortcutFor maps the keys (letters with Ctrl/⌘/Alt stay the browser’s)', () => {
    const k = (key: string, more: Partial<KeyboardEvent> = {}) => shortcutFor({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more });
    expect([k('Delete'), k('e'), k('r'), k('R', { shiftKey: true }), k('f'), k('n'), k('u', { metaKey: true }), k('u', { ctrlKey: true })])
      .toEqual(['delete', 'archive', 'reply', 'replyAll', 'forward', 'new', 'toggleRead', 'toggleRead']);
    expect([k('r', { metaKey: true }), k('e', { ctrlKey: true }), k('u'), k('x'), k('N', { shiftKey: true })]).toEqual([null, null, null, null, null]);
  });

  it('overflow: with little room the tail commands move into … and the labels become icons with titles', async () => {
    // 400 px beside "…" (32 px): labelled commands 90 px, icon-only 34 px, separators 1 px.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('cmd-row')) return 432;
        if (this.classList.contains('cmd-more')) return 32;
        if (this.classList.contains('cmd-sep')) return 1;
        if (this.classList.contains('cmd')) return this.closest('.compact') && this.hasAttribute('data-short') ? 34 : 90;
        return 0;
      },
    });
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) { observers.push(cb); }
      observe() {}
      disconnect() {}
    });
    const user = userEvent.setup();
    stub([item()]);
    show();
    await ready();
    await waitFor(() => expect(within(bar()).queryByRole('button', { name: 'Schedule meeting' })).toBeNull());
    expect(document.querySelector('.wm-cmdbar')).toHaveClass('compact');
    expect(cmd('Delete')).toHaveAttribute('title', 'Delete');
    expect(cmd('Reply all')).toHaveAttribute('title', 'Reply all');
    expect(cmd('Reply')).not.toHaveAttribute('title');
    for (const name of ['Follow-up', 'Link to lead', 'Log as activity', 'Create task']) expect(within(bar()).queryByRole('button', { name })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More commands' }));
    const menu = screen.getByRole('menu', { name: 'More commands' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Follow-up', 'Link to lead', 'Log as activity', 'Create task', 'Schedule meeting', 'Mark as read', 'Open lead',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'Schedule meeting' }));
    expect(where()).toBe('/calendar?new=1&lead=5');
    expect(observers.length).toBeGreaterThan(0);
  });

  it('View tab: Conversation view, Sort by ▾, Folder pane and Lead panel', async () => {
    const user = userEvent.setup();
    stub([item()]);
    show();
    await user.click(await screen.findByRole('tab', { name: 'View' }));
    expect(screen.getByRole('tab', { name: 'View' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel');
    await user.click(within(panel).getByRole('switch', { name: 'Conversation view' }));
    expect(where()).toContain('conv=0');
    await user.click(within(panel).getByRole('button', { name: 'Sort by' }));
    await user.click(within(screen.getByRole('menu', { name: 'Sort by' })).getByRole('menuitem', { name: 'From' }));
    expect(where()).toContain('sort=from');
    const folders = within(panel).getByRole('button', { name: 'Folder pane' });
    expect(folders).toHaveAttribute('aria-pressed', 'true');
    expect(folders).toHaveAttribute('title', 'Collapse folder pane');
    await user.click(folders);
    expect(folders).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('navigation', { name: 'Mail folders' })).toHaveClass('collapsed');
    expect(within(panel).getByRole('button', { name: 'Lead panel' })).toHaveAttribute('aria-pressed');
  });
});
