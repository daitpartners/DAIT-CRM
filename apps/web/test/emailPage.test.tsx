import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
  companyId: null, hasAttachments: false, ...over,
});
const detail = (m: MailItem, over: Partial<MailDetail> = {}): MailDetail => ({
  ...m, ccAddresses: [], bodyText: 'Looks good', attachmentNames: [], loggedAt: null, lead: null, contact: null, company: null, thread: [], ...over,
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T09:00:00.000Z' },
  unread: 3, unlinked: 2, companies: [{ id: 4, name: 'Acme' }], leads: [{ id: 5, number: 'LD-1005', companyId: 4, companyName: 'Acme', status: 'New' }],
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
    if (url.startsWith('/api/mail?')) return Response.json({ items });
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
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveProperty('disabled', true);
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
        thread: [{ id: 8, occurredAt: '2026-11-19T10:00:00.000Z', direction: 'out', who: 'ana@acme.com', subject: 'Proposal' }],
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
    ], { 1: detail(item({ id: 1 })) });
    show('/email', london);
    const list = screen.getByRole('region', { name: 'Message list' });
    expect(await within(list).findByText('Today, 09:05')).toBeTruthy();
    expect(within(list).getByText('Yesterday, 17:00')).toBeTruthy();
    expect(within(list).getByText('01/11/2026, 08:00')).toBeTruthy();
  });

  it('synced line shows a relative time', async () => {
    at1200();
    stub([], {}, { ...META, mailbox: { ...META.mailbox!, lastSyncAt: '2026-11-22T11:55:00.000Z' } });
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

  it('link modal keeps the chosen lead when the search hides it', async () => {
    const u = userEvent.setup();
    const a = item();
    const posts = stub([a], { 1: detail(a) }, META, (url) => {
      if (!url.startsWith('/api/leads')) return undefined;
      const q = new URL(url, 'http://x').searchParams.get('q');
      // The first page shows LD-1 only; the search "zeta" finds LD-2 only.
      const items = q ? [leadRow(2, 'LD-2', { companyName: 'Zeta' })] : [leadRow(1, 'LD-1')];
      return { items, total: items.length, page: 1, pageSize: 25 };
    });
    show('/email/1');
    const reader = await screen.findByRole('article');
    await u.click(await within(reader).findByRole('button', { name: 'Link to lead / create lead' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link email to a lead' });
    const select = within(dialog).getByLabelText('Existing lead') as HTMLSelectElement;
    await within(dialog).findByRole('option', { name: 'LD-1 · Acme' });
    await u.selectOptions(select, '1');
    await u.type(within(dialog).getByLabelText('Find a lead'), 'zeta');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'LD-2 · Zeta' })).toBeTruthy());
    expect(select.value).toBe('1');
    expect(within(dialog).getByRole('option', { name: 'LD-1 · Acme' })).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/mail/1/link', body: { leadId: 1 } }]));
  });
});
