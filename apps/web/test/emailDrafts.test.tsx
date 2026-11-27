import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { DraftView } from '../src/api/drafts';
import type { MailDetail, MailItem, MailMeta } from '../src/api/mail';
import type { Me } from '../src/api/queries';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { UndoSendProvider } from '../src/components/send/UndoSend';
import { ToastProvider } from '../src/components/Toast';
import { I18nProvider } from '../src/i18n';
import { EmailPage } from '../src/pages/email/EmailPage';
import { draftApi, draftView } from './draftFixture';
import { makeClient, rep } from './leadFixture';

beforeEach(() => {
  // Only the clock: "Mon 30 Nov" is this year's (no year shown), whatever day the tests run.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-28T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const me: Me = { ...rep, timezone: 'Europe/London', rights: [...rep.rights, 'use_email' as const, 'view_all_leads' as const] };
const admin: Me = { ...me, id: 1, name: 'Maya Iyer', role: 'Administrator', rights: [...me.rights, 'view_team_mail' as const] };

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, owner: { id: 2, name: 'Arjun Mehta' }, viewOnly: false, leadRestricted: false, folder: 'inbox', status: 'received',
  fromAddress: 'maria@acme.com', fromName: 'Maria Gómez', toAddresses: ['arjun@daitpartners.com'], subject: 'Proposal', preview: 'Please find attached',
  occurredAt: '2026-11-22T14:05:00.000Z', isRead: true, leadId: 5, leadNumber: 'LD-1178', companyId: 4, hasAttachments: false, projectId: null,
  projectNumber: null, flagStatus: 'notFlagged', flagDue: null, replied: false, conversationCount: 1, leadStatus: 'Contacted', scheduledAt: null, ...over,
});
type ThreadEntry = MailDetail['thread'][number];
const entry = (m: MailItem, over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id: m.id, occurredAt: m.occurredAt, direction: m.status === 'received' ? 'in' : 'out', who: '', subject: m.subject, kind: 'received', by: null,
  unmatched: false, fromName: m.fromName, fromAddress: m.fromAddress, toAddresses: m.toAddresses, ccAddresses: [], preview: m.preview,
  hasAttachments: false, folder: m.folder, isRead: true, ...over,
});
const detail = (m: MailItem, over: Partial<MailDetail> = {}): MailDetail => ({
  ...m, replyToId: null, lastError: null, ccAddresses: [], bodyText: m.preview, bodyHtml: null, attachmentNames: [], loggedAt: null,
  lead: { id: 5, number: 'LD-1178', status: 'Contacted', priority: 'High', nextFollowUp: null, companyId: 4 },
  contact: null, company: { id: 4, name: 'Acme Logistics' }, restrictedLead: null, leadPanel: null, thread: [], ...over,
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T14:00:00.000Z' },
  unread: 0, counts: { inbox: 0, drafts: 2, scheduled: 1, flagged: 0, awaiting: 0, due: 0, leads: 1 },
  companies: [], leads: [], projects: [], mailUsers: [{ id: 9, name: 'Carlos Torres' }], leadOwners: [],
};

/** Maria's message (1), the scheduled reply to it (60, Mon 30 Nov 08:00 London), a draft reply (70), a new-message draft (71). */
const original = item();
const own = { fromAddress: 'arjun@daitpartners.com', fromName: 'Arjun Mehta', toAddresses: ['maria@acme.com'], folder: 'drafts' } satisfies Partial<MailItem>;
const scheduled = item({ id: 60, ...own, status: 'queued', subject: 'Re: Proposal', preview: 'Thursday works', scheduledAt: '2026-11-30T08:00:00.000Z' });
const replyDraft = item({ id: 70, ...own, status: 'draft', subject: 'Re: Proposal', preview: 'Dear Maria' });
const newDraft = item({ id: 71, ...own, status: 'draft', subject: 'Intro', preview: 'Hello Ana', toAddresses: ['ana@acme.com'], occurredAt: '2026-11-21T10:00:00.000Z' });
const DETAILS: Record<number, MailDetail> = {
  1: detail(original, { thread: [entry(original)] }),
  60: detail(scheduled, { replyToId: 1, thread: [entry(scheduled, { kind: 'sent' }), entry(original)] }),
  70: detail(replyDraft, { replyToId: 1, thread: [entry(replyDraft, { kind: 'draft' }), entry(original)] }),
  71: detail(newDraft),
};
const DRAFTS: Record<number, DraftView> = {
  60: draftView({ id: 60, replyToId: 1, subject: 'Re: Proposal' }),
  70: draftView({ id: 70, replyToId: 1, subject: 'Re: Proposal' }),
  71: draftView({ id: 71, replyToId: null, subject: 'Intro', quotedHtml: null }),
};

function stub(opts: { items?: MailItem[]; details?: Record<number, MailDetail>; drafts?: Record<number, DraftView>; user?: Me } = {}) {
  const items = opts.items ?? [scheduled];
  const details = opts.details ?? DETAILS;
  const drafts = draftApi({ drafts: opts.drafts ?? DRAFTS });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const unsend = /^\/api\/mail\/(\d+)\/unsend$/.exec(url);
    if (unsend) {
      drafts.calls.push({ url, method, body: undefined });
      return Response.json(drafts.drafts[Number(unsend[1])]);
    }
    if (/^\/api\/mail\/\d+\/send-now$/.test(url)) {
      drafts.calls.push({ url, method, body: undefined });
      return new Response(null, { status: 204 });
    }
    const handled = drafts.handle(url, init);
    if (handled) return handled;
    if (url === '/api/me') return Response.json(opts.user ?? me);
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (url.startsWith('/api/mail/meta')) return Response.json(META);
    if (url === '/api/email-templates') return Response.json({ items: [] });
    if (url === '/api/users') return Response.json({ items: [] });
    const m = /^\/api\/mail\/(\d+)(\?peek=1)?$/.exec(url);
    if (m) return Response.json(details[Number(m[1])]);
    return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
  }));
  return drafts;
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function show(path: string, user: Me = me) {
  return render(
    <QueryClientProvider client={makeClient(user)}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <UndoSendProvider>
              <MemoryRouter initialEntries={[path]}>
                <Routes>
                  <Route path="/email" element={<EmailPage />} />
                  <Route path="/email/new" element={<p>New message page</p>} />
                  <Route path="/email/:id" element={<EmailPage />} />
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

const pane = () => screen.findByRole('region', { name: 'Reading pane' });
const where = () => screen.getByTestId('where');

describe('Drafts and Scheduled folders (web-mail release 3, Task 14)', () => {
  it('a scheduled message shows Scheduled · Mon 30 Nov, 08:00 and the banner with Edit, Send now, Cancel', async () => {
    stub();
    show('/email/60?folder=scheduled');
    const row = (await screen.findByRole('link', { name: /Re: Proposal/ })).closest('.mrow') as HTMLElement;
    expect(within(row).getByText('Scheduled · Mon 30 Nov, 08:00')).toBeInTheDocument();
    const p = await pane();
    const banner = await within(p).findByRole('status', { name: 'Scheduled send' });
    expect(banner).toHaveTextContent('Scheduled for Mon 30 Nov 2026, 08:00');
    for (const name of ['Edit', 'Send now', 'Cancel']) expect(within(banner).getByRole('button', { name })).toBeEnabled();
    // The same three in the row's right-click menu.
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    for (const name of ['Edit', 'Send now', 'Cancel']) expect(within(menu).getByRole('menuitem', { name })).toBeEnabled();
  });

  it('Cancel moves it to Drafts; Send now posts send-now; Edit opens the editor on the returned draft', async () => {
    const user = userEvent.setup();
    let api = stub();
    const view = show('/email/60?folder=scheduled');
    let banner = await within(await pane()).findByRole('status', { name: 'Scheduled send' });
    await user.click(within(banner).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Moved to Drafts')).toBeInTheDocument();
    expect(api.of('/api/mail/60/unsend', 'POST')).toHaveLength(1);
    view.unmount();

    api = stub();
    const again = show('/email/60?folder=scheduled');
    banner = await within(await pane()).findByRole('status', { name: 'Scheduled send' });
    await user.click(within(banner).getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
    expect(api.of('/api/mail/60/send-now', 'POST')).toHaveLength(1);
    expect(api.of('/api/mail/60/unsend')).toHaveLength(0);
    again.unmount();

    // Edit on a scheduled reply: back to Drafts, then the inline editor in its conversation.
    api = stub();
    const third = show('/email/60?folder=scheduled');
    banner = await within(await pane()).findByRole('status', { name: 'Scheduled send' });
    await user.click(within(banner).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(where()).toHaveTextContent('/email/60?folder=drafts'));
    expect(api.of('/api/mail/60/unsend', 'POST')).toHaveLength(1);
    expect(await within(await pane()).findByRole('form', { name: 'Reply' })).toBeInTheDocument();
    third.unmount();

    // Edit on a scheduled new message: the full page.
    const newScheduled = item({ ...scheduled, id: 71, subject: 'Intro' });
    api = stub({ items: [newScheduled], details: { ...DETAILS, 71: detail(newScheduled) } });
    show('/email/71?folder=scheduled');
    banner = await within(await pane()).findByRole('status', { name: 'Scheduled send' });
    await user.click(within(banner).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(where()).toHaveTextContent('/email/new?draft=71'));
    expect(api.of('/api/mail/71/unsend', 'POST')).toHaveLength(1);
  });

  it('a draft reply opens its conversation with the inline editor; a new-message draft opens the full page', async () => {
    const user = userEvent.setup();
    const api = stub({ items: [replyDraft, newDraft] });
    show('/email?folder=drafts');
    // Shown on arrival (not opened): the draft with Continue editing, no editor yet; the release 2 note is gone.
    expect(await screen.findByRole('button', { name: 'Continue editing' })).toBeInTheDocument();
    expect(within(await pane()).queryByRole('form')).toBeNull();
    expect(screen.queryByText('Drafts are edited in Outlook.')).toBeNull();

    await user.click(screen.getByRole('link', { name: /Re: Proposal/ }));
    const form = await within(await pane()).findByRole('form', { name: 'Reply' });
    await waitFor(() => expect(api.of('/api/mail/drafts/70', 'GET')).toHaveLength(1));
    expect(api.of('/api/mail/drafts', 'POST')).toHaveLength(0);
    // Its own row is not shown twice: the editor stands for it; the original stays in the conversation.
    expect(within(await pane()).queryByRole('button', { name: 'Continue editing' })).toBeNull();
    expect(within(await pane()).getByRole('button', { name: /Maria Gómez.*Please find attached/ })).toHaveAttribute('aria-expanded', 'false');
    expect(form).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /Intro/ }));
    await waitFor(() => expect(where()).toHaveTextContent('/email/new?draft=71'));
    expect(screen.getByText('New message page')).toBeInTheDocument();
  });

  it('a failed send in Drafts shows Not sent with the reason', async () => {
    const failed = item({ ...replyDraft, status: 'failed' });
    stub({
      items: [failed],
      details: { ...DETAILS, 70: detail(failed, { replyToId: 1, lastError: 'draft_gone', thread: [entry(failed, { kind: 'draft' }), entry(original)] }) },
      drafts: { ...DRAFTS, 70: draftView({ id: 70, replyToId: 1, status: 'failed', lastError: 'draft_gone' }) },
    });
    show('/email/70?folder=drafts');
    const form = await within(await pane()).findByRole('form', { name: 'Reply' });
    expect(await within(form).findByText('Not sent: This draft was removed in Outlook.')).toBeInTheDocument();
    // A Failed send in Drafts is a draft: the command bar cannot reply to it.
    expect(within(screen.getByRole('toolbar', { name: 'Mail commands' })).getByRole('button', { name: 'Reply' })).toBeDisabled();
  });

  it("another user's scheduled mail: Edit, Send now and Cancel disabled with the view-only title", async () => {
    const theirs = item({ ...scheduled, owner: { id: 9, name: 'Carlos Torres' }, viewOnly: true });
    const api = stub({ items: [theirs], details: { 60: detail(theirs, { thread: [] }) }, user: admin });
    show('/email/60?folder=scheduled&mailof=9', admin);
    const banner = await within(await pane()).findByRole('status', { name: 'Scheduled send' });
    for (const name of ['Edit', 'Send now', 'Cancel']) {
      const b = within(banner).getByRole('button', { name });
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', "View only — Carlos's mailbox");
    }
    fireEvent.contextMenu((screen.getByRole('link', { name: /Re: Proposal/ }).closest('.mrow') as HTMLElement));
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Send now' })).toBeDisabled();
    expect(api.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
