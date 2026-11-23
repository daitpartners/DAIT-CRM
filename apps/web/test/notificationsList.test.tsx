import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NotificationsList } from '../src/pages/notifications/NotificationsList';
import { Wrap, makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const at = '2026-11-22T15:10:00.000Z';
const ROWS = [
  { id: 1, text: 'Quotation accepted · Q-2026-003 · USD 15,360.00', detail: 'Convert to project?', link: '/quotations/3', isRead: false, createdAt: at },
  { id: 2, text: 'AI research completed · Orbit Fintech', detail: '3 to review', link: '/companies/5#ai', isRead: false, createdAt: at },
  { id: 3, text: 'Mailer finished · Intro run', detail: '3 sent · 0 skipped · 0 failed', link: '/mailer/1', isRead: true, createdAt: at },
  { id: 4, text: 'Lead LD-1013 assigned to you', detail: 'Sunrise Pharma', link: '/leads/13', isRead: true, createdAt: at },
  { id: 5, text: 'Project created · Website', detail: null, link: '/projects', isRead: true, createdAt: at },
  { id: 6, text: 'Task assigned to you · Call back', detail: null, link: '/tasks', isRead: true, createdAt: at },
];

const me = { ...rep, rights: [...rep.rights, 'use_email' as const] };

function show() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T10:00:00.000Z'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/notifications')) return Response.json({ items: ROWS, total: ROWS.length, unread: 2 });
    if (url.startsWith('/api/tasks')) return Response.json({ items: [], total: 0, page: 1, pageSize: 1, counts: { today: 0, overdue: 0, upcoming: 0, done: 0, all: 0 } });
    if (url === '/api/nav-counts') return Response.json({ leads: 3, overdueTasks: 0, unread: 2, mailUnread: 4, mailerLive: 1, projects: 1 });
    if (url === '/api/me') return Response.json(me);
    return Response.json({});
  }));
  render(
    <Wrap qc={makeClient(me)}>
      <NotificationsList />
    </Wrap>,
  );
}

describe('Notifications (review #28, prototype V.notifications KIND)', () => {
  it('each row has its type label and icon colour; times are 24-hour', async () => {
    show();
    const row = async (text: RegExp) => (await screen.findByText(text)).closest('button') as HTMLElement;
    const kinds: [RegExp, string, string][] = [
      [/^Quotation accepted/, 'Quotations', 'rgb(255, 241, 224)'],
      [/^AI research completed/, 'AI research', 'rgb(255, 248, 236)'],
      [/^Mailer finished/, 'Mailer', 'rgb(255, 241, 224)'],
      [/^Lead LD-1013/, 'Leads', 'rgb(239, 230, 253)'],
      [/^Project created/, 'Projects', 'rgb(239, 230, 253)'],
      [/^Task assigned/, 'Tasks', 'rgb(255, 248, 236)'],
    ];
    for (const [text, label, bg] of kinds) {
      const r = await row(text);
      expect(within(r).getByText(new RegExp(`^${label} · Yesterday, 15:10$`))).toBeTruthy();
      expect((r.querySelector('.ni') as HTMLElement).style.background).toBe(bg);
    }
  });

  it('the attention strip links to unread email and running mailer runs (prototype)', async () => {
    show();
    expect(await screen.findByRole('link', { name: '4 unread emails →' })).toHaveAttribute('href', '/email');
    expect(screen.getByRole('link', { name: '1 mailer run in progress →' })).toHaveAttribute('href', '/mailer');
  });
});
