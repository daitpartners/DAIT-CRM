import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Outlet, Route, RouterProvider, Routes, createMemoryRouter, useLocation } from 'react-router-dom';
import type { DraftView, SendResult } from '../src/api/drafts';
import type { MailDetail, MailItem, MailMeta } from '../src/api/mail';
import type { Me } from '../src/api/queries';
import type { EmailTemplate } from '../src/api/templates';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { UndoSendProvider } from '../src/components/send/UndoSend';
import { ToastProvider } from '../src/components/Toast';
import { I18nProvider } from '../src/i18n';
import { EmailPage } from '../src/pages/email/EmailPage';
import { draftKindOf } from '../src/pages/email/compose/InlineReply';
import { draftApi, draftView } from './draftFixture';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
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
  id: m.id, occurredAt: m.occurredAt, direction: 'in', who: '', subject: m.subject, kind: 'received', by: null, unmatched: false,
  fromName: m.fromName, fromAddress: m.fromAddress, toAddresses: m.toAddresses, ccAddresses: [], preview: m.preview, hasAttachments: false,
  folder: m.folder, isRead: true, ...over,
});
const detail = (m: MailItem, over: Partial<MailDetail> = {}): MailDetail => ({
  ...m, ccAddresses: ['robert@acme.com'], bodyText: 'Please find attached our RFP.', bodyHtml: null, attachmentNames: [], loggedAt: null,
  lead: { id: 5, number: 'LD-1178', status: 'Contacted', priority: 'High', nextFollowUp: null, companyId: 4 },
  contact: null, company: { id: 4, name: 'Acme Logistics' }, restrictedLead: null, leadPanel: null, thread: [], ...over,
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T14:00:00.000Z' },
  unread: 0, counts: { inbox: 0, drafts: 0, scheduled: 0, flagged: 0, awaiting: 0, due: 0, leads: 1 },
  companies: [], leads: [], projects: [], mailUsers: [{ id: 9, name: 'Carlos Torres' }], leadOwners: [],
};
const TEMPLATE: EmailTemplate = {
  id: 3, name: 'Thanks', language: 'en', subject: 'Thank you', body: '', bodyHtml: '<p>Hi {first_name}, thanks from {company}.</p>',
  sourceType: 'manual', fileName: null, fileSize: null,
  attachments: [{ id: 11, name: 'Brochure.pdf', contentType: 'application/pdf', size: 1000, contentId: null, inline: false }],
  createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};

type Opts = {
  items?: MailItem[];
  details?: Record<number, MailDetail>;
  user?: Me;
  /** PATCH answers: a refusal code for the first saves. */
  saveErrors?: string[];
  made?: (n: number, body: Record<string, unknown>) => DraftView;
  drafts?: Record<number, DraftView>;
};

function stub(opts: Opts = {}) {
  const items = opts.items ?? [item()];
  const details = opts.details ?? { 1: detail(items[0]!) };
  const drafts = draftApi({ made: opts.made, drafts: opts.drafts });
  const saveErrors = [...(opts.saveErrors ?? [])];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'PATCH' && saveErrors.length && /^\/api\/mail\/drafts\/\d+$/.test(url)) {
      drafts.calls.push({ url, method, body: JSON.parse(String(init!.body)) });
      return Response.json({ error: saveErrors.shift() }, { status: 409 });
    }
    const sendM = /^\/api\/mail\/drafts\/(\d+)\/send$/.exec(url);
    if (sendM) {
      const body = JSON.parse(String(init!.body)) as { followUp: { date: string; time: string } | null };
      drafts.calls.push({ url, method, body });
      const r: SendResult = { id: Number(sendM[1]), sendAt: new Date(Date.now() + 10_000).toISOString(), undoUntil: new Date(Date.now() + 10_000).toISOString(), followUp: body.followUp ? { date: body.followUp.date, time: body.followUp.time } : null };
      return Response.json(r, { status: 202 });
    }
    const unsend = /^\/api\/mail\/(\d+)\/unsend$/.exec(url);
    if (unsend) {
      drafts.calls.push({ url, method, body: undefined });
      return Response.json(drafts.drafts[Number(unsend[1])]);
    }
    if (url === '/api/mail/drafts/50/template') {
      drafts.calls.push({ url, method, body: JSON.parse(String(init!.body)) });
      return Response.json({ files: [{ id: 'att-1', name: 'Brochure.pdf', contentType: 'application/pdf', size: 1000, inline: false, contentId: null, dataUrl: null }] });
    }
    const handled = drafts.handle(url, init);
    if (handled) return handled;
    if (url === '/api/me') return Response.json(opts.user ?? me);
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (url.startsWith('/api/mail/meta')) return Response.json(META);
    if (url === '/api/email-templates') return Response.json({ items: [TEMPLATE] });
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

function show(path = '/email/1', user: Me = me) {
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

/** The app's own kind of router (a data router, as createBrowserRouter), with a sidebar link outside the Email screen. */
function showApp(path = '/email/1') {
  // The data router builds a Request with jsdom's AbortSignal, which Node's Request refuses: drop the signal in tests.
  const NodeRequest = globalThis.Request;
  vi.stubGlobal('Request', class extends NodeRequest {
    constructor(input: RequestInfo | URL, init: RequestInit = {}) {
      const { signal: _signal, ...rest } = init;
      super(input, rest);
    }
  });
  const router = createMemoryRouter([{
    element: (
      <>
        <nav><Link to="/leads">Sidebar Leads</Link></nav>
        <Outlet />
        <Where />
      </>
    ),
    children: [
      { path: '/email', element: <EmailPage /> },
      { path: '/email/:id', element: <EmailPage /> },
      { path: '/leads', element: <p>Leads page</p> },
    ],
  }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={makeClient(me)}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <UndoSendProvider>
              <RouterProvider router={router} />
            </UndoSendProvider>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return router;
}

const pane = () => screen.findByRole('region', { name: 'Reading pane' });
const footer = async () => ((await within(await pane()).findByRole('article')).querySelector('.msg-foot') as HTMLElement);
const editorFrame = (form: HTMLElement) => form.querySelector('iframe.rbody') as HTMLIFrameElement;
/** Types in the message: what the browser's editing would leave in the frame, and its input event. */
async function typeMessage(form: HTMLElement, html: string) {
  const frame = editorFrame(form);
  await waitFor(() => expect(frame.contentDocument!.body.innerHTML).toContain('dait-sig'));
  act(() => {
    const body = frame.contentDocument!.body;
    body.innerHTML = `${html}${body.querySelector('.dait-sig')?.outerHTML ?? ''}`;
    frame.contentDocument!.dispatchEvent(new Event('input'));
  });
}
async function openReply(user: ReturnType<typeof userEvent.setup>, name = 'Reply') {
  const foot = await footer();
  await user.click(await within(foot).findByRole('button', { name }));
  return screen.findByRole('form', { name });
}

describe('Inline Reply, Reply all and Forward (web-mail release 3, state 2)', () => {
  it('Reply opens the inline editor above the newest message: To chip with lead tag, Cc, toolbar, signature, quote folded', async () => {
    const user = userEvent.setup();
    const api = stub({ made: (n) => draftView({ id: n, cc: [{ address: 'robert@acme.com', name: 'Robert Hayes', leadNumber: null }] }) });
    show();
    const p = await pane();
    await user.click(within(await footer()).getByRole('button', { name: 'Reply' }));
    const editor = await screen.findByRole('form', { name: 'Reply' });
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'reply', replyToId: 1 }]);
    expect(within(editor).getByText('Maria Gómez')).toBeInTheDocument();
    expect(within(editor).getByText('LD-1178')).toHaveClass('lead-tag');
    expect(within(editor).getByText('Robert Hayes')).toBeInTheDocument();
    expect(within(editor).getByRole('combobox', { name: 'Add Cc' })).toBeInTheDocument();
    expect(within(editor).getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    await waitFor(() => expect(within(editor).getByRole('button', { name: 'Signature' })).toBeEnabled());
    expect(within(editor).getByRole('button', { name: 'Show quoted text' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(editor).getByRole('status')).toHaveTextContent('Draft saved 14:32');
    // At the top of the conversation, above the newest message; its Reply / Reply all / Forward footer is gone meanwhile.
    const article = within(p).getByRole('article');
    expect(editor.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(article.querySelector('.msg-foot')).toBeNull();
    await user.click(within(editor).getByRole('button', { name: 'Show quoted text' }));
    expect(within(editor).getByRole('button', { name: 'Show quoted text' })).toHaveAttribute('aria-expanded', 'true');
    expect(editor.querySelector('.quoted iframe')).not.toBeNull();
  });

  it('typing saves the draft after 2 s and shows Draft saved hh:mm', async () => {
    const user = userEvent.setup();
    const api = stub();
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Hi Maria, thanks.</p>');
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(1), { timeout: 4000 });
    const saved = api.of('/api/mail/drafts/50', 'PATCH')[0]!.body!;
    expect(saved).toMatchObject({ to: ['maria@acme.com'], cc: [], bcc: [], subject: 'Re: Proposal', leadId: 5 });
    expect(saved.bodyHtml).toContain('<p>Hi Maria, thanks.</p>');
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('Draft saved 14:40'));
  });

  it('Bcc link reveals Bcc; addresses typed with commas become chips; an invalid one stays marked', async () => {
    const user = userEvent.setup();
    const api = stub();
    show();
    const form = await openReply(user);
    expect(within(form).queryByRole('combobox', { name: 'Add Bcc' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Bcc' }));
    const bcc = within(form).getByRole('combobox', { name: 'Add Bcc' });
    await waitFor(() => expect(bcc).toHaveFocus());
    await user.type(bcc, 'li@acme.com, tom@acme.com;nope,');
    expect(within(form).getByTitle('li@acme.com')).toHaveClass('rcp');
    expect(within(form).getByTitle('tom@acme.com')).toHaveClass('rcp');
    expect(bcc).toHaveValue('nope');
    expect(bcc).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({ bcc: ['li@acme.com', 'tom@acme.com'] }), { timeout: 4000 });
    // A chip's Remove takes it out.
    await user.click(within(within(form).getByTitle('tom@acme.com')).getByRole('button', { name: 'Remove' }));
    expect(within(form).queryByTitle('tom@acme.com')).toBeNull();
  });

  it('Discard deletes the draft and closes the editor; closing an untouched editor deletes it too', async () => {
    const user = userEvent.setup();
    const api = stub();
    show();
    let form = await openReply(user);
    await user.click(within(form).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Reply' })).toBeNull());
    expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(1);
    // The footer is back; Reply again, then Forward (the message's own button) while untouched: the reply draft goes.
    form = await openReply(user);
    expect(api.of('/api/mail/drafts').length).toBe(2);
    const article = within(await pane()).getByRole('article');
    await user.click(within(article.querySelector('.mh') as HTMLElement).getByRole('button', { name: 'Forward' }));
    await screen.findByRole('form', { name: 'Forward' });
    await waitFor(() => expect(api.of('/api/mail/drafts/51', 'DELETE')).toHaveLength(1));
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([
      { kind: 'reply', replyToId: 1 }, { kind: 'reply', replyToId: 1 }, { kind: 'forward', replyToId: 1 },
    ]);
  });

  it('a touched editor closed by opening another is saved once more, not deleted', async () => {
    const user = userEvent.setup();
    const api = stub();
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Draft in progress</p>');
    const article = within(await pane()).getByRole('article');
    await user.click(within(article.querySelector('.mh') as HTMLElement).getByRole('button', { name: 'Reply all' }));
    await screen.findByRole('form', { name: 'Reply all' });
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(1));
    expect(api.of('/api/mail/drafts/50', 'PATCH')[0]!.body!.bodyHtml).toContain('Draft in progress');
    expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(0);
  });

  it('Send (lead) → follow-up box → Send and add follow-up → sent note and Undo toast; Undo reopens the editor with the draft', async () => {
    const user = userEvent.setup();
    const api = stub();
    show();
    const form = await openReply(user);
    await user.click(within(form).getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog');
    await user.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(api.of('/api/mail/drafts/50/send')).toHaveLength(1));
    expect(api.of('/api/mail/drafts/50/send')[0]!.body).toMatchObject({ to: ['maria@acme.com'], at: null, followUp: expect.objectContaining({ title: 'Follow up: Re: Proposal' }) });
    const note = await screen.findByText("Reply sent to Maria Gómez · follow-up task added · it will appear here and on LD-1178's timeline.");
    expect(note).toHaveClass('sent-note');
    expect(screen.queryByRole('form', { name: 'Reply' })).toBeNull();
    // The footer shows again under the sent note (mockup).
    expect(within(await footer()).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    const toast = screen.getByText(/^Sent · follow-up added for/).closest('.utoast') as HTMLElement;
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.of('/api/mail/50/unsend')).toHaveLength(1));
    const again = await screen.findByRole('form', { name: 'Reply' });
    expect(within(again).getByText('Maria Gómez')).toBeInTheDocument();
    expect(screen.queryByText(/Reply sent to/)).toBeNull();
    expect(api.of('/api/mail/drafts')).toHaveLength(1);
  });

  it('after a send, Reply under the sent note opens a fresh editor; Forward then does too, footer hidden again', async () => {
    const user = userEvent.setup();
    const api = stub();
    show();
    const form = await openReply(user);
    await user.click(within(form).getByRole('button', { name: 'Send' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send without follow-up' }));
    await screen.findByText("Reply sent to Maria Gómez · it will appear here and on LD-1178's timeline.");
    await user.click(within(await footer()).getByRole('button', { name: 'Reply' }));
    const again = await screen.findByRole('form', { name: 'Reply' });
    expect(api.of('/api/mail/drafts')).toHaveLength(2);
    expect(screen.queryByText(/Reply sent to/)).toBeNull();
    expect(within(await pane()).getByRole('article').querySelector('.msg-foot')).toBeNull();
    expect(within(again).getByText('Maria Gómez')).toBeInTheDocument();
  });

  it('a forward sent says Forwarded to …', async () => {
    const user = userEvent.setup();
    stub({ made: (n, body) => draftView({ id: n, subject: body.kind === 'forward' ? 'Fw: Proposal' : 'Re: Proposal' }) });
    show();
    const form = await openReply(user, 'Forward');
    await user.click(within(form).getByRole('button', { name: 'Send' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send without follow-up' }));
    expect(await screen.findByText("Forwarded to Maria Gómez · it will appear here and on LD-1178's timeline.")).toHaveClass('sent-note');
  });

  it('opening another message saves the editor first; a failed save keeps the editor and the message, and says why', async () => {
    const user = userEvent.setup();
    const second = item({ id: 2, subject: 'Second', fromName: 'Tom Becker', occurredAt: '2026-11-21T10:00:00.000Z' });
    const api = stub({ items: [item(), second], details: { 1: detail(item()), 2: detail(second) }, saveErrors: ['mailbox_changed'] });
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Not lost</p>');
    await user.click(screen.getByRole('link', { name: /Second/ }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('This draft is in a mailbox that is no longer connected. Open it in Outlook.');
    expect(screen.getByTestId('where')).toHaveTextContent('/email/1');
    expect(screen.getByRole('form', { name: 'Reply' })).toBe(form);
    expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(1);
  });

  it('opening another message after a good save goes there, with no extra save on the way out', async () => {
    const user = userEvent.setup();
    const second = item({ id: 2, subject: 'Second', fromName: 'Tom Becker', occurredAt: '2026-11-21T10:00:00.000Z' });
    const api = stub({ items: [item(), second], details: { 1: detail(item()), 2: detail(second) } });
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Saved before leaving</p>');
    await user.click(screen.getByRole('link', { name: /Second/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/email/2'));
    expect(screen.queryByRole('form')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(1);
    expect(api.of('/api/mail/drafts/50', 'PATCH')[0]!.body!.bodyHtml).toContain('Saved before leaving');
    expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(0);
  });

  it('switching to another kind with a failing save keeps the editor and says why', async () => {
    const user = userEvent.setup();
    const api = stub({ saveErrors: ['outlook_busy', 'outlook_busy'] });
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Unsaved</p>');
    const article = within(await pane()).getByRole('article');
    await user.click(within(article.querySelector('.mh') as HTMLElement).getByRole('button', { name: 'Forward' }));
    expect(await within(form).findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Forward' })).toBeNull();
    expect(screen.getByRole('form', { name: 'Reply' })).toBe(form);
    expect(api.of('/api/mail/drafts')).toHaveLength(1);
    // A passing failure: no way out but saving (it is retried).
    expect(within(form).queryByRole('button', { name: 'Close without saving' })).toBeNull();
  });

  it('a mailbox no longer connected: Close without saving lets the other message open', async () => {
    const user = userEvent.setup();
    const second = item({ id: 2, subject: 'Second', fromName: 'Tom Becker', occurredAt: '2026-11-21T10:00:00.000Z' });
    const api = stub({ items: [item(), second], details: { 1: detail(item()), 2: detail(second) }, saveErrors: ['mailbox_not_connected', 'mailbox_not_connected'] });
    show();
    const form = await openReply(user);
    // (The editor of the test before may still save once as it goes: count from here.)
    const before = api.of('/api/mail/drafts/50', 'PATCH').length;
    await typeMessage(form, '<p>Cannot be saved</p>');
    await user.click(screen.getByRole('link', { name: /Second/ }));
    const alert = await within(form).findByRole('alert');
    expect(screen.getByTestId('where')).toHaveTextContent('/email/1');
    await user.click(within(alert).getByRole('button', { name: 'Close without saving' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/email/2'));
    expect(screen.queryByRole('form')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    // The one failed save; nothing more once closed without saving.
    expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(before + 1);
  });

  it('a mailbox no longer connected: Close without saving after Discard closes the editor (and still asks Outlook to discard)', async () => {
    const user = userEvent.setup();
    const api = stub({ saveErrors: ['mailbox_not_connected', 'mailbox_not_connected'] });
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Cannot be saved</p>');
    await user.click(within(form).getByRole('button', { name: 'Discard' }));
    const alert = await within(form).findByRole('alert');
    expect(screen.getByRole('form', { name: 'Reply' })).toBe(form);
    await user.click(within(alert).getByRole('button', { name: 'Close without saving' }));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(1));
    expect(within(await footer()).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  it('a mailbox no longer connected: another reply asked for goes ahead after Close without saving', async () => {
    const user = userEvent.setup();
    const api = stub({ saveErrors: ['mailbox_not_connected', 'mailbox_not_connected'] });
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Cannot be saved</p>');
    const article = within(await pane()).getByRole('article');
    await user.click(within(article.querySelector('.mh') as HTMLElement).getByRole('button', { name: 'Forward' }));
    await user.click(within(await within(form).findByRole('alert')).getByRole('button', { name: 'Close without saving' }));
    await screen.findByRole('form', { name: 'Forward' });
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'reply', replyToId: 1 }, { kind: 'forward', replyToId: 1 }]);
  });

  it('leaving the Email screen by the sidebar with an unsaved reply saves it first, then goes', async () => {
    const user = userEvent.setup();
    const api = stub();
    showApp();
    const form = await openReply(user);
    await typeMessage(form, '<p>Saved on the way out</p>');
    await user.click(screen.getByRole('link', { name: 'Sidebar Leads' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/leads'));
    expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(1);
    expect(api.of('/api/mail/drafts/50', 'PATCH')[0]!.body!.bodyHtml).toContain('Saved on the way out');
  });

  it('leaving by the sidebar with a failed save keeps the reply and says why; Close without saving then goes', async () => {
    const user = userEvent.setup();
    stub({ saveErrors: ['mailbox_changed', 'mailbox_changed'] });
    showApp();
    const form = await openReply(user);
    await typeMessage(form, '<p>Not lost</p>');
    await user.click(screen.getByRole('link', { name: 'Sidebar Leads' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('This draft is in a mailbox that is no longer connected. Open it in Outlook.');
    expect(screen.getByTestId('where')).toHaveTextContent('/email/1');
    await user.click(within(form).getByRole('button', { name: 'Close without saving' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/leads'));
  });

  it('draftKindOf: forward prefixes in English, Spanish and French Outlook; reply all by recipients', () => {
    const one = [{ address: 'a@x.com', name: null, leadNumber: null }];
    expect(draftKindOf({ subject: 'Fw: Proposal', to: one, cc: [] })).toBe('forward');
    expect(draftKindOf({ subject: 'FWD: Proposal', to: one, cc: [] })).toBe('forward');
    expect(draftKindOf({ subject: 'RV: Propuesta', to: one, cc: [] })).toBe('forward');
    expect(draftKindOf({ subject: 'TR : Proposition', to: one, cc: [] })).toBe('forward');
    expect(draftKindOf({ subject: 'RE: Proposal', to: one, cc: one })).toBe('replyAll');
    expect(draftKindOf({ subject: 'RE: Proposal', to: one, cc: [] })).toBe('reply');
    expect(draftKindOf({ subject: 'Travel plans', to: one, cc: [] })).toBe('reply');
  });

  it.each(['RV: Propuesta', 'TR: Proposition'])('Continue editing a "%s" draft opens it as Forward', async (subject) => {
    const user = userEvent.setup();
    const m = item();
    const draftRow = item({ id: 8, status: 'draft', folder: 'drafts', preview: 'FYI', occurredAt: '2026-11-22T15:00:00.000Z' });
    stub({
      details: { 1: detail(m, { thread: [entry(draftRow, { kind: 'draft', direction: 'out' }), entry(m)] }) },
      drafts: { 8: draftView({ id: 8, subject, to: [{ address: 'tom@x.com', name: null, leadNumber: null }] }) },
    });
    show();
    const row = (await within(await pane()).findByText('Draft · FYI')).closest('.msg') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Continue editing' }));
    expect(await screen.findByRole('form', { name: 'Forward' })).toBeInTheDocument();
  });

  it('Continue editing a forward draft opens it as Forward', async () => {
    const user = userEvent.setup();
    const m = item();
    const draftRow = item({ id: 8, status: 'draft', folder: 'drafts', preview: 'FYI', occurredAt: '2026-11-22T15:00:00.000Z' });
    stub({
      details: { 1: detail(m, { thread: [entry(draftRow, { kind: 'draft', direction: 'out' }), entry(m)] }) },
      drafts: { 8: draftView({ id: 8, subject: 'Fw: Proposal', to: [{ address: 'tom@x.com', name: null, leadNumber: null }] }) },
    });
    show();
    const row = (await within(await pane()).findByText('Draft · FYI')).closest('.msg') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Continue editing' }));
    expect(await screen.findByRole('form', { name: 'Forward' })).toBeInTheDocument();
  });

  it('Pop out goes to /email/new?draft=<id>', async () => {
    const user = userEvent.setup();
    stub();
    show();
    const form = await openReply(user);
    await user.click(within(form).getByRole('button', { name: 'Pop out' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/email/new?draft=50'));
  });

  it('Pop out stays open when the last save fails, and says why', async () => {
    const user = userEvent.setup();
    const api = stub({ saveErrors: ['mailbox_changed'] });
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Unsaved</p>');
    await user.click(within(form).getByRole('button', { name: 'Pop out' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('This draft is in a mailbox that is no longer connected. Open it in Outlook.');
    expect(screen.getByTestId('where')).toHaveTextContent('/email/1');
    expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(1);
  });

  it('R, Shift+R and F open the editor; typing r inside the editor or a recipient field opens nothing', async () => {
    const user = userEvent.setup();
    const api = stub();
    show();
    await footer();
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Mail commands' })).toBeInTheDocument());
    await user.keyboard('r');
    let form = await screen.findByRole('form', { name: 'Reply' });
    await user.click(within(form).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    await user.keyboard('{Shift>}R{/Shift}');
    form = await screen.findByRole('form', { name: 'Reply all' });
    await user.click(within(form).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    await user.keyboard('f');
    form = await screen.findByRole('form', { name: 'Forward' });
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([
      { kind: 'reply', replyToId: 1 }, { kind: 'replyAll', replyToId: 1 }, { kind: 'forward', replyToId: 1 },
    ]);
    const to = within(form).getByRole('combobox', { name: 'Add recipient' });
    await user.type(to, 'rfr');
    expect(to).toHaveValue('rfr');
    // A key on one of the editor's buttons is the editor's too.
    within(form).getByRole('button', { name: 'Show quoted text' }).focus();
    await user.keyboard('r');
    // Keys typed in the message stay in its frame (a separate document): the page never sees them.
    fireEvent.keyDown(editorFrame(form).contentDocument!.body, { key: 'r' });
    expect(screen.getAllByRole('form')).toHaveLength(1);
    expect(screen.getByRole('form', { name: 'Forward' })).toBeInTheDocument();
    expect(api.of('/api/mail/drafts')).toHaveLength(3);
  });

  it('view only: no Reply buttons enabled, no draft created', async () => {
    const user = userEvent.setup();
    const theirs = item({ viewOnly: true, owner: { id: 9, name: 'Carlos Torres' } });
    const api = stub({ items: [theirs], details: { 1: detail(theirs) }, user: admin });
    show('/email/1?mailof=all', admin);
    const p = await pane();
    const article = await within(p).findByRole('article');
    expect(within(article).queryByRole('button', { name: 'Reply' })).toBeNull();
    const bar = screen.getByRole('toolbar', { name: 'Mail commands' });
    await waitFor(() => expect(within(bar).getByRole('button', { name: 'Reply' })).toBeDisabled());
    expect(within(bar).getByRole('button', { name: 'Reply' })).toHaveAttribute('title', "View only — Carlos's mailbox");
    await user.click(document.body);
    await user.keyboard('r');
    await user.keyboard('f');
    expect(screen.queryByRole('form')).toBeNull();
    expect(api.of('/api/mail/drafts')).toHaveLength(0);
  });

  it('a draft reply in the conversation shows Continue editing', async () => {
    const user = userEvent.setup();
    const m = item();
    const draftRow = item({ id: 7, status: 'draft', folder: 'drafts', fromName: 'Arjun Mehta', fromAddress: 'arjun@daitpartners.com', preview: 'Thanks Maria, we will', occurredAt: '2026-11-22T15:00:00.000Z' });
    const thread = [entry(draftRow, { kind: 'draft', direction: 'out' }), entry(m)];
    const api = stub({
      details: { 1: detail(m, { thread }) },
      drafts: { 7: draftView({ id: 7, bodyHtml: '<p>Thanks Maria, we will</p>' }) },
    });
    show();
    const p = await pane();
    const row = (await within(p).findByText('Draft · Thanks Maria, we will')).closest('.msg') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Continue editing' }));
    const form = await screen.findByRole('form', { name: 'Reply' });
    await waitFor(() => expect(editorFrame(form).contentDocument!.body.innerHTML).toContain('Thanks Maria, we will'));
    expect(api.of('/api/mail/drafts/7', 'GET')).toHaveLength(1);
    expect(api.of('/api/mail/drafts')).toHaveLength(0);
    // Its own row leaves the conversation while it is edited.
    expect(within(p).queryByText('Draft · Thanks Maria, we will')).toBeNull();
    // Closing an opened (not just created) draft untouched keeps it.
    await user.click(within(within(p).getByRole('article').querySelector('.mh') as HTMLElement).getByRole('button', { name: 'Forward' }));
    await screen.findByRole('form', { name: 'Forward' });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.of('/api/mail/drafts/7', 'DELETE')).toHaveLength(0);
  });

  it('draft_gone on save shows the message and Save as a new draft', async () => {
    const user = userEvent.setup();
    const api = stub({ saveErrors: ['draft_gone'] });
    show();
    const form = await openReply(user);
    await typeMessage(form, '<p>Keep this</p>');
    const alert = await within(form).findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent('This draft was removed in Outlook.');
    await user.click(within(alert).getByRole('button', { name: 'Save as a new draft' }));
    await waitFor(() => expect(api.of('/api/mail/drafts/51', 'PATCH')).toHaveLength(1));
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'reply', replyToId: 1 }, { kind: 'reply', replyToId: 1 }]);
    expect(api.of('/api/mail/drafts/51', 'PATCH')[0]!.body!.bodyHtml).toContain('Keep this');
    await waitFor(() => expect(within(form).queryByRole('alert')).toBeNull());
    // The editor now works on the new draft.
    await user.click(within(form).getByRole('button', { name: 'Pop out' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/email/new?draft=51'));
  });

  it('Template fills the message from the lead (subject kept) and puts its files on the draft', async () => {
    const user = userEvent.setup();
    const api = stub({ made: (n) => draftView({ id: n, lead: { company: { id: 4, name: 'Acme Logistics', site: null, place: null }, contact: { name: 'Maria Gómez', role: null, email: 'maria@acme.com', phone: null }, owner: null, followUp: null, lastActivity: null, value: null, recent: [], linkReason: null } }) });
    show();
    const form = await openReply(user);
    await user.click(within(form).getByRole('button', { name: 'Template' }));
    await user.click(within(await screen.findByRole('menu', { name: 'Insert template' })).getByRole('menuitem', { name: /Thanks/ }));
    await waitFor(() => expect(api.of('/api/mail/drafts/50/template')).toHaveLength(1));
    expect(api.of('/api/mail/drafts/50/template')[0]!.body).toEqual({ templateId: 3, attachmentIds: [11] });
    await waitFor(() => expect(editorFrame(form).contentDocument!.body.innerHTML).toContain('Hi Maria, thanks from Acme Logistics.'));
    // The signature stays under it.
    expect(editorFrame(form).contentDocument!.body.innerHTML).toContain('dait-sig');
    expect(within(form).getByText('Brochure.pdf').closest('.att-chip')).not.toBeNull();
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({ subject: 'Re: Proposal' }), { timeout: 4000 });
    await user.click(within(form).getByRole('button', { name: 'Remove attachment' }));
    await waitFor(() => expect(api.of('/api/mail/drafts/50/files/att-1', 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(within(form).queryByText('Brochure.pdf')).toBeNull());
  });

  it('a picture deleted from the message is taken off the draft; one in the quote stays', async () => {
    const user = userEvent.setup();
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const api = stub({
      made: (n) => draftView({
        id: n,
        bodyHtml: '<p><img src="cid:pic1"></p><div class="dait-sig"><b>Arjun Mehta</b></div>',
        quotedHtml: '<p><img src="cid:logo"></p>',
        files: [
          { id: 'f1', name: 'pic.png', contentType: 'image/png', size: 10, inline: true, contentId: 'pic1', dataUrl: png },
          { id: 'f2', name: 'logo.png', contentType: 'image/png', size: 10, inline: true, contentId: 'logo', dataUrl: png },
        ],
      }),
    });
    show();
    const form = await openReply(user);
    // Opened with the picture shown from its data.
    await waitFor(() => expect(editorFrame(form).contentDocument!.body.innerHTML).toContain('data-cid="pic1"'));
    await typeMessage(form, '<p>No picture now</p>');
    await waitFor(() => expect(api.of('/api/mail/drafts/50/files/f1', 'DELETE')).toHaveLength(1));
    expect(api.of('/api/mail/drafts/50/files/f2', 'DELETE')).toHaveLength(0);
  });
});
