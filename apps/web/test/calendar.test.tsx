import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { CalendarItem, CalendarResponse } from '@dait-crm/shared';
import es from '../src/locales/es.json';
import type { Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { I18nContext } from '../src/i18n';
import { CalendarPage } from '../src/pages/calendar/CalendarPage';
import { makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const admin: Me = { ...rep, id: 1, name: 'Maya Pillai', role: 'Administrator', rights: ['manage_leads', 'view_all_leads', 'manage_users'] };

function item(o: Partial<CalendarItem>): CalendarItem {
  return {
    kind: 'task', id: 1, date: '2026-11-10', time: null, end: null, title: 'Follow up', type: 'followup', done: false, overdue: false,
    leadId: 5, leadNumber: 'LD-1005', company: 'Meridian Textiles', ownerId: 2, ownerName: 'Arjun Mehta', where: null, ...o,
  };
}

const ITEMS: CalendarItem[] = [
  item({ id: 1, title: 'Send proposal' }),
  item({ id: 2, title: 'Call Tom', type: 'call', time: '10:00', end: '10:30' }),
  item({ id: 3, title: 'Check pricing' }),
  item({ id: 4, title: 'Demo prep' }),
  item({ id: 5, title: 'Ask for references' }),
  item({ kind: 'event', id: 90, date: '2026-11-12', time: '14:00', end: '15:00', title: 'Board sync', type: 'internal', leadId: null, leadNumber: null, company: null, where: 'Teams room', organizer: 'Maya Pillai', attendees: ['Arjun Mehta', 'Neha Kapoor'] }),
];
const OVERDUE: CalendarItem[] = [item({ id: 7, date: '2026-11-02', title: 'Chase invoice', overdue: true, company: 'Orbit Labs' })];

type Call = { method: string; url: string; body?: Record<string, unknown> };

function stub(res: Partial<CalendarResponse> = {}, me: Me = rep) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined });
    if (url.startsWith('/api/calendar')) return Response.json({ items: ITEMS, overdue: OVERDUE, outlook: { syncOn: false }, ...res });
    if (url.startsWith('/api/leads')) {
      return Response.json({
        items: [
          { id: 5, number: 'LD-1005', companyName: 'Meridian Textiles', contact: { id: 9, name: 'Tom Hale' }, status: 'New', archivedAt: null },
          { id: 6, number: 'LD-1006', companyName: 'Closed Co', contact: null, status: 'Won', archivedAt: null },
        ],
        total: 2, page: 1, pageSize: 25,
      });
    }
    if (url === '/api/tasks' && init?.method === 'POST') return Response.json({ id: 99 }, { status: 201 });
    if (url === '/api/me') return Response.json(me);
    return Response.json({});
  }));
  return calls;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(url: string, me: Me = rep, lang: 'en' | 'es' = 'en') {
  const qc = makeClient(me);
  return render(
    <QueryClientProvider client={qc}>
      <I18nContext.Provider value={{ lang, dict: lang === 'es' ? (es as Record<string, string>) : {} }}>
        <ToastProvider>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route path="/calendar" element={<><CalendarPage /><Where /></>} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </I18nContext.Provider>
    </QueryClientProvider>,
  );
}

const cell = (date: string) => document.querySelector<HTMLElement>(`.cc[data-day="${date}"]`)!;

