import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  attachmentUrl, useBulkMailChange, useMailChange, useMailList, useMailMessage, useReplyMail,
  type MailChange, type MailDetail, type MailFilter, type MailItem,
} from '../src/api/mail';
import type { Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { I18nProvider } from '../src/i18n';
import { replyStart } from '../src/pages/email/replyStart';
import es from '../src/locales/es.json';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
});

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, owner: { id: 2, name: 'Arjun Mehta' }, viewOnly: false, leadRestricted: false, folder: 'inbox', status: 'received', fromAddress: 'ana@acme.com',
  fromName: 'Ana Ruiz', toAddresses: ['arjun@daitpartners.com'], subject: 'Proposal', preview: 'Looks good', occurredAt: '2026-11-20T10:00:00.000Z',
  isRead: false, leadId: null, leadNumber: null, companyId: null, hasAttachments: false, projectId: null, projectNumber: null,
  flagStatus: 'notFlagged', flagDue: null, replied: false, conversationCount: 1, leadStatus: null, scheduledAt: null, ...over,
});

type Answer = { status: number; body: unknown };
/** A POST answer the test releases when it wants (to see the screen before the server answers). */
function later() {
  let release!: (a: Answer) => void;
  const answer = new Promise<Answer>((r) => {
    release = r;
  });
  return { answer, release };
}

function stub(items: MailItem[], post: (url: string, body: unknown) => Promise<Answer> | Answer, detail?: MailDetail, me: Me = rep) {
  const posts: { url: string; body: unknown }[] = [];
  const gets: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      const a = await post(url, body);
      return Response.json(a.body, { status: a.status });
    }
    if (url === '/api/me') return Response.json(me);
    gets.push(url);
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (detail && url.startsWith(`/api/mail/${detail.id}`)) return Response.json(detail);
    return Response.json({});
  }));
  return { posts, gets };
}

function List({ filter = { view: 'inbox' }, change, bulk }: { filter?: MailFilter; change?: { id: number; change: MailChange }; bulk?: { ids: number[]; change: MailChange } }) {
  const list = useMailList(filter);
  const one = useMailChange();
  const many = useBulkMailChange();
  return (
    <div>
      <ul aria-label="rows">
        {list.items.map((m) => (
          <li key={m.id}>{`${m.subject}${m.isRead ? '' : ' (unread)'}${m.flagStatus === 'flagged' ? ` (flag ${m.flagDue ?? 'no date'})` : ''}`}</li>
        ))}
      </ul>
      {change ? <button type="button" onClick={() => one.mutate(change)}>Change</button> : null}
      {bulk ? <button type="button" onClick={() => many.mutate(bulk)}>Change all</button> : null}
    </div>
  );
}

