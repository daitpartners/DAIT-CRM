import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Outlet, Route, RouterProvider, Routes, createMemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { DraftView, SendResult } from '../src/api/drafts';
import type { LeadSummary } from '../src/api/leads';
import type { LeadPanel, MailMeta } from '../src/api/mail';
import type { ProjectRow } from '../src/api/projects';
import type { Me } from '../src/api/queries';
import type { EmailTemplate } from '../src/api/templates';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { UndoSendProvider } from '../src/components/send/UndoSend';
import { ToastProvider } from '../src/components/Toast';
import { I18nProvider } from '../src/i18n';
import { EmailPage } from '../src/pages/email/EmailPage';
import { draftApi, draftView } from './draftFixture';
import { makeClient, makeLead, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
});

const me: Me = { ...rep, timezone: 'Europe/London', rights: [...rep.rights, 'use_email' as const, 'view_all_leads' as const] };

const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T14:00:00.000Z' },
  unread: 0, counts: { inbox: 0, drafts: 0, scheduled: 0, flagged: 0, awaiting: 0, due: 0, leads: 0 },
  companies: [], leads: [], projects: [], mailUsers: [], leadOwners: [],
};
const TEMPLATE: EmailTemplate = {
  id: 3, name: 'Thanks', language: 'en', subject: 'Thank you', body: '', bodyHtml: '<p>Hi {first_name}, thanks from {company}.</p>',
  sourceType: 'manual', fileName: null, fileSize: null, attachments: [],
  createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};
const MERIDIAN = makeLead({
  status: 'Contacted',
  contact: { ...makeLead().contact!, designation: 'Head of Operations', email: 'tom@meridian.com', businessEmail: 'tom@meridian.com' },
  activities: [
    { id: 1, leadId: 5, activityType: 'call', title: 'Call logged', body: 'Discovery call', url: null, statusFrom: null, statusTo: null, relatedType: null, relatedId: null, by: null, occurredAt: '2026-11-24T16:00:00.000Z' },
  ],
});
const PANEL: LeadPanel = {
  company: { id: 4, name: 'Meridian Textiles', site: 'meridian.example', place: 'Pune, India' },
  contact: { name: 'Tom Hale', role: 'Head of Operations', email: 'tom@meridian.com', phone: null },
  owner: 'Arjun Mehta', followUp: { date: '2026-11-28', time: '10:00', due: false },
  lastActivity: { title: 'Email received', occurredAt: '2026-11-26T12:48:00.000Z' }, value: { amount: 36000, currency: 'USD' },
  recent: [
    { id: 2, leadId: 5, activityType: 'email', title: 'Email received', body: 'Re: Discovery call notes', url: null, statusFrom: null, statusTo: null, relatedType: null, relatedId: null, by: null, occurredAt: '2026-11-26T12:48:00.000Z' },
    { id: 1, leadId: 5, activityType: 'call', title: 'Call logged', body: 'Discovery call, 45 min', url: null, statusFrom: null, statusTo: null, relatedType: null, relatedId: null, by: null, occurredAt: '2026-11-24T16:00:00.000Z' },
    { id: 0, leadId: 5, activityType: 'note', title: 'Older note', body: null, url: null, statusFrom: null, statusTo: null, relatedType: null, relatedId: null, by: null, occurredAt: '2026-11-20T16:00:00.000Z' },
  ],
  linkReason: null,
};
const leadRow = (over: Partial<LeadSummary> = {}): LeadSummary => ({
  id: 5, number: 'LD-1005', leadType: 'Lead', companyName: 'Meridian Textiles', companyId: 4, company: { id: 4, number: 'CO-0245', name: 'Meridian Textiles' },
  contact: { id: 9, name: 'Tom Hale', email: 'tom@meridian.com', linkedinUrl: null }, country: 'India', outreachLanguage: 'en', city: null,
  leadSource: 'Referral', status: 'Contacted', priority: 'Medium', assignedTo: null, nextFollowUp: null, isOverdue: false, archivedAt: null,
  createdAt: '', importBatch: null, updatedAt: '', ...over,
});
const PROJECT: ProjectRow = {
  id: 3, number: 'PRJ-3', name: 'Website rebuild', status: 'Active', startDate: '2026-11-01', value: 1000, currency: 'USD',
  company: { id: 4, name: 'Meridian Textiles', legalName: null }, lead: { id: 5, number: 'LD-1005', visible: true }, quotation: null,
  manager: { id: 2, name: 'Arjun Mehta' },
  stakeholders: [{ id: 11, name: 'Tom Hale', email: 'tom@meridian.com' }, { id: 12, name: 'Ben Ruiz', email: 'ben@meridian.com' }, { id: 13, name: 'Carl', email: null }],
  description: null, completedAt: null, createdAt: '', updatedAt: '', canEdit: true,
};

