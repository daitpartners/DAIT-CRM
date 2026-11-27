import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EmailPage } from '../src/pages/email/EmailPage';
import type { LeadPanel, MailDetail, MailItem, MailMeta } from '../src/api/mail';
import type { Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { I18nProvider } from '../src/i18n';
import es from '../src/locales/es.json';
import { makeClient, rep } from './leadFixture';

const me: Me = { ...rep, timezone: 'Europe/London', dateFormat: 'DD MMM YYYY', rights: [...rep.rights, 'use_email' as const] };

/** The window's width when the screen mounts (the lead panel starts folded below 1400 px). */
function windowWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}
const startWidth = window.innerWidth;

beforeEach(() => {
  // A Europe/London user at Sunday 22 Nov 2026 12:00 (only Date is faked: timers stay real for the queries).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
  windowWidth(1440);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  windowWidth(startWidth);
});

const item = (over: Partial<MailItem> = {}): MailItem => ({
  id: 1, owner: { id: 2, name: 'Arjun Mehta' }, viewOnly: false, leadRestricted: false, folder: 'inbox', status: 'received',
  fromAddress: 'maria.gomez@acme-logistics.com', fromName: 'Maria Gómez', toAddresses: ['arjun@daitpartners.com'], subject: 'RFP-2026-118',
  preview: 'Please find attached', occurredAt: '2026-11-22T11:05:00.000Z', isRead: true, leadId: 5, leadNumber: 'LD-1178', companyId: 4,
  hasAttachments: false, projectId: null, projectNumber: null, flagStatus: 'notFlagged', flagDue: null, replied: false, conversationCount: 1,
  leadStatus: 'Contacted', scheduledAt: null, ...over,
});
const activity = (id: number, title: string, body: string | null, occurredAt: string) => ({
  id, leadId: 5, activityType: 'email', title, body, url: null, statusFrom: null, statusTo: null, relatedType: null, relatedId: null, by: null, occurredAt,
});
const PANEL: LeadPanel = {
  company: { id: 4, name: 'Acme Logistics', site: 'acme-logistics.com', place: 'Chicago, US' },
  contact: { name: 'Maria Gómez', role: 'Procurement Manager', email: 'maria.gomez@acme-logistics.com', phone: '+1 (312) 555-0148' },
  owner: 'Arjun Mehta',
  followUp: { date: '2026-11-22', time: '16:00', due: true },
  lastActivity: { title: 'Email received', occurredAt: '2026-11-22T11:05:00.000Z' },
  value: { amount: 48000, currency: 'USD' },
  recent: [
    activity(31, 'Email received', 'RFP-2026-118', '2026-11-22T11:05:00.000Z'),
    activity(30, 'Email sent by Arjun', 'Overview and next steps', '2026-11-19T10:12:00.000Z'),
    activity(29, 'Call logged', 'Discovery call, 32 min', '2026-11-17T16:00:00.000Z'),
  ] as unknown as LeadPanel['recent'],
  linkReason: { kind: 'domain', value: 'acme-logistics.com' },
};
const detail = (m: MailItem, over: Partial<MailDetail> = {}): MailDetail => ({
  ...m, replyToId: null, lastError: null, ccAddresses: [], bodyText: m.preview, bodyHtml: null, attachmentNames: [], loggedAt: null,
  lead: m.leadId ? { id: m.leadId, number: m.leadNumber ?? '', status: m.leadStatus ?? 'New', priority: 'High', nextFollowUp: '2026-11-22', companyId: 4 } : null,
  contact: null, company: m.leadId ? { id: 4, name: 'Acme Logistics' } : null, restrictedLead: null, leadPanel: m.leadId ? PANEL : null, thread: [], ...over,
});
const META: MailMeta = {
  mailbox: { id: 7, address: 'arjun@daitpartners.com', status: 'connected', lastSyncAt: '2026-11-22T09:00:00.000Z' },
  unread: 0, counts: { inbox: 0, drafts: 0, scheduled: 0, flagged: 0, awaiting: 0, due: 0, leads: 1 },
  companies: [], leads: [], projects: [], mailUsers: [], leadOwners: [],
};

function stub(items: MailItem[], details: Record<number, MailDetail>, user: Me = me) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ leadId: 5, nextFollowUp: '2026-11-23', taskId: 12 });
    }
    if (url === '/api/me') return Response.json(user);
    if (url.startsWith('/api/mail?')) return Response.json({ items, total: items.length, page: 1, pageSize: 50 });
    if (url.startsWith('/api/mail/meta')) return Response.json(META);
    if (/^\/api\/mail\/\d+\/lead-suggestions$/.test(url)) return Response.json({ items: [] });
    const m = /^\/api\/mail\/(\d+)(\?peek=1)?$/.exec(url);
    if (m) return Response.json(details[Number(m[1])]);
    return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
  }));
  return posts;
}

