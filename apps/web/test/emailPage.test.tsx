import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import { mergeHead, type MailPage } from '../src/api/mail';
import type { MailDetail, MailItem, MailMeta } from '../src/api/mail';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import { keys, type Me } from '../src/api/queries';
import es from '../src/locales/es.json';
import { draftView } from './draftFixture';
import { lookup, makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const me = { ...rep, rights: [...rep.rights, 'use_email' as const] };

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, owner: { id: 2, name: 'Arjun Mehta' }, viewOnly: false, leadRestricted: false, folder: 'inbox', status: 'received', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz', toAddresses: ['arjun@daitpartners.com'],
  subject: 'Proposal', preview: 'Looks good', occurredAt: '2026-11-20T10:00:00.000Z', isRead: false, leadId: null, leadNumber: null,
  companyId: null, hasAttachments: false, projectId: null, projectNumber: null,
  flagStatus: 'notFlagged', flagDue: null, replied: false, conversationCount: 1, leadStatus: null, scheduledAt: null, ...over,
});
type ThreadEntry = MailDetail['thread'][number];
/** A thread entry with release 1's fields; the reading pane's (web-mail release 2) default to an empty message. */
type ThreadIn = Omit<ThreadEntry, 'fromName' | 'fromAddress' | 'toAddresses' | 'ccAddresses' | 'preview' | 'hasAttachments' | 'folder' | 'isRead'> & Partial<ThreadEntry>;
const detail = (m: MailItem, over: Omit<Partial<MailDetail>, 'thread'> & { thread?: ThreadIn[] } = {}): MailDetail => ({
  ...m, replyToId: null, lastError: null, ccAddresses: [], bodyText: 'Looks good', bodyHtml: null, attachmentNames: [], loggedAt: null, lead: null, contact: null, company: null, restrictedLead: null,
  leadPanel: null, ...over,
  thread: (over.thread ?? []).map((t) => ({
    fromName: null, fromAddress: '', toAddresses: [], ccAddresses: [], preview: '', hasAttachments: false, folder: 'inbox', isRead: true, ...t,
  })),
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T09:00:00.000Z' },
  unread: 3, counts: { inbox: 3, drafts: 2, scheduled: 1, flagged: 4, awaiting: 6, due: 3, leads: 58 },
  leadOwners: [{ id: 2, name: 'Arjun Mehta' }, { id: 9, name: 'Carlos Torres' }, { id: 11, name: 'Lakshita Singh' }], companies: [{ id: 4, name: 'Acme', legalName: null, isClient: true }, { id: 6, name: 'Bolt', legalName: 'Bolt Industries Ltd', isClient: false }], leads: [{ id: 5, number: 'LD-1005', companyId: 4, companyName: 'Acme', status: 'New' }],
  projects: [{ id: 3, number: 'PRJ-3', name: 'Website rebuild', companyId: 4 }, { id: 8, number: 'PRJ-8', name: 'Brand refresh', companyId: 6 }],
  mailUsers: [],
};

/** `extra` answers a GET first (stateful or filtered responses); anything it leaves undefined falls through. */
function stub(items: MailItem[], details: Record<number, MailDetail>, meta: MailMeta = META, extra?: (url: string) => unknown) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST' && extra) {
      const r = extra(url);
      if (r !== undefined) return Response.json(r);
    }
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ url, body });
      // A new draft (the New message page) answers as a draft; anything else as before.
      if (url === '/api/mail/drafts') return Response.json({ ...DRAFT, leadId: body?.leadId ?? null, projectId: body?.projectId ?? null }, { status: 201 });
      return Response.json({ id: 99, leadId: 5 }, { status: 201 });
    }
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (url === '/api/mail/meta' || url.startsWith('/api/mail/meta?')) return Response.json(meta);
    if (/^\/api\/mail\/\d+\/lead-suggestions$/.test(url)) return Response.json({ items: [] });
    const m = /^\/api\/mail\/(\d+)(\?peek=1)?$/.exec(url);
    if (m) return Response.json(details[Number(m[1])]);
    if (url.startsWith('/api/email-templates')) {
      return Response.json({ items: [{ id: 3, name: 'Intro', language: 'en', subject: 'Hello from {me}', body: 'Hi,\n{me}', sourceType: 'manual', fileName: null, fileSize: null, attachments: [], createdBy: null, createdAt: '', updatedAt: '' }] });
    }
    if (url === '/api/me') return Response.json(me);
    if (url.startsWith('/api/leads') || url.startsWith('/api/contacts') || url.startsWith('/api/companies')) return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
    return Response.json({});
  }));
  return posts;
}

/** The current address, for asserting what the screen put in the URL. */
function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

function show(path = '/email', user: Me = me, setup?: (qc: ReturnType<typeof makeClient>) => void) {
  const qc = makeClient(user);
  setup?.(qc);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/email" element={<EmailPage />} />
                <Route path="/email/new" element={<EmailPage />} />
                <Route path="/email/:id" element={<EmailPage />} />
              </Routes>
              <Where />
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Link email to a lead (web-mail release 2): the command bar's Link to lead ▾, then Create lead from this email…. */
async function openLinkModal(u: ReturnType<typeof userEvent.setup>) {
  const bar = await screen.findByRole('toolbar', { name: 'Mail commands' });
  const link = within(bar).getByRole('button', { name: 'Link to lead' });
  await waitFor(() => expect(link).toBeEnabled());
  await u.click(link);
  const menu = await screen.findByRole('menu', { name: 'Link to lead' });
  await u.click(within(menu).getByRole('menuitem', { name: 'Create lead from this email…' }));
}

/** A Europe/London user at 2026-11-22 12:00 (only Date is faked: timers stay real for the queries). */
const london: Me = { ...me, timezone: 'Europe/London' };
function at1200() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
}

const leadRow = (id: number, number: string, over: Record<string, unknown> = {}) => ({
  id, number, leadType: 'Lead', companyName: 'Acme', companyId: 4, company: { id: 4, number: 'CO-0004', name: 'Acme' }, contact: null,
  country: 'India', outreachLanguage: 'en', city: null, leadSource: 'Referral', status: 'New', priority: 'Medium', assignedTo: null,
  nextFollowUp: null, isOverdue: false, archivedAt: null, createdAt: '', updatedAt: '', ...over,
});

/** A new draft as the drafts API answers it (the New message page). */
const DRAFT = draftView({ id: 99, replyToId: null, to: [], subject: '', quotedHtml: null, leadId: null, lead: null });