function show(ui: React.ReactNode, me = rep) {
  const qc = makeClient(me);
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const rows = () => within(screen.getByRole('list', { name: 'rows' })).queryAllByRole('listitem').map((li) => li.textContent);

describe('useMailChange (web-mail release 2)', () => {
  it('useMailChange moves the row out of Inbox at once and puts it back with a toast when Outlook refuses (Review Focus 1)', async () => {
    const reply = later();
    const { posts } = stub([item({ id: 1, subject: 'First' }), item({ id: 2, subject: 'Second' }), item({ id: 3, subject: 'Third' })], () => reply.answer);
    show(<List change={{ id: 2, change: { type: 'move', folder: 'archive' } }} />);
    await screen.findByText('Second (unread)');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    // Gone at once, before Outlook answers.
    await waitFor(() => expect(rows()).toEqual(['First (unread)', 'Third (unread)']));
    expect(posts).toEqual([{ url: '/api/mail/2/change', body: { type: 'move', folder: 'archive' } }]);
    await act(async () => reply.release({ status: 502, body: { error: 'outlook_refused' } }));
    // Back where it was, with the reason.
    await waitFor(() => expect(rows()).toEqual(['First (unread)', 'Second (unread)', 'Third (unread)']));
    expect(screen.getByText('Outlook refused the change. Nothing was changed.')).toBeInTheDocument();
  });

  it('busy, disconnected and view only answers each toast their own reason, in the user’s language', async () => {
    for (const [status, error, text] of [
      [503, 'outlook_busy', 'Outlook está ocupado. Vuelva a intentarlo en un momento.'],
      [409, 'mailbox_not_connected', 'Su buzón necesita reconectarse en Ajustes.'],
      [403, 'view_only', es['View only: only the mailbox owner can do this.']],
      [409, 'sending', 'Este correo aún se está enviando.'],
    ] as const) {
      const spanish: Me = { ...rep, language: 'es' };
      stub([item({ id: 1, subject: 'First' })], () => ({ status, body: { error } }), undefined, spanish);
      const qc = makeClient(spanish);
      const view = render(
        <QueryClientProvider client={qc}>
          <I18nProvider>
            <ToastProvider>
              <List change={{ id: 1, change: { type: 'delete' } }} />
            </ToastProvider>
          </I18nProvider>
        </QueryClientProvider>,
      );
      await screen.findByText('First (unread)');
      await userEvent.click(screen.getByRole('button', { name: 'Change' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(rows()).toEqual(['First (unread)']);
      view.unmount();
    }
  });

  it('read and flag change the row in place; the server’s answer (the flag’s due day) is kept', async () => {
    stub([item({ id: 1, subject: 'First' })], () => ({
      status: 200, body: { id: 1, folder: 'inbox', isRead: false, flagStatus: 'flagged', flagDue: '2026-11-27', removed: false },
    }));
    show(<List change={{ id: 1, change: { type: 'flag', flag: 'tomorrow' } }} />);
    await screen.findByText('First (unread)');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(await screen.findByText('First (unread) (flag 2026-11-27)')).toBeInTheDocument();
  });

  it('Delete inside Deleted items removes the row for good', async () => {
    stub([item({ id: 1, subject: 'Gone', folder: 'deleted' }), item({ id: 2, subject: 'Kept', folder: 'deleted' })], () => ({
      status: 200, body: { id: 1, folder: 'deleted', isRead: false, flagStatus: 'notFlagged', flagDue: null, removed: true },
    }));
    show(<List filter={{ view: 'deleted' }} change={{ id: 1, change: { type: 'delete' } }} />);
    await screen.findByText('Gone (unread)');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(rows()).toEqual(['Kept (unread)']));
  });

  it('marking read patches the open message and its conversation entry', async () => {
    const m = item({ id: 4, subject: 'Open one', isRead: true });
    const d = {
      ...m, ccAddresses: [], bodyText: '', bodyHtml: null, attachmentNames: [], loggedAt: null, lead: null, contact: null, company: null, restrictedLead: null, leadPanel: null,
      thread: [{
        id: 4, occurredAt: m.occurredAt, direction: 'in', who: 'Ana Ruiz', subject: 'Open one', kind: 'received', by: null, unmatched: true, fromName: 'Ana Ruiz',
        fromAddress: 'ana@acme.com', toAddresses: [], ccAddresses: [], preview: '', hasAttachments: false, folder: 'inbox', isRead: true,
      }],
    } satisfies MailDetail;
    const reply = later();
    stub([m], () => reply.answer, d);
    function Open() {
      const q = useMailMessage(4);
      const one = useMailChange();
      return (
        <div>
          <output>{q.data ? `${q.data.isRead ? 'read' : 'unread'} / ${q.data.thread[0]!.isRead ? 'read' : 'unread'}` : 'loading'}</output>
          <button type="button" onClick={() => one.mutate({ id: 4, change: { type: 'read', isRead: false } })}>Unread</button>
        </div>
      );
    }
    show(<Open />);
    expect(await screen.findByText('read / read')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unread' }));
    expect(await screen.findByText('unread / unread')).toBeInTheDocument();
    await act(async () => reply.release({ status: 503, body: { error: 'outlook_busy' } }));
    expect(await screen.findByText('read / read')).toBeInTheDocument();
  });
});

describe('useBulkMailChange', () => {
  it('moves every row at once; the ids Outlook refused come back where they were, with a count toast', async () => {
    const reply = later();
    const { posts } = stub([item({ id: 1, subject: 'A' }), item({ id: 2, subject: 'B' }), item({ id: 3, subject: 'C' }), item({ id: 4, subject: 'D' })], () => reply.answer);
    show(<List bulk={{ ids: [1, 2, 3], change: { type: 'move', folder: 'archive' } }} />);
    await screen.findByText('A (unread)');
    await userEvent.click(screen.getByRole('button', { name: 'Change all' }));
    await waitFor(() => expect(rows()).toEqual(['D (unread)']));
    expect(posts).toEqual([{ url: '/api/mail/bulk', body: { ids: [1, 2, 3], change: { type: 'move', folder: 'archive' } } }]);
    await act(async () => reply.release({
      status: 200,
      body: {
        done: [{ id: 1, folder: 'archive', isRead: false, flagStatus: 'notFlagged', flagDue: null, removed: false }],
        failed: [{ id: 2, error: 'outlook_refused' }, { id: 3, error: 'outlook_busy' }],
      },
    }));
    await waitFor(() => expect(rows()).toEqual(['B (unread)', 'C (unread)', 'D (unread)']));
    expect(screen.getByText('2 could not be changed in Outlook')).toBeInTheDocument();
  });

  it('a refused request puts every row back and toasts the reason', async () => {
    stub([item({ id: 1, subject: 'A' }), item({ id: 2, subject: 'B' })], () => ({ status: 409, body: { error: 'mailbox_not_connected' } }));
    show(<List bulk={{ ids: [1, 2], change: { type: 'read', isRead: true } }} />);
    await screen.findByText('A (unread)');
    await userEvent.click(screen.getByRole('button', { name: 'Change all' }));
    expect(await screen.findByText('Your mailbox needs reconnecting in Settings.')).toBeInTheDocument();
    expect(rows()).toEqual(['A (unread)', 'B (unread)']);
  });
});

describe('list filters and attachment links', () => {
  it('sends only the filters that are set; conversation view off is conv=0', async () => {
    const { gets } = stub([], () => ({ status: 200, body: {} }));
    show(<List filter={{ view: 'flagged', chip: 'unread', conv: false, sort: 'from', dir: 'asc', from: 'ana', owner: 'me', date: '7d', attachments: true }} />);
    await waitFor(() => expect(gets.some((u) => u.startsWith('/api/mail?'))).toBe(true));
    const q = new URL(gets.find((u) => u.startsWith('/api/mail?'))!, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toEqual({
      view: 'flagged', chip: 'unread', conv: '0', sort: 'from', dir: 'asc', from: 'ana', owner: 'me', date: '7d', attachments: '1', pageSize: '50',
    });
  });

  it('conversation view on (the default) sends no conv; empty texts are not sent', async () => {
    const { gets } = stub([], () => ({ status: 200, body: {} }));
    show(<List filter={{ view: 'inbox', conv: true, from: '', attachments: false }} />);
    await waitFor(() => expect(gets.some((u) => u.startsWith('/api/mail?'))).toBe(true));
    expect(Object.fromEntries(new URL(gets[0]!, 'http://x').searchParams)).toEqual({ view: 'inbox', pageSize: '50' });
  });

  it('attachmentUrl encodes the Graph id (base64 + / =) so it arrives intact (F13)', () => {
    expect(attachmentUrl(7, 'AAMk+a/b==', false)).toBe('/api/mail/7/attachment?att=AAMk%2Ba%2Fb%3D%3D');
    expect(attachmentUrl(7, 'AAMk+a/b==', true)).toBe('/api/mail/7/attachment?att=AAMk%2Ba%2Fb%3D%3D&inline=1');
  });
});

describe('replies', () => {
  const original = {
    id: 9, status: 'received', fromAddress: 'ana@acme.com', toAddresses: ['arjun@daitpartners.com', 'tom@acme.com'],
    ccAddresses: ['ARJUN@daitpartners.com', 'li@acme.com'], subject: 'Proposal', leadId: 5, companyId: 4,
  };

  it('replyStart: Reply all to the sender and other To addresses without your own, Cc pre-filled; Forward empty To, Fw: subject', () => {
    expect(replyStart(original, 'replyAll', 'arjun@daitpartners.com')).toEqual({
      replyTo: 9, mode: 'replyAll', to: 'ana@acme.com, tom@acme.com', cc: ['li@acme.com'], subject: 'Re: Proposal', leadId: 5, companyId: 4,
    });
    expect(replyStart(original, 'forward', 'arjun@daitpartners.com')).toEqual({
      replyTo: 9, mode: 'forward', to: '', cc: [], subject: 'Fw: Proposal', leadId: 5, companyId: 4,
    });
  });

  it('replyStart: Reply goes to the sender only, no Cc; your own sent mail replies to its recipients; no lead stays unset', () => {
    expect(replyStart({ ...original, subject: 'RE: Proposal' }, 'reply', 'arjun@daitpartners.com')).toEqual({
      replyTo: 9, mode: 'reply', to: 'ana@acme.com', cc: [], subject: 'RE: Proposal', leadId: 5, companyId: 4,
    });
    expect(replyStart({ ...original, status: 'sent', fromAddress: 'arjun@daitpartners.com', leadId: null, companyId: null }, 'reply', null)).toEqual({
      replyTo: 9, mode: 'reply', to: 'arjun@daitpartners.com, tom@acme.com', cc: [], subject: 'Re: Proposal',
    });
  });

  it('useReplyMail sends the mode and To (defaults: reply, no To)', async () => {
    const { posts } = stub([], () => ({ status: 201, body: item({ id: 50 }) }));
    function Send() {
      const r = useReplyMail();
      return (
        <div>
          <button type="button" onClick={() => r.mutate({ id: 9, mode: 'forward', to: ['bo@x.com'], cc: [], body: 'FYI', bodyHtml: null })}>Forward</button>
          <button type="button" onClick={() => r.mutate({ id: 9, cc: ['li@acme.com'], body: 'Thanks' })}>Reply</button>
        </div>
      );
    }
    show(<Send />);
    await userEvent.click(screen.getByRole('button', { name: 'Forward' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts).toEqual([
      { url: '/api/mail/9/reply', body: { mode: 'forward', to: ['bo@x.com'], cc: [], body: 'FYI', bodyHtml: null } },
      { url: '/api/mail/9/reply', body: { mode: 'reply', to: [], cc: ['li@acme.com'], body: 'Thanks', bodyHtml: null } },
    ]);
  });
});