function show(user: Me = me) {
  return render(
    <QueryClientProvider client={makeClient(user)}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={['/email/1']}>
              <Routes>
                <Route path="/email" element={<EmailPage />} />
                <Route path="/email/:id" element={<EmailPage />} />
                <Route path="*" element={null} />
              </Routes>
            </MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Email screen: lead panel (web-mail release 2, mockup "Lead panel")', () => {
  it('shows the lead details from the reading answer, follow-up red when due, the value and recent lines', async () => {
    const a = item();
    stub([a], { 1: detail(a) });
    show();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    expect(within(panel).getByRole('heading', { level: 3, name: 'Lead' })).toBeInTheDocument();
    // F11: the panel's heading is not inside the message list's region.
    expect(within(screen.getByRole('region', { name: 'Message list' })).queryByRole('heading', { name: 'Lead' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Collapse lead panel' })).toBeInTheDocument();
    expect(await within(panel).findByText('Acme Logistics')).toBeInTheDocument();
    expect(within(panel).getByText('AL')).toBeInTheDocument();
    expect(within(panel).getByText('acme-logistics.com · Chicago, US')).toBeInTheDocument();
    expect(within(panel).getByText('LD-1178')).toBeInTheDocument();
    expect(within(panel).getByText('Contacted')).toBeInTheDocument();
    const row = (label: string) => within(panel).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
    expect(row('Contact').textContent).toBe('Maria GómezProcurement Manager');
    expect(within(row('Email')).getByRole('link', { name: 'maria.gomez@acme-logistics.com' })).toHaveAttribute('href', 'mailto:maria.gomez@acme-logistics.com');
    expect(row('Phone').textContent).toBe('+1 (312) 555-0148');
    expect(row('Owner').textContent).toBe('Arjun Mehta');
    expect(within(panel).getByText(/Today, 16:00 · due/)).toHaveClass('due');
    expect(row('Last activity').textContent).toBe('Email received · 22 Nov 2026, 11:05');
    // F35: the live CRM's money format (formatMoney), not the mockup's "US$ 48,000".
    expect(within(panel).getByText('USD 48,000.00')).toBeInTheDocument();
    expect(within(panel).getAllByRole('link', { name: 'Open lead' })[0]).toHaveAttribute('href', '/leads/5');
    expect(within(panel).getByRole('button', { name: 'Log as activity' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Create task' })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: 'Set follow-up' })).toBeEnabled();
    // Release 2B-2's Add contact stays reachable (the company's Contacts tab).
    expect(within(panel).getByRole('link', { name: 'Add contact' })).toHaveAttribute('href', '/companies/4?tab=contacts');
    expect(within(panel).getByText('Recent on the lead')).toBeInTheDocument();
    const recent = within(panel).getByRole('list', { name: 'Recent on the lead' });
    expect(within(recent).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Email receivedRFP-2026-118 · Today, 11:05',
      'Email sent by ArjunOverview and next steps · 19 Nov 2026, 10:12',
      'Call loggedDiscovery call, 32 min · 17 Nov 2026, 16:00',
    ]);
    expect(within(panel).getByText('Linked automatically: acme-logistics.com belongs to this lead.')).toBeInTheDocument();
  });

  it('a follow-up that is not due, without a time, a lead with no quotation, contact or reason', async () => {
    const a = item();
    stub([a], {
      1: detail(a, {
        leadPanel: {
          ...PANEL, contact: null, owner: null, followUp: { date: '2026-11-23', time: null, due: false }, value: null, lastActivity: null, recent: [],
          linkReason: { kind: 'address', value: 'maria.gomez@acme-logistics.com' },
        },
      }),
    });
    show();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await within(panel).findByText('Acme Logistics');
    const row = (label: string) => within(panel).getByText(label, { selector: 'dt' }).nextElementSibling as HTMLElement;
    expect(row('Next follow-up').textContent).toBe('Tomorrow');
    expect(row('Next follow-up')).not.toHaveClass('due');
    expect(row('Contact').textContent).toBe('—');
    expect(row('Owner').textContent).toBe('—');
    expect(row('Last activity').textContent).toBe('—');
    expect(row('Value').textContent).toBe('—');
    expect(within(panel).queryByText('Email', { selector: 'dt' })).toBeNull();
    expect(within(panel).queryByText('Phone', { selector: 'dt' })).toBeNull();
    expect(within(panel).queryByText('Recent on the lead')).toBeNull();
    expect(within(panel).getByText('Linked automatically: maria.gomez@acme-logistics.com is on this lead.')).toBeInTheDocument();
  });

  it('starts folded below 1400 px as a rail "Lead · LD-1178", opens on click', async () => {
    windowWidth(1280);
    const u = userEvent.setup();
    const a = item();
    stub([a], { 1: detail(a) });
    show();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    expect(panel).toHaveClass('collapsed');
    expect(within(panel).getByRole('button', { name: 'Expand lead panel' })).toBeInTheDocument();
    const rail = await within(panel).findByRole('button', { name: 'Lead · LD-1178' });
    expect(within(panel).queryByText('Acme Logistics')).toBeNull();
    await u.click(rail);
    expect(panel).not.toHaveClass('collapsed');
    expect(await within(panel).findByText('Acme Logistics')).toBeInTheDocument();
    // The View tab's Lead panel button shares the state.
    await u.click(screen.getByRole('tab', { name: 'View' }));
    const viewButton = screen.getByRole('button', { name: /Lead panel/ });
    expect(viewButton).toHaveAttribute('title', 'Collapse lead panel');
    await u.click(viewButton);
    expect(panel).toHaveClass('collapsed');
    await u.click(within(panel).getByRole('button', { name: 'Expand lead panel' }));
    expect(panel).not.toHaveClass('collapsed');
    expect(viewButton).toHaveAttribute('title', 'Collapse lead panel');
  });

  it("another owner's lead: company name and the restricted chip only, no buttons", async () => {
    const a = item({ leadRestricted: true, leadId: null, companyId: null, leadStatus: null });
    stub([a], { 1: detail(a, { lead: null, company: null, leadPanel: null, restrictedLead: { number: 'LD-1178', companyName: 'Acme Logistics' } }) });
    show();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    expect(await within(panel).findByText('Acme Logistics')).toBeInTheDocument();
    expect(within(panel).getByText("LD-1178 · another owner's lead")).toBeInTheDocument();
    // Only the head's fold toggle: no actions, no links, no details.
    expect(within(panel).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Collapse lead panel']);
    expect(within(panel).queryAllByRole('link')).toEqual([]);
    expect(within(panel).queryByText('Owner')).toBeNull();
    expect(within(panel).queryByText(/Linked automatically/)).toBeNull();
  });

  it('Set follow-up opens the follow-up menu', async () => {
    const u = userEvent.setup();
    const a = item();
    const posts = stub([a], { 1: detail(a) });
    show();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    const button = await within(panel).findByRole('button', { name: 'Set follow-up' });
    await waitFor(() => expect(button).toBeEnabled());
    await u.click(button);
    const menu = await screen.findByRole('menu', { name: 'Follow-up' });
    expect(within(menu).getByText('Lead follow-up · LD-1178')).toBeInTheDocument();
    await u.click(within(menu).getByRole('menuitem', { name: /^Tomorrow/ }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/mail/1/follow-up', body: { date: '2026-11-23', time: '09:00' } }]));
    expect(screen.queryByRole('menu', { name: 'Follow-up' })).toBeNull();
  });

  it('Log as activity and Create task act on the open message', async () => {
    const u = userEvent.setup();
    const a = item();
    const posts = stub([a], { 1: detail(a) });
    show();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await u.click(await within(panel).findByRole('button', { name: 'Log as activity' }));
    await u.click(within(panel).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/api/mail/1/log', '/api/mail/1/task']));
  });

  it('no lead: "No lead linked" with Link to lead ▾, which opens the link menu', async () => {
    const u = userEvent.setup();
    const a = item({ leadId: null, leadNumber: null, companyId: null, leadStatus: null });
    stub([a], { 1: detail(a) });
    show();
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    expect(await within(panel).findByText('No lead linked')).toBeInTheDocument();
    const link = within(panel).getByRole('button', { name: 'Link to lead ▾' });
    await waitFor(() => expect(link).toBeEnabled());
    await u.click(link);
    expect(await screen.findByRole('menu', { name: 'Link to lead' })).toBeInTheDocument();
  });

  it('is translated (Spanish)', async () => {
    const spanish: Me = { ...me, language: 'es' };
    const a = item();
    stub([a], { 1: detail(a) }, spanish);
    show(spanish);
    const panel = await screen.findByRole('complementary', { name: es.Lead });
    await within(panel).findByText('Acme Logistics');
    expect(within(panel).getByText(es['Recent on the lead'])).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: es['Set follow-up'] })).toBeInTheDocument();
    expect(within(panel).getByText(`${es.Today}, 16:00 · ${es['due']}`)).toHaveClass('due');
    expect(within(panel).getByText(es['Linked automatically: {value} belongs to this lead.'].replace('{value}', 'acme-logistics.com'))).toBeInTheDocument();
  });
});