describe('Calendar page', () => {
  it('fetches the month grid and shows chips (max 3 + "+n more"), the overdue box and the summary', async () => {
    const calls = stub();
    renderPage('/calendar?d=2026-11-15');
    expect(screen.getByRole('heading', { level: 1, name: 'Calendar' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'November 2026' })).toBeTruthy();
    expect(await screen.findByText('Send proposal')).toBeTruthy();
    expect(calls.find((c) => c.url.startsWith('/api/calendar'))!.url).toBe('/api/calendar?from=2026-10-26&to=2026-12-06&who=mine');
    const day = cell('2026-11-10');
    expect(day.querySelectorAll('.cit')).toHaveLength(3);
    const more = within(day).getByRole('link', { name: '+2 more' });
    expect(more.getAttribute('href')).toBe('/calendar?view=day&d=2026-11-10');
    // A chip with a lead opens it.
    expect(within(day).getByRole('link', { name: /Send proposal/ }).getAttribute('href')).toBe('/leads/5');
    expect(within(day).getByRole('link', { name: /Call Tom/ }).className).toContain('t-call');
    // Overdue box.
    const overdue = document.querySelector<HTMLElement>('.cover')!;
    expect(within(overdue).getByText('Chase invoice')).toBeTruthy();
    expect(within(overdue).getByText('Orbit Labs, Mon 2 Nov')).toBeTruthy();
    expect(screen.getByText('6 open items in this month. Click an empty slot to add a follow-up; click an item to open its lead.')).toBeTruthy();
    // Nov 2026 needs 6 weeks.
    expect(document.querySelectorAll('.cgb .cc')).toHaveLength(42);
    expect(screen.getByText('Follow-ups, calls and meetings for your leads')).toBeTruthy();
    expect(screen.queryByText('Outlook sync on')).toBeNull();
  });

  it('shows "Outlook sync on" in the subtitle when the sync is on', async () => {
    stub({ outlook: { syncOn: true } });
    renderPage('/calendar?d=2026-11-15');
    expect(await screen.findByText('Outlook sync on')).toBeTruthy();
  });

  it('week view: 7 tall columns, "—" when empty; day view: full chips with company · lead number', async () => {
    stub();
    const { unmount } = renderPage('/calendar?view=week&d=2026-11-12');
    expect(screen.getByRole('heading', { level: 2, name: '9 – 15 Nov 2026' })).toBeTruthy();
    await screen.findByText('Board sync');
    expect(document.querySelectorAll('.cgrid.week .cc.tall')).toHaveLength(7);
    expect(within(cell('2026-11-09')).getByText('—')).toBeTruthy();
    unmount();
    renderPage('/calendar?view=day&d=2026-11-10');
    expect(screen.getByRole('heading', { level: 2, name: 'Tuesday 10 November 2026' })).toBeTruthy();
    await screen.findByText('Ask for references');
    expect(screen.getAllByText('Meridian Textiles · LD-1005')).toHaveLength(5);
  });

  it('hides Mine / Everyone from a Sales Representative', async () => {
    stub();
    renderPage('/calendar?d=2026-11-15');
    await screen.findByText('Send proposal');
    expect(screen.queryByRole('link', { name: 'Everyone' })).toBeNull();
  });

  it('offers Everyone to an Administrator, which asks for who=all', async () => {
    const u = userEvent.setup();
    const calls = stub({}, admin);
    renderPage('/calendar?d=2026-11-15', admin);
    await screen.findByText('Send proposal');
    await u.click(screen.getByRole('link', { name: 'Everyone' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/calendar?from=2026-10-26&to=2026-12-06&who=all')).toBe(true));
    expect(screen.getByTestId('where').textContent).toContain('who=all');
    expect(screen.getByRole('link', { name: 'Everyone' }).className).toBe('on');
  });

  it('clicking an empty day opens New follow-up on that date', async () => {
    stub();
    renderPage('/calendar?d=2026-11-15');
    await screen.findByText('Send proposal');
    fireEvent.click(cell('2026-11-23'));
    const dialog = screen.getByRole('dialog', { name: 'New follow-up' });
    expect(within(dialog).getByLabelText(/^Date/)).toHaveValue('2026-11-23');
    expect(within(dialog).getByLabelText('Type')).toHaveValue('followup');
    expect(within(within(dialog).getByLabelText('Type')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Follow-up (task)', 'Call', 'Meeting']);
    expect(within(dialog).getByLabelText('Assigned to')).toHaveValue(String(rep.id));
  });

  it('checks the form as the prototype: lead, what to do, a call needs a time', async () => {
    const u = userEvent.setup();
    const calls = stub();
    renderPage('/calendar?d=2026-11-15');
    await screen.findByText('Send proposal');
    fireEvent.click(cell('2026-11-23'));
    const dialog = screen.getByRole('dialog', { name: 'New follow-up' });
    const go = within(dialog).getByRole('button', { name: 'Add to calendar' });
    await u.click(go);
    expect(await screen.findByText('Choose a lead')).toBeTruthy();
    const lead = within(dialog).getByRole('combobox', { name: /Lead/ });
    await u.click(lead);
    // Closed leads are not offered.
    expect(await within(dialog).findByRole('option', { name: 'LD-1005 · Meridian Textiles · Tom Hale' })).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: /Closed Co/ })).toBeNull();
    // The server filters too, so the first page is all open leads.
    expect(calls.some((c) => c.url.startsWith('/api/leads?') && new URLSearchParams(c.url.split('?')[1]).get('open') === '1')).toBe(true);
    await u.click(within(dialog).getByRole('option', { name: 'LD-1005 · Meridian Textiles · Tom Hale' }));
    await u.click(go);
    expect(await screen.findByText('Say what needs doing')).toBeTruthy();
    await u.type(within(dialog).getByLabelText(/What to do/), 'Call about the proposal');
    await u.selectOptions(within(dialog).getByLabelText('Type'), 'call');
    await u.click(go);
    expect(await screen.findByText('A call needs a time')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('saves a call with kind, time and timeline, then says so', async () => {
    const u = userEvent.setup();
    const calls = stub();
    renderPage('/calendar?d=2026-11-15');
    await screen.findByText('Send proposal');
    fireEvent.click(cell('2026-11-23'));
    const dialog = screen.getByRole('dialog', { name: 'New follow-up' });
    await u.click(within(dialog).getByRole('combobox', { name: /Lead/ }));
    await u.click(await within(dialog).findByRole('option', { name: 'LD-1005 · Meridian Textiles · Tom Hale' }));
    await u.type(within(dialog).getByLabelText(/What to do/), 'Call about the proposal');
    await u.selectOptions(within(dialog).getByLabelText('Type'), 'call');
    await u.type(within(dialog).getByLabelText(/^Time/), '10:00');
    await u.click(within(dialog).getByRole('button', { name: 'Add to calendar' }));
    expect(await screen.findByText('Call added for Mon 23 Nov')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/tasks');
    expect(post.body).toEqual({
      leadId: 5, title: 'Call about the proposal', dueDate: '2026-11-23', assignedToId: rep.id, kind: 'call', dueTime: '10:00', timeline: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an event without a lead opens its details', async () => {
    const u = userEvent.setup();
    stub();
    renderPage('/calendar?d=2026-11-15');
    await u.click(await screen.findByRole('button', { name: /Board sync/ }));
    const dialog = screen.getByRole('dialog', { name: 'Board sync' });
    expect(within(dialog).getByText('Thu 12 Nov · 14:00–15:00')).toBeTruthy();
    expect(within(dialog).getByText('Maya Pillai')).toBeTruthy();
    expect(within(dialog).getByText('Arjun Mehta, Neha Kapoor')).toBeTruthy();
    expect(within(dialog).getByText('Teams room')).toBeTruthy();
    expect(within(dialog).getByText('internal')).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says nothing about counts until the calendar has loaded', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/calendar')) return new Promise<Response>((res) => { answer = res; });
      if (url === '/api/me') return Response.json(rep);
      return Response.json({});
    }));
    renderPage('/calendar?d=2026-11-15');
    expect(screen.queryByText(/open items? in this month/)).toBeNull();
    expect(screen.queryByText('Nothing overdue.')).toBeNull();
    answer(Response.json({ items: [], overdue: [], outlook: { syncOn: false } }));
    expect(await screen.findByText(/^0 open items in this month\./)).toBeTruthy();
    expect(screen.getByText('Nothing overdue.')).toBeTruthy();
  });

  it('is in Spanish for a Spanish user', async () => {
    stub();
    renderPage('/calendar?d=2026-11-15', { ...rep, language: 'es' }, 'es');
    await screen.findByText('Send proposal');
    expect(screen.getByRole('heading', { level: 1, name: es['Calendar' as keyof typeof es] as string })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Noviembre 2026' })).toBeTruthy();
    expect(screen.getByRole('button', { name: es['New follow-up' as keyof typeof es] as string })).toBeTruthy();
    expect(screen.queryByText('New follow-up')).toBeNull();
    expect(screen.queryByText(/open items in this month/)).toBeNull();
  });
});