/** A new draft as the API makes it: empty, the signature, the link's lead (with its panel) and project. */
const made = (n: number, body: Record<string, unknown>): DraftView => draftView({
  id: n, replyToId: null, to: [], subject: '', quotedHtml: null,
  leadId: (body.leadId as number | undefined) ?? null, projectId: (body.projectId as number | undefined) ?? null, lead: body.leadId ? PANEL : null,
});

function stub(opts: { drafts?: Record<number, DraftView>; saveErrors?: string[]; createError?: string; openError?: { status: number; code: string } } = {}) {
  const api = draftApi({ made, drafts: opts.drafts });
  const saveErrors = [...(opts.saveErrors ?? [])];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (opts.openError && /^\/api\/mail\/drafts\/\d+$/.test(url) && method === 'GET') return Response.json({ error: opts.openError.code }, { status: opts.openError.status });
    if (opts.createError && url === '/api/mail/drafts' && method === 'POST') return Response.json({ error: opts.createError }, { status: 409 });
    if (method === 'PATCH' && saveErrors.length && /^\/api\/mail\/drafts\/\d+$/.test(url)) {
      api.calls.push({ url, method, body: JSON.parse(String(init!.body)) });
      return Response.json({ error: saveErrors.shift() }, { status: 409 });
    }
    // A save with another lead: the draft is read back with that lead (and its panel).
    const patch = /^\/api\/mail\/drafts\/(\d+)$/.exec(url);
    if (patch && method === 'PATCH') {
      const body = JSON.parse(String(init!.body)) as { leadId?: number | null };
      const d = api.drafts[Number(patch[1])];
      if (d && body.leadId !== undefined) api.drafts[d.id] = { ...d, leadId: body.leadId, lead: body.leadId ? PANEL : null };
    }
    const sendM = /^\/api\/mail\/drafts\/(\d+)\/send$/.exec(url);
    if (sendM) {
      const body = JSON.parse(String(init!.body)) as { at: string | null; followUp: { date: string; time: string } | null };
      api.calls.push({ url, method, body });
      const r: SendResult = {
        id: Number(sendM[1]), sendAt: body.at ?? new Date(Date.now() + 10_000).toISOString(),
        undoUntil: body.at ? null : new Date(Date.now() + 10_000).toISOString(), followUp: body.followUp ? { date: body.followUp.date, time: body.followUp.time } : null,
      };
      return Response.json(r, { status: 202 });
    }
    const unsend = /^\/api\/mail\/(\d+)\/unsend$/.exec(url);
    if (unsend) {
      api.calls.push({ url, method, body: undefined });
      return Response.json(api.drafts[Number(unsend[1])]);
    }
    if (/^\/api\/mail\/drafts\/\d+\/template$/.test(url)) return Response.json({ files: [] });
    const handled = api.handle(url, init);
    if (handled) return handled;
    if (url === '/api/me') return Response.json(me);
    if (url.startsWith('/api/mail?')) return Response.json({ items: [], total: 0, page: 1, pageSize: 50 });
    if (url.startsWith('/api/mail/meta')) return Response.json(META);
    if (url === '/api/email-templates') return Response.json({ items: [TEMPLATE] });
    if (url === '/api/leads/5') return Response.json(MERIDIAN);
    if (url === '/api/leads/6') return Response.json(makeLead({ id: 6, number: 'LD-1006', companyName: 'Orbit', companyId: 6, company: null, contact: null }));
    if (url.startsWith('/api/leads?')) {
      return Response.json({ items: [leadRow(), leadRow({ id: 6, number: 'LD-1006', companyName: 'Orbit', companyId: 6, company: null, contact: null, status: 'New' })], total: 2, page: 1, pageSize: 8 });
    }
    if (url === '/api/companies/4/projects') return Response.json({ items: [PROJECT], isClient: true });
    if (url.startsWith('/api/companies/')) return Response.json({ items: [], isClient: false });
    return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
  }));
  return api;
}

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}
/** The browser's Back button. */
function Back() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(-1)}>Browser back</button>;
}
const where = () => screen.getByTestId('where').textContent;