describe('Email screen (release 2B-2, prototype V.email)', () => {
  it('folder pane: mockup folders with counts, the Leads group, no Unlinked, no Templates list', async () => {
    const a = item();
    stub([a, item({ id: 2, subject: 'Linked one', leadId: 5, leadNumber: 'LD-1005', isRead: true })], { 1: detail(a) });
    show();
    const pane = await screen.findByRole('navigation', { name: 'Mail folders' });
    await waitFor(() => expect(within(pane).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Inbox3', 'Sent items', 'Drafts2', 'Scheduled1', 'Flagged4', 'Archive', 'Deleted items', 'Awaiting reply6', 'Follow-up due today3', 'My leads58',
    ]));
    expect(within(pane).getByText('Leads', { selector: '.fsec' })).toBeInTheDocument();
    // Muted and hot counts as the mockup; Inbox's unread count is the plain purple one.
    const count = (name: RegExp) => within(pane).getByRole('link', { name }).querySelector('.n')!.className;
    expect([count(/Inbox/), count(/Drafts/), count(/Scheduled/), count(/Flagged/), count(/Awaiting reply/), count(/Follow-up due today/), count(/My leads/)])
      .toEqual(['n', 'n mute', 'n mute', 'n mute', 'n mute', 'n hot', 'n mute']);
    expect(within(pane).getByRole('link', { name: /Inbox/ })).toHaveAttribute('aria-current', 'page');
    // Web-mail release 2: no Unlinked folder (spec non-goal), no Smart views heading, no template list.
    expect(within(pane).queryByText('Unlinked')).toBeNull();
    expect(within(pane).queryByText('Smart views')).toBeNull();
    expect(within(pane).queryByText('Templates')).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Intro' })).toBeNull();
    expect(within(pane).queryByRole('link', { name: 'Manage templates…' })).toBeNull();
    // "Show mail for" left the screen.
    expect(screen.queryByText('Show mail for')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Client / company' })).toBeNull();
    const list = screen.getByRole('region', { name: 'Message list' });
    expect(await within(list).findByText('LD-1005')).toBeTruthy();
    // A Leads view opens from its link.
    await userEvent.setup().click(within(pane).getByRole('link', { name: /Follow-up due today/ }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?folder=due'));
    expect(list).toHaveTextContent(/^Follow-up due today/);
  });

  it('team view names the Leads view Team leads', async () => {
    stub([], {}, TEAM_META, asAdmin);
    show('/email?mailof=all&folder=mine', admin);
    const pane = await screen.findByRole('navigation', { name: 'Mail folders' });
    await waitFor(() => expect(within(pane).getAllByRole('link').map((l) => l.textContent)).toContain('Team leads58'));
    expect(within(pane).getByRole('link', { name: /^Team leads/ })).toHaveAttribute('aria-current', 'page');
    expect(within(pane).queryByRole('link', { name: /My leads/ })).toBeNull();
    expect(screen.getByRole('region', { name: 'Message list' })).toHaveTextContent(/^Team leads/);
  });

  it('top bar sub line ends "lead mail only"; Sync now as before', async () => {
    const u = userEvent.setup();
    const posts = stub([], {});
    show();
    const sub = await screen.findByText(/arjun@daitpartners.com · Microsoft 365/);
    expect(sub.textContent).toMatch(/· synced .+ · lead mail only$/);
    expect(screen.queryByText(/every thread links to a Lead/)).toBeNull();
    const sync = screen.getByRole('button', { name: 'Sync now' });
    expect(sync).toHaveAttribute('title', 'Fetch new lead mail now');
    await u.click(sync);
    await waitFor(() => expect(posts.map((p) => p.url)).toContain('/api/mailboxes/7/sync'));
    expect(await screen.findByText('Sync started — new mail appears in a few seconds')).toBeInTheDocument();
  });

  it('Search lead mail submits s; Esc closes the panel', async () => {
    const u = userEvent.setup();
    const asked: string[] = [];
    stub([], {}, META, (url) => {
      asked.push(url);
      return undefined;
    });
    show('/email?folder=sent');
    const search = within(screen.getByRole('search')).getByRole('searchbox', { name: 'Search lead mail' });
    expect(search).toHaveAttribute('placeholder', 'Search lead mail');
    await u.type(search, 'website{Enter}');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?folder=sent&s=website'));
    const lastListUrl = () => asked.filter((x) => x.startsWith('/api/mail?')).at(-1) ?? '';
    await waitFor(() => expect(new URL(lastListUrl(), 'http://x').searchParams.get('s')).toBe('website'));
    const filters = screen.getByRole('button', { name: 'Filters' });
    expect(filters).toHaveAttribute('aria-expanded', 'false');
    expect(filters).toHaveAttribute('aria-controls', 'mail-filters');
    await u.click(filters);
    expect(filters).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('mail-filters')).toBeInTheDocument();
    await u.keyboard('{Escape}');
    expect(document.getElementById('mail-filters')).toBeNull();
    expect(filters).toHaveAttribute('aria-expanded', 'false');
    // A click outside closes it too.
    await u.click(filters);
    await u.click(screen.getByRole('region', { name: 'Message list' }));
    expect(document.getElementById('mail-filters')).toBeNull();
  });

  it('Filters panel: From, To, Subject, Lead, Owner, Date, Has attachments; Search puts them in the address and the request', async () => {
    const u = userEvent.setup();
    const asked: string[] = [];
    stub([], {}, META, (url) => {
      asked.push(url);
      return undefined;
    });
    show();
    await u.click(screen.getByRole('button', { name: 'Filters' }));
    const panel = document.getElementById('mail-filters') as HTMLElement;
    expect(within(panel).getByLabelText('From')).toHaveAttribute('placeholder', 'Name or address');
    expect(within(panel).getByLabelText('To')).toHaveAttribute('placeholder', 'Name or address');
    expect(within(panel).getByLabelText('Subject')).toHaveAttribute('placeholder', 'Words in the subject');
    expect(within(panel).getByLabelText('Lead')).toHaveAttribute('placeholder', 'LD number or company');
    // The list API refuses more than 200 characters in each text field.
    for (const name of ['From', 'To', 'Subject', 'Lead']) expect(within(panel).getByLabelText(name)).toHaveAttribute('maxLength', '200');
    // Owner = the lead's owner: Anyone, Me, then the other users.
    await waitFor(() => expect(within(within(panel).getByLabelText('Owner')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Anyone', 'Me', 'Carlos Torres', 'Lakshita Singh']));
    expect(within(within(panel).getByLabelText('Date')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Any time', 'Today', 'Last 7 days', 'Last 30 days', 'Last 12 months', 'Custom range…']);
    await u.type(screen.getByLabelText('From'), 'maria');
    await u.type(screen.getByLabelText('To'), 'ana');
    await u.type(screen.getByLabelText('Subject'), 'quote');
    await u.type(screen.getByLabelText('Lead'), 'LD-1005');
    await u.selectOptions(screen.getByLabelText('Owner'), 'Carlos Torres');
    await u.selectOptions(screen.getByLabelText('Date'), 'Last 7 days');
    await u.click(screen.getByRole('checkbox', { name: 'Has attachments' }));
    await u.click(screen.getByRole('button', { name: 'Search' }));
    expect(document.getElementById('mail-filters')).toBeNull();
    const where = new URL(screen.getByTestId('where').textContent!, 'http://x').searchParams;
    expect(Object.fromEntries(where)).toEqual({ from: 'maria', to: 'ana', subject: 'quote', leadq: 'LD-1005', owner: '9', date: '7d', att: '1' });
    const lastListUrl = () => asked.filter((x) => x.startsWith('/api/mail?')).at(-1) ?? '';
    await waitFor(() => expect(new URL(lastListUrl(), 'http://x').searchParams.get('from')).toBe('maria'));
    const q = new URL(lastListUrl(), 'http://x').searchParams;
    expect(q.get('from')).toBe('maria');
    expect(q.get('to')).toBe('ana');
    expect(q.get('subject')).toBe('quote');
    expect(q.get('leadQ')).toBe('LD-1005');
    expect(q.get('owner')).toBe('9');
    expect(q.get('date')).toBe('7d');
    expect(q.get('attachments')).toBe('1');
    expect(q.has('since')).toBe(false);
    // Reopened, the panel shows what is applied; Owner Me goes as owner=me.
    await u.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByLabelText('From')).toHaveValue('maria');
    expect(screen.getByRole('checkbox', { name: 'Has attachments' })).toBeChecked();
    await u.selectOptions(screen.getByLabelText('Owner'), 'Me');
    await u.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(new URL(lastListUrl(), 'http://x').searchParams.get('owner')).toBe('me'));
  });

  it('Custom range shows two date inputs; Clear filters empties the panel and the address', async () => {
    const u = userEvent.setup();
    const asked: string[] = [];
    stub([], {}, META, (url) => {
      asked.push(url);
      return undefined;
    });
    show('/email?folder=archive&s=offer&from=maria&att=1');
    await u.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByLabelText('Start date')).toBeNull();
    await u.selectOptions(screen.getByLabelText('Date'), 'Custom range…');
    const since = screen.getByLabelText('Start date');
    const until = screen.getByLabelText('End date');
    expect(since).toHaveAttribute('type', 'date');
    expect(until).toHaveAttribute('type', 'date');
    await u.type(since, '2026-11-01');
    await u.type(until, '2026-11-20');
    await u.click(screen.getByRole('button', { name: 'Search' }));
    const lastListUrl = () => asked.filter((x) => x.startsWith('/api/mail?')).at(-1) ?? '';
    await waitFor(() => expect(new URL(lastListUrl(), 'http://x').searchParams.get('date')).toBe('custom'));
    const q = new URL(lastListUrl(), 'http://x').searchParams;
    expect([q.get('since'), q.get('until'), q.get('from'), q.get('s')]).toEqual(['2026-11-01', '2026-11-20', 'maria', 'offer']);
    expect(screen.getByTestId('where').textContent).toBe('/email?folder=archive&s=offer&from=maria&att=1&date=custom&since=2026-11-01&until=2026-11-20');
    // Clear filters: the panel's fields leave the address; the folder and the search box stay.
    await u.click(screen.getByRole('button', { name: 'Filters' }));
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?folder=archive&s=offer'));
    await waitFor(() => expect(new URL(lastListUrl(), 'http://x').searchParams.has('from')).toBe(false));
    await u.click(screen.getByRole('button', { name: 'Filters' }));
    for (const name of ['From', 'To', 'Subject', 'Lead']) expect(screen.getByLabelText(name)).toHaveValue('');
    expect(screen.getByLabelText('Owner')).toHaveValue('');
    expect(screen.getByLabelText('Date')).toHaveValue('');
    expect(screen.queryByLabelText('Start date')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Has attachments' })).not.toBeChecked();
  });

  it('a Projects-list link (?company=&project=) narrows the list and shows a removable chip', async () => {
    const u = userEvent.setup();
    const asked: string[] = [];
    stub([item({ id: 2, leadId: 5, leadNumber: 'LD-1005', projectId: 3, projectNumber: 'PRJ-3' })], {}, META, (url) => {
      asked.push(url);
      return undefined;
    });
    show('/email?company=4&project=3');
    const list = screen.getByRole('region', { name: 'Message list' });
    const chip = await within(list).findByRole('link', { name: 'Acme · PRJ-3 · Website rebuild ✕' });
    await waitFor(() => expect(asked.some((x) => x.startsWith('/api/mail?') && x.includes('company=4') && x.includes('project=3'))).toBe(true));
    // The row keeps its project tag (prototype badge b-ok).
    expect((await within(list).findByText('PRJ-3')).className).toBe('badge b-ok');
    await u.click(chip);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email'));
    expect(within(list).queryByRole('link', { name: /✕/ })).toBeNull();
    const lastListUrl = () => asked.filter((x) => x.startsWith('/api/mail?')).at(-1) ?? '';
    await waitFor(() => expect(new URL(lastListUrl(), 'http://x').searchParams.has('project')).toBe(false));
  });

  it('an unlinked message: the lead panel (folded below 1400 px) says No lead linked', async () => {
    const u = userEvent.setup();
    const a = item();
    stub([a], { 1: detail(a) });
    show('/email/1');
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await u.click(within(panel).getByRole('button', { name: 'Lead' }));
    expect(await within(panel).findByText('No lead linked')).toBeTruthy();
  });

  it('a linked message shows its lead in the lead panel', async () => {
    const u = userEvent.setup();
    const a = item({ leadId: 5, leadNumber: 'LD-1005' });
    stub([a], {
      1: detail(a, {
        lead: { id: 5, number: 'LD-1005', status: 'Contacted', priority: 'High', nextFollowUp: '2026-11-25', companyId: 4 },
        contact: { id: 9, name: 'Ana Ruiz' }, company: { id: 4, name: 'Acme' },
      }),
    });
    show('/email/1');
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await u.click(await within(panel).findByRole('button', { name: 'Lead · LD-1005' }));
    expect(await within(panel).findByText('Acme')).toBeTruthy();
    expect(within(panel).getByText('LD-1005')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open lead' }).getAttribute('href')).toBe('/leads/5');
  });

  it('without a connected mailbox the header says so and links to Settings', async () => {
    stub([], {}, { ...META, mailbox: null, unread: 0 });
    show();
    expect(await screen.findByText('Mailbox not connected')).toBeTruthy();
    expect(await screen.findByText('Connect your mailbox to send and receive from the CRM.')).toBeTruthy();
    for (const link of screen.getAllByRole('link', { name: 'Connect Microsoft 365' })) expect(link.getAttribute('href')).toBe('/settings/connections');
    expect(await screen.findByText('No lead mail matches this filter.')).toBeTruthy();
  });

  it('list row shows time of day for today', async () => {
    at1200();
    stub([
      item({ id: 1, occurredAt: '2026-11-22T09:05:00.000Z', isRead: true }),
      item({ id: 2, occurredAt: '2026-11-21T17:00:00.000Z', isRead: true }),
      item({ id: 3, occurredAt: '2026-11-01T08:00:00.000Z', isRead: true }),
    ], { 1: detail(item({ id: 1 })) }, META, (url) => (url === '/api/me' ? london : undefined));
    show('/email', london);
    const list = screen.getByRole('region', { name: 'Message list' });
    // Web-mail release 2 (mockup rows): 24-hour time today, "Yesterday 17:00", then the weekday and date.
    expect(await within(list).findByText('09:05')).toBeTruthy();
    expect(within(list).getByText('Yesterday 17:00')).toBeTruthy();
    expect(within(list).getByText('Sun 1 Nov')).toBeTruthy();
  });

  it('list row days and times follow the user time zone (Asia/Kolkata, UTC+5:30)', async () => {
    at1200();
    const kolkata: Me = { ...me, timezone: 'Asia/Kolkata' };
    stub([
      // 2026-11-22 20:00 in Kolkata is still "today" there (12:00Z is 17:30 local).
      item({ id: 1, occurredAt: '2026-11-22T14:30:00.000Z', isRead: true }),
      // 2026-11-21T19:00Z is 2026-11-22 00:30 in Kolkata: today there, yesterday in UTC.
      item({ id: 2, occurredAt: '2026-11-21T19:00:00.000Z', isRead: true }),
      // 2026-11-20T20:00Z is 2026-11-21 01:30 in Kolkata: yesterday.
      item({ id: 3, occurredAt: '2026-11-20T20:00:00.000Z', isRead: true }),
    ], { 1: detail(item({ id: 1 })) }, META, (url) => (url === '/api/me' ? kolkata : undefined));
    show('/email', kolkata);
    const list = screen.getByRole('region', { name: 'Message list' });
    expect(await within(list).findByText('20:00')).toBeTruthy();
    expect(within(list).getByText('00:30')).toBeTruthy();
    expect(within(list).getByText('Yesterday 01:30')).toBeTruthy();
  });

  it('synced line shows a relative time', async () => {
    at1200();
    stub([], {}, { ...META, mailbox: { ...META.mailbox!, lastSyncAt: '2026-11-22T11:55:00.000Z' } }, (url) => (url === '/api/me' ? london : undefined));
    show('/email', london);
    expect(await screen.findByText(/synced Today, 11:55/)).toBeTruthy();
  });

  it('a message opened from a link is not bold even when the list arrives after it', async () => {
    const a = item({ id: 7, subject: 'Unread one', isRead: false });
    stub([a], { 7: detail({ ...a, isRead: true }) });
    // The list (answered before the open marked it read) arrives only after the message itself.
    let opened!: () => void;
    const detailDone = new Promise<void>((r) => (opened = r));
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail?')) await detailDone;
      const res = await base(url, init);
      if (url === '/api/mail/7') setTimeout(opened, 0);
      return res;
    });
    show('/email/7');
    const list = screen.getByRole('region', { name: 'Message list' });
    const row = (await within(list).findByText('Unread one')).closest('.mrow')!;
    expect(row.className).not.toMatch(/\bunread\b/);
  });

  it('opening an unread message clears its bold at once', async () => {
    const u = userEvent.setup();
    const first = item({ id: 1, isRead: true });
    const a = item({ id: 7, subject: 'Unread one', isRead: false });
    let opened = false;
    // The list endpoint keeps answering "unread" (no refetch happened yet); the server's count drops once it is opened.
    stub([first, a], { 1: detail(first) }, META, (url) => {
      if (url === '/api/mail/7') {
        opened = true;
        return detail({ ...a, isRead: true });
      }
      if (url === '/api/mail/meta') return opened ? { ...META, unread: 2, counts: { ...META.counts, inbox: 2 } } : META;
      return undefined;
    });
    show();
    const list = screen.getByRole('region', { name: 'Message list' });
    const row = (await within(list).findByText('Unread one')).closest('.mrow')!;
    expect(row.className).toMatch(/\bunread\b/);
    await u.click(row.querySelector('a')!);
    await waitFor(() => expect(row.className).not.toMatch(/\bunread\b/));
    const folders = screen.getByRole('navigation', { name: 'Mail folders' });
    await waitFor(() => expect(within(folders).getByRole('link', { name: /Inbox\s*2/ })).toBeTruthy());
  });

  describe('no page numbers: the list loads more as it is scrolled (owner, 23 Nov 2026)', () => {
    /** 120 inbox messages, served 50 a batch like the API; records every list request. */
    function batched(total = 120) {
      const all = Array.from({ length: total }, (_, i) => item({ id: i + 1, subject: `Message ${i + 1}`, isRead: true }));
      const lists: URLSearchParams[] = [];
      stub([], Object.fromEntries(all.map((m) => [m.id, detail(m)])), META, (url) => {
        if (!url.startsWith('/api/mail?')) return undefined;
        const q = new URL(url, 'http://x').searchParams;
        lists.push(q);
        const page = Number(q.get('page') ?? 1);
        const size = Number(q.get('pageSize'));
        const rows = q.get('view') === 'inbox' ? all : [];
        return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page, pageSize: size };
      });
      return lists;
    }

    /** jsdom has no layout: an IntersectionObserver the test triggers (the list foot coming into view). */
    function watcher() {
      const watched: { cb: IntersectionObserverCallback; el: Element | null; root: Element | Document | null; alive: boolean }[] = [];
      vi.stubGlobal('IntersectionObserver', class {
        entry: (typeof watched)[number];
        constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
          this.entry = { cb, el: null, root: opts?.root ?? null, alive: true };
          watched.push(this.entry);
        }
        observe(el: Element) { this.entry.el = el; }
        disconnect() { this.entry.alive = false; }
        unobserve() {}
        takeRecords() { return []; }
      });
      return {
        /** The foot comes into view: the live observer fires. */
        reach: () => {
          const w = watched.filter((x) => x.alive && x.el).at(-1);
          if (!w) throw new Error('nothing is watching the list foot');
          act(() => w.cb([{ isIntersecting: true, target: w.el! } as IntersectionObserverEntry], {} as IntersectionObserver));
        },
        live: () => watched.filter((x) => x.alive && x.el),
        made: () => watched.length,
      };
    }
    const where = () => screen.getByTestId('where').textContent;

    it('shows the first 50 with the total and no pager; reaching the foot loads the next 50 under them, then the rest', async () => {
      const lists = batched();
      const w = watcher();
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      expect(within(list).getByRole('heading', { level: 2 }).parentElement!.textContent).toMatch(/^Inbox3 unread/);
      expect(within(list).queryByRole('navigation', { name: 'Pagination' })).toBeNull();
      expect(within(list).queryByRole('combobox')).toBeNull();
      expect(lists.at(-1)!.get('pageSize')).toBe('50');
      expect(lists.at(-1)!.get('page')).toBeNull();
      expect(within(list).queryByText('Message 51')).toBeNull();
      expect(within(list).getByRole('status').textContent).toBe('Loading…');
      w.reach();
      expect(await within(list).findByText('Message 51')).toBeTruthy();
      expect(lists.at(-1)!.get('page')).toBe('2');
      expect(within(list).getByText('Message 1')).toBeTruthy();
      expect(list.querySelectorAll('.mrow')).toHaveLength(100);
      w.reach();
      expect(await within(list).findByText('Message 120')).toBeTruthy();
      expect(list.querySelectorAll('.mrow')).toHaveLength(120);
      // Everything is loaded: no Loading… row, nothing watched.
      await waitFor(() => expect(within(list).queryByRole('status')).toBeNull());
      expect(w.live()).toHaveLength(0);
      // The address never carries a page.
      expect(where()).toBe('/email');
    });

    it('loading more keeps the open message, its selection and the filters', async () => {
      const u = userEvent.setup();
      const lists = batched();
      const w = watcher();
      show('/email?company=4&s=proposal');
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      await u.click(within(list).getByText('Message 3').closest('a')!);
      await waitFor(() => expect(where()).toBe('/email/3?company=4&s=proposal'));
      w.reach();
      expect(await within(list).findByText('Message 51')).toBeTruthy();
      expect(lists.at(-1)!.get('page')).toBe('2');
      expect(lists.at(-1)!.get('company')).toBe('4');
      expect(lists.at(-1)!.get('s')).toBe('proposal');
      expect(where()).toBe('/email/3?company=4&s=proposal');
      expect(within(list).getByText('Message 3').closest('a')!.getAttribute('aria-current')).toBe('true');
      expect(within(list).getByText('Message 52').closest('a')!.getAttribute('href')).toBe('/email/52?company=4&s=proposal');
    });

    it('opening an unread message from a later batch clears its bold at once', async () => {
      const u = userEvent.setup();
      const all = Array.from({ length: 60 }, (_, i) => item({ id: i + 1, subject: `Message ${i + 1}`, isRead: i !== 55 }));
      stub([], { 1: detail(all[0]!), 56: detail({ ...all[55]!, isRead: true }) }, META, (url) => {
        if (!url.startsWith('/api/mail?')) return undefined;
        const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? 1);
        return { items: all.slice((page - 1) * 50, page * 50), total: 60, page, pageSize: 50 };
      });
      const w = watcher();
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      w.reach();
      const row = (await within(list).findByText('Message 56')).closest('.mrow')!;
      expect(row.className).toMatch(/\bunread\b/);
      await u.click(row.querySelector('a')!);
      await waitFor(() => expect(row.className).not.toMatch(/\bunread\b/));
    });

    it('?page= and ?size= from old links are ignored and leave the address; the list starts from the top', async () => {
      const lists = batched();
      watcher();
      show('/email/5?page=3&size=25&folder=inbox');
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      await waitFor(() => expect(where()).toBe('/email/5?folder=inbox'));
      expect(lists.every((q) => q.get('page') === null && q.get('pageSize') === '50')).toBe(true);
      expect(within(list).getByText('Message 5').closest('a')!.getAttribute('aria-current')).toBe('true');
    });

    it('another folder or filter shows its list from the top', async () => {
      const u = userEvent.setup();
      batched();
      watcher();
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      const rows = list.querySelector('.msglist-rows') as HTMLElement;
      rows.scrollTop = 900;
      await u.type(screen.getByRole('searchbox', { name: 'Search lead mail' }), 'website{Enter}');
      await waitFor(() => expect(where()).toBe('/email?s=website'));
      await waitFor(() => expect(rows.scrollTop).toBe(0));
    });

    it('later batches are asked without a total (count=0); the first batch carries it', async () => {
      const lists = batched();
      const w = watcher();
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      expect(lists.at(-1)!.get('count')).toBeNull();
      w.reach();
      expect(await within(list).findByText('Message 51')).toBeTruthy();
      expect(lists.at(-1)!.get('count')).toBe('0');
      expect(within(list).getByRole('heading', { level: 2 }).parentElement!.textContent).toMatch(/^Inbox3 unread/);
    });

    it('the periodic refresh asks for the first batch only and merges it: new mail on top, the loaded rows kept', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const all = Array.from({ length: 120 }, (_, i) => item({ id: i + 1, subject: `Message ${i + 1}`, isRead: true, occurredAt: new Date(Date.UTC(2026, 10, 20, 12, 0) - i * 60_000).toISOString() }));
      let rows = all;
      const lists: URLSearchParams[] = [];
      stub([], { 1: detail(all[0]!), 500: detail(item({ id: 500 })) }, META, (url) => {
        if (!url.startsWith('/api/mail?')) return undefined;
        const q = new URL(url, 'http://x').searchParams;
        lists.push(q);
        const page = Number(q.get('page') ?? 1);
        return { items: rows.slice((page - 1) * 50, page * 50), total: q.get('count') === '0' ? null : rows.length, page, pageSize: 50 };
      });
      const w = watcher();
      show('/email/1');
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      w.reach();
      expect(await within(list).findByText('Message 100')).toBeTruthy();
      // New mail arrives, and Message 3 is archived elsewhere.
      rows = [item({ id: 500, subject: 'Brand new', occurredAt: '2026-11-20T13:00:00.000Z' }), ...all.filter((m) => m.id !== 3)];
      const before = lists.length;
      act(() => vi.advanceTimersByTime(60_000));
      expect(await within(list).findByText('Brand new')).toBeTruthy();
      const asked = lists.slice(before);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.get('page')).toBeNull();
      expect(within(list).queryByText('Message 3')).toBeNull();
      // Rows from the second batch are still there (51–100), Message 51 included, and the open message stays selected.
      expect(within(list).getByText('Message 51')).toBeTruthy();
      expect(within(list).getByText('Message 100')).toBeTruthy();
      expect(list.querySelectorAll('.mrow')).toHaveLength(100);
      expect(within(list).getByRole('heading', { level: 2 }).parentElement!.textContent).toMatch(/^Inbox3 unread/);
      expect(within(list).getByText('Message 1').closest('a')!.getAttribute('aria-current')).toBe('true');
    });

    it('repeated rows in a later batch (mail arrived meanwhile) do not stop the list early: distinct messages are counted', async () => {
      const all = Array.from({ length: 100 }, (_, i) => item({ id: i + 1, subject: `Message ${i + 1}`, isRead: true }));
      stub([], { 1: detail(all[0]!) }, META, (url) => {
        if (!url.startsWith('/api/mail?')) return undefined;
        const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? 1);
        // The second batch starts 5 rows early (they shifted down): 46–95, then 96–100.
        const items = page === 1 ? all.slice(0, 50) : page === 2 ? all.slice(45, 95) : all.slice(95);
        return { items, total: page === 1 ? 100 : null, page, pageSize: 50 };
      });
      const w = watcher();
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      w.reach();
      expect(await within(list).findByText('Message 95')).toBeTruthy();
      await waitFor(() => expect(w.live()).toHaveLength(1));
      w.reach();
      expect(await within(list).findByText('Message 100')).toBeTruthy();
      expect(list.querySelectorAll('.mrow')).toHaveLength(100);
    });

    it('the refresh is skipped while a batch is loading, and merges on the next tick', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const lists = batched();
      const w = watcher();
      const inner = globalThis.fetch;
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url.includes('page=2')) await gate;
        return inner(url, init);
      });
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      w.reach();
      await waitFor(() => expect(lists.some((q) => q.get('page') === '2')).toBe(false));
      const before = lists.length;
      act(() => vi.advanceTimersByTime(60_000));
      // Batch 2 is still loading: no refresh request went out.
      expect(lists.length).toBe(before);
      release();
      expect(await within(list).findByText('Message 51')).toBeTruthy();
      const after = lists.length;
      act(() => vi.advanceTimersByTime(60_000));
      await waitFor(() => expect(lists.length).toBe(after + 1));
      expect(lists.at(-1)!.get('page')).toBeNull();
      expect(within(list).getByText('Message 51')).toBeTruthy();
    });

    it('a filter change asks the new list\'s first batch once, and nothing is watched while the old rows stand in', async () => {
      const u = userEvent.setup();
      const lists = batched();
      const w = watcher();
      const inner = globalThis.fetch;
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url.includes('s=website')) await gate;
        return inner(url, init);
      });
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      await u.type(screen.getByRole('searchbox', { name: 'Search lead mail' }), 'website{Enter}');
      await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?s=website'));
      // The old inbox rows still show, but the foot is not watched.
      expect(within(list).getByText('Message 1')).toBeTruthy();
      expect(w.live()).toHaveLength(0);
      release();
      await waitFor(() => expect(lists.filter((q) => q.get('s') === 'website').length).toBeGreaterThan(0));
      await waitFor(() => expect(w.live()).toHaveLength(1));
      expect(lists.filter((q) => q.get('s') === 'website' && q.get('page') === null)).toHaveLength(1);
    });

    it('crossing the 1100 px breakpoint watches the list foot again (its scrolling box changes)', async () => {
      let listener: (() => void) | null = null;
      const media = { matches: true, addEventListener: (_: string, fn: () => void) => (listener = fn), removeEventListener: () => (listener = null) };
      vi.stubGlobal('matchMedia', () => media);
      batched();
      const w = watcher();
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      await waitFor(() => expect(w.live()).toHaveLength(1));
      const made = w.made();
      media.matches = false;
      act(() => listener!());
      await waitFor(() => expect(w.made()).toBeGreaterThan(made));
      expect(w.live()).toHaveLength(1);
    });

    it('a short list: the total in words outside the Inbox (which shows its unread count), no Loading… row; an empty one says so', async () => {
      const a = item({ folder: 'sent', status: 'sent' });
      stub([a], { 1: detail(a) });
      watcher();
      const { unmount } = show('/email?folder=sent');
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Proposal', { selector: '.rsubj' })).toBeTruthy();
      expect(within(list).getByRole('heading', { level: 2 }).parentElement!.textContent).toMatch(/^Sent items1 message/);
      expect(within(list).queryByRole('status')).toBeNull();
      unmount();
      stub([], {});
      show('/email?folder=sent');
      expect(await screen.findByText('No lead mail matches this filter.')).toBeTruthy();
      expect(screen.getByRole('region', { name: 'Message list' }).querySelector('.ml-head')!.textContent).toMatch(/^Sent items0 messages/);
    });
  });

  it('New message: the Lead picker shows each lead with its stage translated', async () => {
    const u = userEvent.setup();
    const spanish: Me = { ...me, language: 'es' };
    stub([], {}, META, (url) => {
      if (url === '/api/me') return spanish;
      if (url === '/api/mail/drafts/99') return DRAFT;
      if (url.startsWith('/api/leads?')) return { items: [leadRow(5, 'LD-1005', { status: 'Contacted' })], total: 1, page: 1, pageSize: 8 };
      return undefined;
    });
    show('/email/new?draft=99', spanish);
    const f = await screen.findByRole('form', { name: es['New message'] });
    await u.click(within(f).getByRole('button', { name: es['Choose a lead'] }));
    const menu = await screen.findByRole('menu', { name: es['Choose a lead'] });
    expect(await within(menu).findByRole('menuitem', { name: new RegExp(`^LD-1005 · Acme.*${es['Contacted|lead']}`) })).toBeTruthy();
  });
  it('link modal: one searchable Existing lead select (no separate search box) that keeps the chosen lead', async () => {
    const u = userEvent.setup();
    const a = item();
    const posts = stub([a], { 1: detail(a) }, META, (url) => {
      if (!url.startsWith('/api/leads')) return undefined;
      const q = new URL(url, 'http://x').searchParams.get('q');
      // The first page shows LD-1 only; the search "zeta" finds LD-2 only (server search, beyond the first page).
      const items = q ? [leadRow(2, 'LD-2', { companyName: 'Zeta' })] : [leadRow(1, 'LD-1')];
      return { items, total: items.length, page: 1, pageSize: 25 };
    });
    show('/email/1');
    await openLinkModal(u);
    const dialog = await screen.findByRole('dialog', { name: 'Link email to a lead' });
    expect(within(dialog).queryByLabelText('Find a lead')).toBeNull();
    const box = within(dialog).getByRole('combobox', { name: 'Existing lead' }) as HTMLInputElement;
    // Opens closed, like the prototype: the list stays shut and the box shows the "create" choice as its placeholder.
    expect(box.getAttribute('aria-expanded')).toBe('false');
    expect(box.placeholder).toBe('— create a new lead from this email —');
    await u.click(box);
    await u.click(await within(dialog).findByRole('option', { name: 'LD-1 · Acme' }));
    expect(box.value).toBe('LD-1 · Acme');
    await u.type(box, 'zeta');
    expect(await within(dialog).findByRole('option', { name: 'LD-2 · Zeta' })).toBeTruthy();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(box.value).toBe('LD-1 · Acme'));
    await u.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/mail/1/link', body: { leadId: 1 } }]));
  });

  it('link modal finds a lead by server search and links it', async () => {
    const u = userEvent.setup();
    const a = item();
    const posts = stub([a], { 1: detail(a) }, META, (url) => {
      if (!url.startsWith('/api/leads')) return undefined;
      const q = new URL(url, 'http://x').searchParams.get('q');
      const items = q ? [leadRow(2, 'LD-2', { companyName: 'Zeta' })] : [leadRow(1, 'LD-1')];
      return { items, total: items.length, page: 1, pageSize: 25 };
    });
    show('/email/1');
    await openLinkModal(u);
    const dialog = await screen.findByRole('dialog', { name: 'Link email to a lead' });
    await u.type(within(dialog).getByRole('combobox', { name: 'Existing lead' }), 'zeta');
    await u.click(await within(dialog).findByRole('option', { name: 'LD-2 · Zeta' }));
    await u.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/mail/1/link', body: { leadId: 2 } }]));
  });

  it('a linked message without a contact shows Contact "—" and keeps Add contact (the company\'s Contacts tab)', async () => {
    const u = userEvent.setup();
    const a = item({ leadId: 5, leadNumber: 'LD-1005' });
    stub([a], {
      1: detail(a, { lead: { id: 5, number: 'LD-1005', status: 'New', priority: 'Medium', nextFollowUp: null, companyId: 4 }, contact: null, company: { id: 4, name: 'Acme' } }),
    });
    show('/email/1');
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await u.click(await within(panel).findByRole('button', { name: 'Lead · LD-1005' }));
    const contact = (await within(panel).findByText('Contact', { selector: 'dt' })).nextElementSibling;
    expect(contact?.textContent).toBe('—');
    expect(within(panel).getByRole('link', { name: 'Add contact' }).getAttribute('href')).toBe('/companies/4?tab=contacts');
  });

  it('?compose=1 (the Projects list\'s Email buttons) opens the New message page with the link\'s lead and project, in place of the link', async () => {
    const posts = stub([], {}, META, (url) => (url === '/api/mail/drafts/99' ? { ...DRAFT, leadId: 5, projectId: 3 } : undefined));
    show('/email?compose=1&company=4&lead=5&project=3');
    expect(await screen.findByRole('region', { name: 'New message' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email/new?draft=99&company=4'));
    expect(posts).toContainEqual({ url: '/api/mail/drafts', body: { kind: 'new', leadId: 5, projectId: 3 } });
    expect(screen.queryByRole('toolbar', { name: 'Mail commands' })).toBeNull();
  });
  it('« folds the folders column to a strip and » opens it, keeping the folder and filters; remembered per browser', async () => {
    const u = userEvent.setup();
    localStorage.clear();
    stub([item()], {});
    const first = show('/email?folder=sent&company=4');
    const folders = screen.getByRole('navigation', { name: 'Mail folders' });
    const fold = within(folders).getByRole('button', { name: 'Collapse folder pane' });
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    // From the keyboard: the same button stays focused in both states (review M-3).
    fold.focus();
    await u.keyboard('{Enter}');
    expect(folders).toHaveClass('collapsed');
    expect(document.activeElement).toBe(within(folders).getByRole('button', { name: 'Expand folder pane' }));
    // Folded, the names and counts are hidden by CSS (wider screens only; a phone always shows the folders).
    expect(folders.querySelector('.fp-scroll')).toBeTruthy();
    expect(within(folders).getByRole('button', { name: 'Expand folder pane' })).toHaveAttribute('aria-expanded', 'false');
    // The list keeps the open folder and filter.
    expect(screen.getByTestId('where').textContent).toBe('/email?folder=sent&company=4');
    expect(within(screen.getByRole('region', { name: 'Message list' })).getByText('Sent items')).toBeTruthy();
    expect(localStorage.getItem('dait-mail-folders-collapsed')).toBe('1');
    first.unmount();

    show('/email?folder=sent');
    const again = screen.getByRole('navigation', { name: 'Mail folders' });
    expect(again).toHaveClass('collapsed');
    await u.click(within(again).getByRole('button', { name: 'Expand folder pane' }));
    expect(within(again).getByRole('link', { name: 'Sent items' })).toHaveAttribute('aria-current', 'page');
    expect(localStorage.getItem('dait-mail-folders-collapsed')).toBe('0');
  });
});

/** An Administrator (web-mail release 1): reads the team's lead mail, view only. */
const admin: Me = { ...me, id: 1, name: 'Maya Iyer', role: 'Administrator', rights: [...me.rights, 'view_team_mail' as const] };
const TEAM_META: MailMeta = { ...META, mailUsers: [{ id: 9, name: 'Carlos Torres' }] };
const carlos = { id: 9, name: 'Carlos Torres' };
/** The screen refetches the signed-in user: answer as the Administrator. */
const asAdmin = (url: string) => (url === '/api/me' ? admin : undefined);

describe('Email screen: team view (web-mail release 1, mockup state 5)', () => {
  it("Mail of picker (Administrator / Manager): Me, Everyone and each user; Everyone asks for mailOf=all and shows each row's mailbox", async () => {
    const u = userEvent.setup();
    const asked: string[] = [];
    const theirs = item({ id: 2, subject: 'Propuesta', owner: carlos, viewOnly: true, leadId: 5, leadNumber: 'LD-1005' });
    stub([item(), theirs], { 1: detail(item()) }, TEAM_META, (url) => {
      asked.push(url);
      return asAdmin(url);
    });
    show('/email', admin);
    const picker = await screen.findByRole('combobox', { name: 'Mail of:' });
    expect(picker).toHaveAttribute('title', 'Administrators and managers. Team mail is view only.');
    await waitFor(() => expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Me', 'Everyone', 'Carlos Torres']));
    // Me: your own mailbox, no mailOf asked.
    expect(asked.filter((x) => x.includes('mailOf'))).toEqual([]);
    await u.selectOptions(picker, 'Everyone');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?mailof=all'));
    const lastListUrl = () => asked.filter((x) => x.startsWith('/api/mail?')).at(-1) ?? '';
    await waitFor(() => expect(lastListUrl()).toContain('mailOf=all'));
    expect(asked).toContain('/api/mail/meta?mailOf=all');
    expect(await screen.findByText('Team view · lead mail of everyone')).toBeInTheDocument();
    expect(screen.getByText('View only', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByText(/for other mailboxes/)).toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Message list' });
    const row = within(list).getByRole('link', { name: /Propuesta/ });
    expect(row).toHaveTextContent("Carlos's mailbox");
    expect(within(list).getByRole('link', { name: /Proposal/ })).toHaveTextContent('Your mailbox');
    // One user's mail: the line names them.
    await u.selectOptions(picker, 'Carlos Torres');
    await waitFor(() => expect(lastListUrl()).toContain('mailOf=9'));
    expect(await screen.findByText('Team view · lead mail of Carlos Torres')).toBeInTheDocument();
  });

  it('no Mail of picker for a Sales rep, and no mailOf in its requests (an address mailof is ignored)', async () => {
    const asked: string[] = [];
    stub([item()], { 1: detail(item()) }, META, (url) => {
      asked.push(url);
      return undefined;
    });
    show('/email?mailof=all');
    expect(await screen.findByText(/arjun@daitpartners.com · Microsoft 365/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Mail of:' })).toBeNull();
    expect(screen.queryByText(/Team view/)).toBeNull();
    expect(asked.some((x) => x.startsWith('/api/mail'))).toBe(true);
    expect(asked.filter((x) => x.includes('mailOf'))).toEqual([]);
  });

  it("a message on another owner's lead: chip 'LD-1005 · another owner's lead', lead panel company name only, no lead link", async () => {
    const a = item({ leadRestricted: true, leadNumber: 'LD-1005' });
    stub([a], { 1: detail(a, { restrictedLead: { number: 'LD-1005', companyName: 'Acme' } }) });
    show('/email/1');
    const list = screen.getByRole('region', { name: 'Message list' });
    expect(await within(list).findByText("LD-1005 · another owner's lead")).toBeInTheDocument();
    expect(within(list).queryByText('Unlinked · create lead?')).toBeNull();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Lead · LD-1005' }));
    expect(await within(panel).findByText("LD-1005 · another owner's lead")).toBeInTheDocument();
    expect(within(panel).getByText('Acme')).toBeInTheDocument();
    expect(within(panel).queryAllByRole('link')).toEqual([]);
    expect(within(panel).queryByText('No lead linked')).toBeNull();
  });

  it('Deleted items folder; footer note with a Why? popover', async () => {
    const u = userEvent.setup();
    const asked: string[] = [];
    stub([], {}, META, (url) => {
      asked.push(url);
      return undefined;
    });
    show('/email');
    const folders = screen.getByRole('navigation', { name: 'Mail folders' });
    await u.click(within(folders).getByRole('link', { name: 'Deleted items' }));
    await waitFor(() => expect(asked.some((x) => x.startsWith('/api/mail?view=deleted'))).toBe(true));
    expect(screen.getByRole('region', { name: 'Message list' })).toHaveTextContent(/^Deleted items/);
    expect(within(folders).getByText(/Only mail with your leads and contacts is shown here/)).toBeInTheDocument();
    const why = within(folders).getByRole('button', { name: 'Why?' });
    expect(why).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('What the CRM keeps')).toBeNull();
    await u.click(why);
    expect(why).toHaveAttribute('aria-expanded', 'true');
    const pop = screen.getByText('What the CRM keeps').closest('.mail-why-pop') as HTMLElement;
    expect(within(pop).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      "Mail to and from your leads' and contacts' addresses.",
      "Mail from a lead company's own domain (not gmail.com, outlook.com and similar).",
      'The past 12 months are fetched when a lead is added.',
    ]);
    expect(pop).toHaveTextContent('Personal and other work mail stays in Outlook only.');
    await u.click(why);
    expect(screen.queryByText('What the CRM keeps')).toBeNull();
    // Escape and a click elsewhere close it too.
    await u.click(why);
    await u.keyboard('{Escape}');
    expect(screen.queryByText('What the CRM keeps')).toBeNull();
    await u.click(why);
    await u.click(screen.getByRole('region', { name: 'Message list' }));
    expect(screen.queryByText('What the CRM keeps')).toBeNull();
  });

  it('team view wording in Spanish', async () => {
    const spanish: Me = { ...admin, language: 'es' };
    const theirs = item({ id: 2, owner: carlos, viewOnly: true, leadId: 5, leadNumber: 'LD-1005' });
    stub([theirs], { 2: detail(theirs, { lead: { id: 5, number: 'LD-1005', status: 'Proposal', priority: 'High', nextFollowUp: null, companyId: 4 } }) }, TEAM_META,
      (url) => (url === '/api/me' ? spanish : undefined));
    show('/email/2?mailof=all', spanish);
    const picker = await screen.findByRole('combobox', { name: es['Mail of:'] });
    await waitFor(() => expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([es.Me, es.Everyone, 'Carlos Torres']));
    expect(await screen.findByText(es['Team view · lead mail of {who}'].replace('{who}', es.everyone))).toBeInTheDocument();
    const pane = await screen.findByRole('region', { name: es['Reading pane'] });
    expect(await within(pane).findByText(es["View only — {name}'s mailbox."].replace('{name}', 'Carlos'), { selector: '.viewonly strong' })).toBeInTheDocument();
    const bar = screen.getByRole('toolbar', { name: es['Mail commands'] });
    expect(within(bar).getByRole('button', { name: es.Reply })).toHaveAttribute('title', es["View only — {name}'s mailbox"].replace('{name}', 'Carlos'));
  });
});

describe('mergeHead (the list refresh, security review M5)', () => {
  const row = (id: number, minute: number) => item({ id, occurredAt: new Date(Date.UTC(2026, 10, 20, 12, minute)).toISOString() });
  const page = (items: MailItem[], n: number, total: number | null = 200): MailPage => ({ items, total, page: n, pageSize: 3 });

  it('replaces rows up to the fresh batch\'s last one, keeps older loaded rows, drops ones that left', () => {
    const data = { pages: [page([row(9, 9), row(8, 8), row(7, 7)], 1), page([row(6, 6), row(5, 5), row(4, 4)], 2, null)], pageParams: [1, 2] };
    // 10 arrived, 8 was archived: the fresh first batch is 10, 9, 7.
    const merged = mergeHead(data, page([row(10, 10), row(9, 9), row(7, 7)], 1, 199));
    expect(merged.pages.flatMap((p) => p.items.map((m) => m.id))).toEqual([10, 9, 7, 6, 5, 4]);
    expect(merged.pages[0]!.total).toBe(199);
    expect(merged.pageParams).toEqual([1, 2]);
  });

  it('rows pushed out of the first batch by new mail stay (they are older than its last row)', () => {
    const data = { pages: [page([row(9, 9), row(8, 8), row(7, 7)], 1)], pageParams: [1] };
    const merged = mergeHead(data, page([row(11, 11), row(10, 10), row(9, 9)], 1));
    expect(merged.pages[0]!.items.map((m) => m.id)).toEqual([11, 10, 9, 8, 7]);
  });

  it('a first batch that is the whole list leaves nothing else', () => {
    const data = { pages: [page([row(9, 9), row(8, 8), row(7, 7)], 1), page([row(6, 6)], 2, null)], pageParams: [1, 2] };
    const merged = mergeHead(data, { items: [row(9, 9)], total: 1, page: 1, pageSize: 50 });
    expect(merged.pages.flatMap((p) => p.items.map((m) => m.id))).toEqual([9]);
  });
});
