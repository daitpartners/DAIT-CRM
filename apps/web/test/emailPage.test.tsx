import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import type { MailDetail, MailItem, MailMeta } from '../src/api/mail';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import { keys, type Me } from '../src/api/queries';
import es from '../src/locales/es.json';
import { lookup, makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const me = { ...rep, rights: [...rep.rights, 'use_email' as const] };

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, folder: 'inbox', status: 'received', fromAddress: 'ana@acme.com', fromName: 'Ana Ruiz', toAddresses: ['arjun@daitpartners.com'],
  subject: 'Proposal', preview: 'Looks good', occurredAt: '2026-11-20T10:00:00.000Z', isRead: false, leadId: null, leadNumber: null,
  companyId: null, hasAttachments: false, projectId: null, projectNumber: null, ...over,
});
const detail = (m: MailItem, over: Partial<MailDetail> = {}): MailDetail => ({
  ...m, ccAddresses: [], bodyText: 'Looks good', attachmentNames: [], loggedAt: null, lead: null, contact: null, company: null, thread: [], ...over,
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T09:00:00.000Z' },
  unread: 3, unlinked: 2, companies: [{ id: 4, name: 'Acme', legalName: null, isClient: true }, { id: 6, name: 'Bolt', legalName: 'Bolt Industries Ltd', isClient: false }], leads: [{ id: 5, number: 'LD-1005', companyId: 4, companyName: 'Acme', status: 'New' }],
  projects: [{ id: 3, number: 'PRJ-3', name: 'Website rebuild', companyId: 4 }, { id: 8, number: 'PRJ-8', name: 'Brand refresh', companyId: 6 }],
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
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ id: 99, leadId: 5 }, { status: 201 });
    }
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (url === '/api/mail/meta') return Response.json(meta);
    const m = /^\/api\/mail\/(\d+)(\?peek=1)?$/.exec(url);
    if (m) return Response.json(details[Number(m[1])]);
    if (url.startsWith('/api/email-templates')) {
      return Response.json({ items: [{ id: 3, name: 'Intro', language: 'en', subject: 'Hello from {me}', body: 'Hi,\n{me}', sourceType: 'manual', fileName: null, fileSize: null, createdBy: null, createdAt: '', updatedAt: '' }] });
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

describe('Email screen (release 2B-2, prototype V.email)', () => {
  it('shows the mailbox, the folders with counts, smart views and templates', async () => {
    const a = item();
    stub([a, item({ id: 2, subject: 'Linked one', leadId: 5, leadNumber: 'LD-1005', isRead: true })], { 1: detail(a) });
    show();
    expect(await screen.findByText(/arjun@daitpartners.com · Microsoft 365/)).toBeTruthy();
    const folders = screen.getByRole('navigation', { name: 'Mail folders' });
    expect(within(folders).getByRole('link', { name: /Inbox\s*3/ })).toBeTruthy();
    expect(within(folders).getByRole('link', { name: /Unlinked\s*2/ })).toBeTruthy();
    for (const name of ['Sent', 'Drafts', 'Archive', 'Awaiting reply', 'My leads']) expect(within(folders).getByRole('link', { name })).toBeTruthy();
    expect(await within(folders).findByRole('button', { name: 'Intro' })).toBeTruthy();
    const list = screen.getByRole('region', { name: 'Message list' });
    expect(await within(list).findByText('Unlinked · create lead?')).toBeTruthy();
    expect(within(list).getByText('LD-1005')).toBeTruthy();
  });

  it('Project filter (release 3B): projects you can see, narrowed by the client; choosing one sets client and project and asks for them', async () => {
    const u = userEvent.setup();
    const asked: string[] = [];
    stub([item({ id: 2, leadId: 5, leadNumber: 'LD-1005', projectId: 3, projectNumber: 'PRJ-3' })], {}, META, (url) => {
      if (url.startsWith('/api/mail?')) asked.push(url);
      return undefined;
    });
    show('/email');
    const pick = screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
    expect(await within(pick).findByRole('option', { name: 'PRJ-8 · Brand refresh' })).toBeTruthy();
    expect(pick.disabled).toBe(false);
    expect(pick.selectedOptions[0]!.textContent).toBe('Project: all');
    // The message row carries its project tag (prototype badge b-ok).
    const list = screen.getByRole('region', { name: 'Message list' });
    expect((await within(list).findByText('PRJ-3')).className).toBe('badge b-ok');
    await u.selectOptions(pick, '3');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?project=3&company=4'));
    await waitFor(() => expect(asked.some((x) => x.includes('company=4') && x.includes('project=3'))).toBe(true));
    // Narrowed by the client now chosen; the Clear link drops the project too.
    expect(within(pick).queryByRole('option', { name: 'PRJ-8 · Brand refresh' })).toBeNull();
    expect(pick.selectedOptions[0]!.textContent).toBe('PRJ-3 · Website rebuild');
    expect(within(pick).getByRole('option', { name: 'Project: all for this client' })).toBeTruthy();
    await u.click(screen.getByRole('link', { name: '✕ Clear' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email'));
  });

  it('changing the client drops the project filter', async () => {
    const u = userEvent.setup();
    stub([], {});
    show('/email?company=4&project=3');
    const client = await screen.findByRole('combobox', { name: 'Client / company' });
    // Clients are marked as in the prototype ("name · client").
    await within(client).findByRole('option', { name: 'Acme · client' });
    // The legal name where set, as the prototype (legalName || name).
    expect(within(client).getByRole('option', { name: 'Bolt Industries Ltd' })).toBeTruthy();
    await u.selectOptions(client, '');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email'));
  });

  it('changing the lead drops the project filter (prototype fLead change)', async () => {
    const u = userEvent.setup();
    stub([], {});
    show('/email?company=4&project=3');
    const lead = await screen.findByRole('combobox', { name: 'Lead' });
    await within(lead).findByRole('option', { name: 'LD-1005 · Acme' });
    await u.selectOptions(lead, '5');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/email?company=4&lead=5'));
  });

  it('an unlinked message offers Link to lead / create lead; Log as activity waits for a lead', async () => {
    const a = item();
    stub([a], { 1: detail(a) });
    show('/email/1');
    const reader = await screen.findByRole('article');
    expect(await within(reader).findByRole('button', { name: 'Link to lead / create lead' })).toBeTruthy();
    expect(within(reader).getByRole('button', { name: 'Log as activity' })).toHaveProperty('disabled', true);
    expect(within(reader).getByRole('button', { name: 'Create lead from this email' })).toBeTruthy();
    expect(screen.getByText('No matching contact or lead. Link it to an existing lead or create one.')).toBeTruthy();
  });

  it('a linked message shows its records, logs on the lead and adds a follow-up task', async () => {
    const u = userEvent.setup();
    const a = item({ leadId: 5, leadNumber: 'LD-1005' });
    const posts = stub([a], {
      1: detail(a, {
        lead: { id: 5, number: 'LD-1005', status: 'Contacted', priority: 'High', nextFollowUp: '2026-11-25', companyId: 4 },
        contact: { id: 9, name: 'Ana Ruiz' }, company: { id: 4, name: 'Acme' },
        thread: [{ id: 8, occurredAt: '2026-11-19T10:00:00.000Z', direction: 'out', who: 'ana@acme.com', subject: 'Proposal', kind: 'sent', by: 'Arjun', unmatched: false }],
      }),
    });
    show('/email/1');
    const reader = await screen.findByRole('article');
    await waitFor(() => expect(within(reader).getByRole('button', { name: 'Log as activity' })).toHaveProperty('disabled', false));
    expect(screen.getByRole('link', { name: /Lead\s*LD-1005/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Company\s*Acme/ })).toBeTruthy();
    expect(screen.getByText(/Next follow-up on this lead/)).toBeTruthy();
    expect(within(reader).getByRole('button', { name: 'Create meeting' })).toHaveProperty('disabled', true);
    await u.click(within(reader).getByRole('button', { name: 'Log as activity' }));
    await u.click(within(reader).getByRole('button', { name: 'Add follow-up task' }));
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/api/mail/1/log', '/api/mail/1/task']));
  });

  it("the lead's next follow-up (a calendar date from the API) shows as a date in the Follow-up section", async () => {
    const a = item({ leadId: 5, leadNumber: 'LD-1005' });
    stub([a], { 1: detail(a, { lead: { id: 5, number: 'LD-1005', status: 'Contacted', priority: 'High', nextFollowUp: '2026-11-25', companyId: 4 } }) });
    show('/email/1');
    const line = await screen.findByText(/Next follow-up on this lead/);
    expect(line.querySelector('strong')?.textContent).toMatch(/25.*2026|2026.*25/);
  });

  it('a draft is view-only', async () => {
    const a = item({ folder: 'drafts', status: 'draft', isRead: true });
    stub([a], { 1: detail(a) });
    show('/email/1?folder=drafts');
    const reader = await screen.findByRole('article');
    expect(await within(reader).findByText('Drafts are edited in Outlook.')).toBeTruthy();
    expect(within(reader).queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('without a connected mailbox the header says so and links to Settings', async () => {
    stub([], {}, { ...META, mailbox: null, unread: 0, unlinked: 0 });
    show();
    expect(await screen.findByText('Mailbox not connected')).toBeTruthy();
    expect(await screen.findByText('Connect your mailbox to send and receive from the CRM.')).toBeTruthy();
    for (const link of screen.getAllByRole('link', { name: 'Connect Microsoft 365' })) expect(link.getAttribute('href')).toBe('/settings/connections');
    expect(await screen.findByText('Nothing here.')).toBeTruthy();
  });

  it('a template opens Compose filled in; Send posts it from your mailbox', async () => {
    const u = userEvent.setup();
    const posts = stub([], {});
    show();
    await u.click(await screen.findByRole('button', { name: 'Intro' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    expect((within(dialog).getByLabelText('Subject') as HTMLInputElement).value).toBe(`Hello from ${me.name}`);
    await u.type(within(dialog).getByLabelText('To'), 'ana@acme.com');
    await u.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts[0]).toMatchObject({ url: '/api/mail', body: { to: 'ana@acme.com', cc: [], subject: `Hello from ${me.name}` } }));
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
    // Prototype row: rel(e.at).replace(/, /, ' ').
    expect(await within(list).findByText('Today 09:05')).toBeTruthy();
    expect(within(list).getByText('Yesterday 17:00')).toBeTruthy();
    expect(within(list).getByText('01/11/2026 08:00')).toBeTruthy();
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
    expect(await within(list).findByText('Today 20:00')).toBeTruthy();
    expect(within(list).getByText('Today 00:30')).toBeTruthy();
    expect(within(list).getByText('Yesterday 01:30')).toBeTruthy();
  });

  it('synced line shows a relative time', async () => {
    at1200();
    stub([], {}, { ...META, mailbox: { ...META.mailbox!, lastSyncAt: '2026-11-22T11:55:00.000Z' } }, (url) => (url === '/api/me' ? london : undefined));
    show('/email', london);
    expect(await screen.findByText(/synced Today, 11:55/)).toBeTruthy();
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
      if (url === '/api/mail/meta') return opened ? { ...META, unread: 2 } : META;
      return undefined;
    });
    show();
    const list = screen.getByRole('region', { name: 'Message list' });
    const row = (await within(list).findByText('Unread one')).closest('a')!;
    expect(row.className).toMatch(/\bunread\b/);
    await u.click(row);
    await waitFor(() => expect(row.className).not.toMatch(/\bunread\b/));
    const folders = screen.getByRole('navigation', { name: 'Mail folders' });
    await waitFor(() => expect(within(folders).getByRole('link', { name: /Inbox\s*2/ })).toBeTruthy());
  });

  describe('pagination (owner, 22 Nov 2026)', () => {
    /** 120 inbox messages, served 50 a page like the API; records every list request. */
    function paged() {
      const all = Array.from({ length: 120 }, (_, i) => item({ id: i + 1, subject: `Message ${i + 1}`, isRead: true }));
      const lists: URLSearchParams[] = [];
      stub([], { 1: detail(all[0]!), 51: detail(all[50]!) }, META, (url) => {
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
    const where = () => screen.getByTestId('where').textContent;

    it('shows the pager under the list, the header counts the total, Next asks for page 2 and keeps it in the URL', async () => {
      const u = userEvent.setup();
      const lists = paged();
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      expect(within(list).getByText(/Inbox/).parentElement!.textContent).toMatch(/Inbox · 120/);
      expect(lists.at(-1)!.get('pageSize')).toBe('50');
      // The Leads / Companies pager: count, Rows, First / Prev / Page [n] of m / Next / Last.
      const pager = within(list).getByRole('navigation', { name: 'Pagination' });
      expect(within(pager).getByText('1–50 of 120')).toBeTruthy();
      expect((within(pager).getByRole('combobox', { name: 'Rows per page' }) as HTMLSelectElement).value).toBe('50');
      expect(within(pager).getAllByRole('option').map((o) => o.textContent)).toEqual(['25', '50', '100']);
      expect(within(pager).getByRole('button', { name: '« First' })).toHaveProperty('disabled', true);
      expect(within(pager).getByRole('button', { name: '‹ Prev' })).toHaveProperty('disabled', true);
      expect((within(pager).getByRole('spinbutton', { name: 'Go to page' }) as HTMLInputElement).value).toBe('1');
      expect(pager.textContent).toMatch(/Page\s*of 3/);
      expect(within(pager).getByRole('button', { name: 'Last »' })).toHaveProperty('disabled', false);
      await u.click(within(pager).getByRole('button', { name: 'Next ›' }));
      expect(await within(list).findByText('Message 51')).toBeTruthy();
      expect(lists.at(-1)!.get('page')).toBe('2');
      expect(where()).toBe('/email?page=2');
      // The first message of the current page is shown on arrival.
      expect(within(list).getByText('Message 51').closest('a')!.getAttribute('aria-current')).toBe('true');
      // Opening a message keeps the page.
      expect(within(list).getByText('Message 52').closest('a')!.getAttribute('href')).toBe('/email/52?page=2');
    });

    it('a folder, Client / Lead filter or search goes back to page 1', async () => {
      const u = userEvent.setup();
      const lists = paged();
      show('/email?page=3');
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 101')).toBeTruthy();
      expect(lists.at(-1)!.get('page')).toBe('3');
      const folders = screen.getByRole('navigation', { name: 'Mail folders' });
      expect(within(folders).getByRole('link', { name: 'Sent' }).getAttribute('href')).toBe('/email?folder=sent');
      await u.selectOptions(screen.getByRole('combobox', { name: 'Client / company' }), '4');
      await waitFor(() => expect(where()).toBe('/email?company=4'));
      await waitFor(() => expect(lists.at(-1)!.get('page')).toBeNull());
    });

    it('Last and First jump to the ends; Rows asks for that many and goes back to page 1, kept in the URL', async () => {
      const u = userEvent.setup();
      const lists = paged();
      show('/email?page=2');
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findByText('Message 51')).toBeTruthy();
      const pager = () => within(list).getByRole('navigation', { name: 'Pagination' });
      await u.click(within(pager()).getByRole('button', { name: 'Last »' }));
      expect(await within(list).findByText('Message 101')).toBeTruthy();
      expect(where()).toBe('/email?page=3');
      await u.click(within(pager()).getByRole('button', { name: '« First' }));
      expect(await within(list).findByText('Message 1')).toBeTruthy();
      expect(where()).toBe('/email');
      await u.click(within(pager()).getByRole('button', { name: 'Next ›' }));
      expect(await within(list).findByText('Message 51')).toBeTruthy();
      await u.selectOptions(within(pager()).getByRole('combobox', { name: 'Rows per page' }), '25');
      await waitFor(() => expect(where()).toBe('/email?size=25'));
      await waitFor(() => expect(within(pager()).getByText('1–25 of 120')).toBeTruthy());
      expect(lists.at(-1)!.get('pageSize')).toBe('25');
      expect(lists.at(-1)!.get('page')).toBeNull();
      // Back to the default: 50 leaves the URL.
      await u.selectOptions(within(pager()).getByRole('combobox', { name: 'Rows per page' }), '50');
      await waitFor(() => expect(where()).toBe('/email'));
    });

    it('a search goes back to page 1', async () => {
      const u = userEvent.setup();
      paged();
      show('/email?page=2');
      expect(await screen.findByText('Message 51')).toBeTruthy();
      await u.type(screen.getByRole('searchbox', { name: 'Search mail' }), 'quote{Enter}');
      await waitFor(() => expect(where()).toBe('/email?s=quote'));
    });

    it('a page past the end goes to the last page', async () => {
      paged();
      show('/email?page=9');
      expect(await screen.findByText('Message 101')).toBeTruthy();
      expect(where()).toBe('/email?page=3');
    });

    it('the pager shows even when everything fits on one page, as Leads; not for an empty list', async () => {
      const a = item();
      stub([a, item({ id: 2 })], { 1: detail(a) });
      show();
      const list = screen.getByRole('region', { name: 'Message list' });
      expect(await within(list).findAllByText('Proposal')).toHaveLength(2);
      expect(within(list).getByText(/Inbox/).parentElement!.textContent).toMatch(/Inbox · 2/);
      const pager = within(list).getByRole('navigation', { name: 'Pagination' });
      expect(within(pager).getByText('1–2 of 2')).toBeTruthy();
      expect(within(pager).getByRole('button', { name: 'Next ›' })).toHaveProperty('disabled', true);
    });

    it('no pager on an empty list', async () => {
      stub([], {});
      show();
      expect(await screen.findByText('Nothing here.')).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
    });

    it('opening an unread message on page 2 clears its bold at once', async () => {
      const u = userEvent.setup();
      const all = Array.from({ length: 60 }, (_, i) => item({ id: i + 1, subject: `Message ${i + 1}`, isRead: i !== 55 }));
      stub([], { 51: detail(all[50]!), 56: detail({ ...all[55]!, isRead: true }) }, META, (url) => {
        if (!url.startsWith('/api/mail?')) return undefined;
        const page = Number(new URL(url, 'http://x').searchParams.get('page') ?? 1);
        return { items: all.slice((page - 1) * 50, page * 50), total: 60, page, pageSize: 50 };
      });
      show('/email?page=2');
      const list = screen.getByRole('region', { name: 'Message list' });
      const row = (await within(list).findByText('Message 56')).closest('a')!;
      expect(row.className).toMatch(/\bunread\b/);
      await u.click(row);
      await waitFor(() => expect(row.className).not.toMatch(/\bunread\b/));
    });
  });

  it('compose lead option shows translated status and source', async () => {
    const u = userEvent.setup();
    const spanish: Me = { ...me, language: 'es' };
    stub([], {}, META, (url) => {
      if (url === '/api/me') return spanish;
      if (url.startsWith('/api/leads')) return { items: [leadRow(5, 'LD-1005', { status: 'Contacted', leadSource: 'Referral' })], total: 1, page: 1, pageSize: 100 };
      if (url.startsWith('/api/contacts')) {
        return {
          items: [{
            id: 9, companyId: 4, company: { id: 4, number: 'CO-0004', name: 'Acme' }, firstName: 'Ana', lastName: 'Ruiz', designation: null,
            department: null, businessEmail: 'ana@acme.com', phone: null, mobile: null, linkedinUrl: null, contactType: 'Decision Maker',
            isPrimary: true, isActive: true, updatedAt: '',
          }],
          total: 1, page: 1, pageSize: 100,
        };
      }
      return undefined;
    });
    show('/email?company=4', spanish, (qc) =>
      qc.setQueryData(keys.lookups, {
        lead_source: [{ ...lookup('lead_source', 'Referral', 2), labelEs: 'Recomendación' }],
        contact_type: [{ ...lookup('contact_type', 'Decision Maker', 3), labelEs: 'Decisor' }],
      }),
    );
    await u.click(await screen.findByRole('button', { name: es['+ Compose'] }));
    const dialog = await screen.findByRole('dialog', { name: es['Compose email'] });
    expect(await within(dialog).findByRole('option', { name: `LD-1005 · Recomendación · ${es['Contacted|lead']}` })).toBeTruthy();
    expect(await within(dialog).findByText(/· Decisor/)).toBeTruthy();
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
    const reader = await screen.findByRole('article');
    await u.click(await within(reader).findByRole('button', { name: 'Link to lead / create lead' }));
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
    const reader = await screen.findByRole('article');
    await u.click(await within(reader).findByRole('button', { name: 'Link to lead / create lead' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link email to a lead' });
    await u.type(within(dialog).getByRole('combobox', { name: 'Existing lead' }), 'zeta');
    await u.click(await within(dialog).findByRole('option', { name: 'LD-2 · Zeta' }));
    await u.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/mail/1/link', body: { leadId: 2 } }]));
  });

  it('a linked message without a contact still shows the Contact card with a dash', async () => {
    const a = item({ leadId: 5, leadNumber: 'LD-1005' });
    stub([a], {
      1: detail(a, { lead: { id: 5, number: 'LD-1005', status: 'New', priority: 'Medium', nextFollowUp: null, companyId: 4 }, contact: null, company: { id: 4, name: 'Acme' } }),
    });
    show('/email/1');
    const side = await screen.findByRole('complementary', { name: 'Linked records' });
    expect(await within(side).findByRole('link', { name: /Lead\s*LD-1005/ })).toBeTruthy();
    const contact = within(side).getByRole('link', { name: /Contact\s*—/ });
    expect(contact.getAttribute('href')).toBe('/companies/4?tab=contacts');
    expect(within(side).getByRole('link', { name: /Company\s*Acme/ })).toBeTruthy();
  });

  it('thread history lists the open message too, newest first, in the prototype wording', async () => {
    at1200();
    const a = item({ id: 1, leadId: 5, leadNumber: 'LD-1005', occurredAt: '2026-11-18T11:14:00.000Z' });
    stub([a], {
      1: detail(a, {
        lead: { id: 5, number: 'LD-1005', status: 'Contacted', priority: 'High', nextFollowUp: null, companyId: 4 },
        thread: [
          { id: 1, occurredAt: '2026-11-18T11:14:00.000Z', direction: 'in', who: 'Ana Ruiz', subject: 'Re: Proposal', kind: 'reply', by: null, unmatched: false },
          { id: 8, occurredAt: '2026-11-07T10:20:00.000Z', direction: 'out', who: 'ana@acme.com', subject: 'Proposal', kind: 'sent', by: 'Arjun', unmatched: false },
        ],
      }),
    }, META, (url) => (url === '/api/me' ? london : undefined));
    show('/email/1', london);
    const side = await screen.findByRole('complementary', { name: 'Linked records' });
    expect(await within(side).findByText('18 Nov 11:14 · reply received')).toBeTruthy();
    expect(within(side).getByText('07 Nov 10:20 · sent by Arjun')).toBeTruthy();
    expect(within(side).queryByText('No earlier messages.')).toBeNull();
  });

  it('your own open message reads plain "sent" (prototype E-6)', async () => {
    at1200();
    const a = item({ id: 1, folder: 'sent', status: 'sent', occurredAt: '2026-11-18T10:20:00.000Z' });
    stub([a], {
      1: detail(a, { thread: [{ id: 1, occurredAt: '2026-11-18T10:20:00.000Z', direction: 'out', who: 'ana@acme.com', subject: 'Proposal', kind: 'sent', by: null, unmatched: false }] }),
    }, META, (url) => (url === '/api/me' ? london : undefined));
    show('/email/1', london);
    const side = await screen.findByRole('complementary', { name: 'Linked records' });
    expect(await within(side).findByText('18 Nov 10:20 · sent')).toBeTruthy();
  });

  it('a single unmatched message shows its own history entry', async () => {
    at1200();
    const a = item({ id: 1, occurredAt: '2026-11-16T09:30:00.000Z' });
    stub([a], {
      1: detail(a, { thread: [{ id: 1, occurredAt: '2026-11-16T09:30:00.000Z', direction: 'in', who: 'Ana Ruiz', subject: 'Proposal', kind: 'received', by: null, unmatched: true }] }),
    }, META, (url) => (url === '/api/me' ? london : undefined));
    show('/email/1', london);
    const side = await screen.findByRole('complementary', { name: 'Linked records' });
    expect(await within(side).findByText('16 Nov 09:30 · received · no matching contact')).toBeTruthy();
  });

  it('thread history words are translated', async () => {
    at1200();
    const spanish: Me = { ...london, language: 'es' };
    const a = item({ id: 1, occurredAt: '2026-11-16T09:30:00.000Z' });
    stub([a], {
      1: detail(a, { thread: [{ id: 1, occurredAt: '2026-11-16T09:30:00.000Z', direction: 'out', who: 'ana@acme.com', subject: 'Proposal', kind: 'sent', by: 'Arjun', unmatched: true }] }),
    }, META, (url) => (url === '/api/me' ? spanish : undefined));
    show('/email/1', spanish);
    const side = await screen.findByRole('complementary', { name: es['Linked records'] });
    expect(await within(side).findByText(`16 nov 09:30 · ${es['sent by {who}'].replace('{who}', 'Arjun')}`)).toBeTruthy();
  });

  it('compose opens with the form visible: no field takes focus, the chosen client shows at once', async () => {
    const u = userEvent.setup();
    stub([], {});
    show('/email?company=4');
    await u.click(await screen.findByRole('button', { name: '+ Compose' }));
    const dialog = await screen.findByRole('dialog', { name: 'Compose email' });
    const client = within(dialog).getByRole('combobox', { name: 'Client' }) as HTMLInputElement;
    // The companies search answers nothing here: the name comes from the screen's own client filter.
    expect(client.value).toBe('Acme');
    expect(client.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(dialog);
    // "(stakeholders)" is a muted, normal-weight note in the Cc label, as in the prototype.
    expect(within(dialog).getByText('(stakeholders)').className).toBe('lbl-note');
  });
});