function show(entries: string[]) {
  return render(
    <QueryClientProvider client={makeClient(me)}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <UndoSendProvider>
              <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
                <Routes>
                  <Route path="/email" element={<EmailPage />} />
                  <Route path="/email/new" element={<EmailPage />} />
                  <Route path="/email/:id" element={<EmailPage />} />
                </Routes>
                <Where />
                <Back />
              </MemoryRouter>
            </UndoSendProvider>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The app's own kind of router (a data router, as createBrowserRouter), with a sidebar link outside the Email screen. */
function showApp(entries: string[]) {
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
      { path: '/email/new', element: <EmailPage /> },
      { path: '/email/:id', element: <EmailPage /> },
      { path: '/leads', element: <p>Leads page</p> },
    ],
  }], { initialEntries: entries, initialIndex: entries.length - 1 });
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

const page = () => screen.findByRole('region', { name: 'New message' });
const form = () => screen.findByRole('form', { name: 'New message' });
const frameHtml = (f: HTMLElement) => (f.querySelector('iframe.rbody') as HTMLIFrameElement).contentDocument!.body.innerHTML;

describe('Full-page New message (web-mail release 3, state 3)', () => {
  it('New mail opens /email/new: draft created, address becomes ?draft=, command bar hidden, crumb and Back to Inbox', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email']);
    await user.click(await screen.findByRole('button', { name: 'New mail' }));
    const p = await page();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'new' }]);
    expect(await within(p).findByRole('form', { name: 'New message' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Command tabs' })).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Mail commands' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Message list' })).toBeNull();
    // The top bar stays.
    expect(screen.getByRole('searchbox', { name: /Search lead mail/ })).toBeInTheDocument();
    expect(within(p).getByRole('link', { name: 'Email' })).toHaveAttribute('href', '/email');
    expect(within(p).getByText(/\/ New message/)).toBeInTheDocument();
    expect(within(p).getByRole('link', { name: '← Back to Inbox' })).toHaveAttribute('href', '/email');
  });

  it('fields in order: From (Your mailbox), To, Cc/Bcc links, Subject, Lead with its hint, toolbar, body with signature', async () => {
    stub();
    show(['/email', '/email/new']);
    const f = await form();
    const from = within(f).getByRole('combobox', { name: 'From' }) as HTMLSelectElement;
    expect([...from.options].map((o) => o.textContent)).toEqual(['Arjun Mehta <arjun@daitpartners.com>']);
    expect(within(f).getByText('Your mailbox')).toHaveClass('hintr');
    const to = within(f).getByRole('combobox', { name: 'Add recipient' });
    const cc = within(f).getByRole('button', { name: 'Cc' });
    const bcc = within(f).getByRole('button', { name: 'Bcc' });
    const subject = within(f).getByRole('textbox', { name: 'Subject' });
    const lead = within(f).getByRole('button', { name: 'Choose a lead' });
    const hint = within(f).getByText("Filed on the lead's timeline when sent");
    const toolbar = within(f).getByRole('toolbar', { name: 'Formatting' });
    const body = f.querySelector('iframe.rbody') as HTMLElement;
    const order = [from, to, cc, bcc, subject, lead, hint, toolbar, body];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(frameHtml(f)).toContain('dait-sig'));
    // No project field without a client that has projects; no template bar before a template.
    expect(within(f).queryByRole('combobox', { name: 'Project' })).toBeNull();
    expect(f.querySelector('.tplbar')).toBeNull();
    // Without a lead the right column says why to choose one.
    const aside = screen.getByRole('complementary', { name: 'Chosen lead' });
    expect(aside).toHaveTextContent('Lead for this email');
    expect(aside).toHaveTextContent('No lead chosen');
    expect(aside).toHaveTextContent('Choose a lead to file this email on its timeline.');
  });

  it('choosing a lead fills an empty To with its contact and shows the lead summary on the right', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email', '/email/new']);
    const f = await form();
    await user.click(within(f).getByRole('button', { name: 'Choose a lead' }));
    const menu = await screen.findByRole('menu', { name: 'Choose a lead' });
    expect(within(menu).getByRole('searchbox', { name: 'Search leads by LD number or company' })).toHaveFocus();
    await user.click(await within(menu).findByRole('menuitem', { name: /LD-1005 · Meridian Textiles/ }));
    expect(await within(f).findByRole('button', { name: 'LD-1005 · Meridian Textiles · Contacted' })).toBeInTheDocument();
    expect(within(f).getByText('tom@meridian.com')).toBeInTheDocument();
    // Saved with the lead at once, then the lead's panel read back.
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({ to: ['tom@meridian.com'], leadId: 5 }));
    const aside = screen.getByRole('complementary', { name: 'Chosen lead' });
    await waitFor(() => expect(aside).toHaveTextContent('USD 36,000.00'));
    expect(aside).toHaveTextContent('Meridian Textiles');
    expect(aside).toHaveTextContent('meridian.example · Pune, India');
    expect(within(aside).getByText('LD-1005')).toHaveClass('badge');
    expect(aside).toHaveTextContent('Tom Hale');
    expect(aside).toHaveTextContent('Head of Operations');
    expect(aside).toHaveTextContent('Tomorrow, 10:00');
    expect(within(aside).getAllByRole('listitem')).toHaveLength(2);
    expect(within(aside).getByRole('link', { name: 'Open lead' })).toHaveAttribute('href', '/leads/5');
    // The company has a project: the Project field shows. No lead → the summary empties and the project goes.
    await user.selectOptions(await within(f).findByRole('combobox', { name: 'Project' }), '3');
    // A project chosen with an empty Cc copies its stakeholders with an email (not the To address).
    expect(await within(f).findByText('ben@meridian.com')).toBeInTheDocument();
    await user.click(within(f).getByRole('button', { name: 'LD-1005 · Meridian Textiles · Contacted' }));
    await user.click(within(await screen.findByRole('menu', { name: 'Choose a lead' })).getByRole('menuitem', { name: 'No lead' }));
    expect(await within(aside).findByText('No lead chosen')).toBeInTheDocument();
    // Without a lead (and no client in the link) there is no project to file on.
    expect(within(f).queryByRole('combobox', { name: 'Project' })).toBeNull();
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({ leadId: null, projectId: null }), { timeout: 4000 });
  });

  it('New from template fills subject and body from the lead and shows the template bar with Change', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email?company=4&lead=5']);
    await user.click(await screen.findByRole('button', { name: 'More new mail options' }));
    await user.click(await within(screen.getByRole('menu')).findByRole('menuitem', { name: /Thanks/ }));
    const f = await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50&company=4'));
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'new', leadId: 5 }]);
    await waitFor(() => expect(within(f).getByRole('textbox', { name: 'Subject' })).toHaveValue('Thank you'));
    await waitFor(() => expect(frameHtml(f)).toContain('Hi Tom, thanks from Meridian Textiles.'));
    expect(frameHtml(f)).toContain('dait-sig');
    expect(within(f).getByText('tom@meridian.com')).toBeInTheDocument();
    const bar = f.querySelector('.tplbar') as HTMLElement;
    expect(bar).toHaveTextContent('Template: Thanks · fields filled from LD-1005 · Change');
    await user.click(within(bar).getByRole('button', { name: 'Change' }));
    expect(await screen.findByRole('menu', { name: 'Insert template' })).toBeInTheDocument();
  });

  it('Send (lead) → follow-up box → Undo toast → lands on Sent; Undo comes back to the draft', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email', '/email/new?lead=5']);
    const f = await form();
    await waitFor(() => expect(within(f).getByText('tom@meridian.com')).toBeInTheDocument());
    await user.type(within(f).getByRole('textbox', { name: 'Subject' }), 'Proposal');
    await user.click(within(f).getByRole('button', { name: 'Send' }));
    const box = await screen.findByRole('dialog', { name: 'Set the next follow-up' });
    await user.click(within(box).getByRole('button', { name: 'Send and add follow-up' }));
    await waitFor(() => expect(where()).toBe('/email?folder=sent'));
    expect(api.of('/api/mail/drafts/50/send')[0]!.body).toMatchObject({ to: ['tom@meridian.com'], subject: 'Proposal', leadId: 5, at: null });
    expect(screen.queryByRole('region', { name: 'New message' })).toBeNull();
    const toast = screen.getByText(/^Sent · follow-up added for/).closest('.utoast') as HTMLElement;
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    const again = await form();
    expect(within(again).getByRole('textbox', { name: 'Subject' })).toBeInTheDocument();
    expect(api.of('/api/mail/drafts')).toHaveLength(1);
  });

  it('Schedule send from the ▾ popover posts at and lands on Scheduled', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email', '/email/new']);
    const f = await form();
    await user.type(within(f).getByRole('combobox', { name: 'Add recipient' }), 'ana@acme.com,');
    await user.click(within(f).getByRole('button', { name: 'Send options' }));
    const pop = await screen.findByRole('dialog', { name: 'Schedule send' });
    await user.click(within(pop).getByRole('button', { name: /Tomorrow morning/ }));
    await user.click(within(pop).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(where()).toBe('/email?folder=scheduled'));
    const sent = api.of('/api/mail/drafts/50/send')[0]!.body!;
    expect(sent).toMatchObject({ to: ['ana@acme.com'], followUp: null });
    expect(typeof sent.at).toBe('string');
  });

  it('a Projects-list link ?compose=1&company=&lead=&project= opens the page with lead and project', async () => {
    const api = stub();
    show(['/projects', '/email?compose=1&company=4&lead=5&project=3']);
    const f = await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50&company=4'));
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'new', leadId: 5, projectId: 3 }]);
    expect(await within(f).findByRole('button', { name: 'LD-1005 · Meridian Textiles · Contacted' })).toBeInTheDocument();
    await waitFor(() => expect(within(f).getByRole('combobox', { name: 'Project' })).toHaveValue('3'));
    // To: the lead's contact; Cc: the project's stakeholders with an email, not the To address.
    await waitFor(() => expect(within(f).getByText('ben@meridian.com')).toBeInTheDocument());
    expect(within(f).getAllByText('tom@meridian.com')).toHaveLength(1);
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({ to: ['tom@meridian.com'], cc: ['ben@meridian.com'], leadId: 5, projectId: 3 }), { timeout: 4000 });
  });

  it('a link with a project and no lead keeps the project for a lead of its client', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email', '/email?compose=1&company=4&project=3']);
    const f = await form();
    expect(api.of('/api/mail/drafts').map((c) => c.body)).toEqual([{ kind: 'new' }]);
    const project = await within(f).findByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(project).toHaveValue('3'));
    expect(project).toBeDisabled();
    await user.click(within(f).getByRole('button', { name: 'Choose a lead' }));
    await user.click(await within(await screen.findByRole('menu', { name: 'Choose a lead' })).findByRole('menuitem', { name: /LD-1005/ }));
    await waitFor(() => expect(project).toBeEnabled());
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'PATCH').at(-1)?.body).toMatchObject({ leadId: 5, projectId: 3 }));
  });

  it('browser Back from the page returns to the inbox; the untouched draft is discarded', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email']);
    await user.click(await screen.findByRole('button', { name: 'New mail' }));
    await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    await user.click(screen.getByRole('button', { name: 'Browser back' }));
    await waitFor(() => expect(where()).toBe('/email'));
    expect(await screen.findByRole('region', { name: 'Message list' })).toBeInTheDocument();
    await waitFor(() => expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(1));
  });

  it('Back to Inbox saves the draft first', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email', '/email/new']);
    const f = await form();
    await user.type(within(f).getByRole('textbox', { name: 'Subject' }), 'Kept');
    await user.click(screen.getByRole('link', { name: '← Back to Inbox' }));
    await waitFor(() => expect(where()).toBe('/email'));
    expect(api.of('/api/mail/drafts/50', 'PATCH')[0]!.body).toMatchObject({ subject: 'Kept' });
    expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(0);
  });

  it('Back to Inbox with a failed save keeps the page and says why; Close without saving then leaves', async () => {
    const user = userEvent.setup();
    stub({ saveErrors: ['mailbox_changed', 'mailbox_changed'] });
    show(['/email', '/email/new']);
    const f = await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    await user.type(within(f).getByRole('textbox', { name: 'Subject' }), 'Not lost');
    await user.click(screen.getByRole('link', { name: '← Back to Inbox' }));
    expect(await within(f).findByRole('alert')).toHaveTextContent('This draft is in a mailbox that is no longer connected. Open it in Outlook.');
    expect(where()).toBe('/email/new?draft=50');
    await user.click(within(f).getByRole('button', { name: 'Close without saving' }));
    await waitFor(() => expect(where()).toBe('/email'));
  });

  it('Discard deletes the draft and goes back', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email?folder=drafts', '/email/new']);
    const f = await form();
    await user.click(within(f).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(where()).toBe('/email?folder=drafts'));
    expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(1);
  });

  it('Discard on a page opened directly (the tab\'s first entry) goes to the inbox, not out of the CRM', async () => {
    const user = userEvent.setup();
    const api = stub();
    show(['/email/new']);
    const f = await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    await user.click(within(f).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(where()).toBe('/email'));
    expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(1);
  });

  it("another user's draft id (403 view_only) says so, not that the draft is gone", async () => {
    stub({ openError: { status: 403, code: 'view_only' } });
    show(['/email/new?draft=77']);
    expect(await screen.findByText('View only: only the mailbox owner can do this.')).toBeInTheDocument();
    expect(screen.queryByText('This draft no longer exists. It may have been sent or deleted.')).toBeNull();
    await waitFor(() => expect(where()).toBe('/email'));
  });

  it('the sidebar while a change is unsaved: the draft is saved first, then the page goes', async () => {
    const user = userEvent.setup();
    const api = stub();
    showApp(['/email', '/email/new']);
    const f = await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    await user.type(within(f).getByRole('textbox', { name: 'Subject' }), 'Kept');
    await user.click(screen.getByRole('link', { name: 'Sidebar Leads' }));
    await waitFor(() => expect(where()).toBe('/leads'));
    expect(api.of('/api/mail/drafts/50', 'PATCH')).toHaveLength(1);
    expect(api.of('/api/mail/drafts/50', 'PATCH')[0]!.body).toMatchObject({ subject: 'Kept' });
    expect(api.of('/api/mail/drafts/50', 'DELETE')).toHaveLength(0);
  });

  it('the sidebar with a failed save keeps the page and says why; Close without saving then goes', async () => {
    const user = userEvent.setup();
    stub({ saveErrors: ['mailbox_changed', 'mailbox_changed'] });
    showApp(['/email', '/email/new']);
    const f = await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    await user.type(within(f).getByRole('textbox', { name: 'Subject' }), 'Not lost');
    await user.click(screen.getByRole('link', { name: 'Sidebar Leads' }));
    expect(await within(f).findByRole('alert')).toHaveTextContent('This draft is in a mailbox that is no longer connected. Open it in Outlook.');
    expect(where()).toBe('/email/new?draft=50');
    expect(within(f).getByRole('textbox', { name: 'Subject' })).toHaveValue('Not lost');
    await user.click(within(f).getByRole('button', { name: 'Close without saving' }));
    await waitFor(() => expect(where()).toBe('/leads'));
  });

  it('browser Back while a change is unsaved saves first; with nothing unsaved it goes at once', async () => {
    const user = userEvent.setup();
    const api = stub();
    const router = showApp(['/email', '/email/new']);
    const f = await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=50'));
    await user.type(within(f).getByRole('textbox', { name: 'Subject' }), 'Back');
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => expect(where()).toBe('/email'));
    expect(api.of('/api/mail/drafts/50', 'PATCH')[0]!.body).toMatchObject({ subject: 'Back' });
    // A new message left untouched: nothing to save, it goes straight away and the empty draft is discarded.
    await user.click(await screen.findByRole('button', { name: 'New mail' }));
    await form();
    await waitFor(() => expect(where()).toBe('/email/new?draft=51'));
    await user.click(screen.getByRole('link', { name: 'Sidebar Leads' }));
    await waitFor(() => expect(where()).toBe('/leads'));
    expect(api.of('/api/mail/drafts/51', 'PATCH')).toHaveLength(0);
    await waitFor(() => expect(api.of('/api/mail/drafts/51', 'DELETE')).toHaveLength(1));
  });

  it('?draft= opens an existing draft (Pop out, Continue editing) without making one', async () => {
    const api = stub({ drafts: { 60: draftView({ id: 60, subject: 'Re: Proposal', leadId: 5, lead: PANEL }) } });
    show(['/email/1', '/email/new?draft=60']);
    const f = await form();
    expect(within(f).getByRole('textbox', { name: 'Subject' })).toHaveValue('Re: Proposal');
    expect(within(f).getByText('Maria Gómez')).toBeInTheDocument();
    expect(await within(f).findByRole('button', { name: 'LD-1005 · Meridian Textiles · Contacted' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Chosen lead' })).toHaveTextContent('USD 36,000.00');
    expect(api.of('/api/mail/drafts')).toHaveLength(0);
  });

  it('no mailbox to write in: the page says so and stays', async () => {
    stub({ createError: 'no_mailbox' });
    show(['/email', '/email/new?company=4&lead=5&project=3']);
    const p = await page();
    expect(await within(p).findByRole('alert')).toHaveTextContent(/mailbox/i);
    expect(where()).toBe('/email/new?company=4&lead=5&project=3');
    expect(within(p).queryByRole('form')).toBeNull();
  });

  it('a draft that no longer exists says so and goes to the inbox', async () => {
    stub();
    show(['/email/new?draft=99']);
    expect(await screen.findByText('This draft no longer exists. It may have been sent or deleted.')).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe('/email'));
  });
});
