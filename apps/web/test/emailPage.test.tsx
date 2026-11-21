import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import type { MailDetail, MailItem, MailMeta } from '../src/api/mail';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

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

function stub(items: MailItem[], details: Record<number, MailDetail>, meta: MailMeta = META) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
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

function show(path = '/email') {
  const qc = makeClient(me);
  return render(
    <QueryClientProvider client={qc}>
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
    </QueryClientProvider>,
  );
}

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
});
