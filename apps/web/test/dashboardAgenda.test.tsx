import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Dashboard as DashboardData } from '../src/api/dashboard';
import { keys } from '../src/api/queries';
import type { TaskRow } from '../src/api/tasks';
import { Dashboard } from '../src/pages/Dashboard';
import { Wrap, makeClient } from './leadFixture';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const TODAY = '2026-11-22';

function task(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 1, leadId: null, lead: null, title: 'Task', dueDate: TODAY, kind: 'followup', dueTime: null, durationMinutes: null,
    assignedTo: { id: 2, name: 'Arjun Mehta' }, isDone: false, doneAt: null, origin: 'manual', closedReason: null,
    isOverdue: false, isToday: true, updatedAt: '2026-11-20T10:00:00.000Z', ...overrides,
  };
}

function data(agenda: TaskRow[]): DashboardData {
  return {
    greeting: { name: 'Arjun Mehta', date: TODAY },
    tiles: { myOpenLeads: 3, newSinceYesterday: 1, tasksDueToday: 2, overdue: 0, upcoming: 1, openTasks: 3, unreadNotifications: 0 },
    tasks: [],
    agenda,
    notifications: [],
    pipeline: [],
    closed: { won: 0, lost: 0 },
    awaitingQuotes: [],
  };
}

function show(agenda: TaskRow[]) {
  // The rep is on UTC; noon there, so 14:00 is the next item.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  const qc = makeClient();
  qc.setQueryData(keys.dashboard, data(agenda));
  render(
    <Wrap qc={qc}>
      <Dashboard />
    </Wrap>,
  );
}

describe("Dashboard: Meetings today and Today's agenda (prototype V.dashboard)", () => {
  it("fills the tile and the agenda from today's timed tasks; no release wording for the calendar", () => {
    show([
      task({ id: 4, title: 'Morning call', kind: 'call', dueTime: '09:00', durationMinutes: 30, isDone: true }),
      task({ id: 2, title: 'Call back', kind: 'call', dueTime: '10:30', durationMinutes: 30, leadId: 5, lead: { id: 5, number: 'LD-1005', companyName: 'Bluefin Marine' } }),
      task({ id: 1, title: 'Demo', kind: 'meeting', dueTime: '14:00', durationMinutes: 60 }),
      task({ id: 3, title: 'Chase reply', dueTime: '16:45' }),
    ]);
    const tile = screen.getByText('Meetings today').closest('a')!;
    expect(tile).toHaveAttribute('href', '/calendar');
    expect(within(tile).getByText('4')).toBeTruthy();
    expect(tile).toHaveTextContent('next at 14:00 · Demo');

    const agenda = screen.getByRole('region', { name: "Today's agenda" });
    expect(agenda).not.toHaveAttribute('aria-disabled');
    expect(within(agenda).getByRole('link', { name: 'Open calendar' })).toHaveAttribute('href', '/calendar');
    const rows = within(agenda).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.ag-time')!.textContent)).toEqual(['09:00', '10:30', '14:00', '16:45']);
    expect(rows[0]).toHaveTextContent('Morning call');
    expect(rows[0]).toHaveTextContent('· done');
    expect(rows[1]).toHaveTextContent('Bluefin Marine · Phone · LD-1005');
    expect(within(rows[1]!).getByRole('link', { name: 'LD-1005' })).toHaveAttribute('href', '/leads/5');
    expect(rows[2]).toHaveTextContent('Arjun Mehta · Microsoft Teams');

    expect(document.body.textContent).not.toMatch(/calendar and quotations from release|Available in release 3[^]*Available in release 3/);
    expect(screen.getByText(/everything assigned to you across leads, email, calendar and quotations/)).toBeTruthy();
  });

  it('says so when nothing is planned today; the tile shows 0 and a dash', () => {
    show([]);
    const tile = screen.getByText('Meetings today').closest('a')!;
    expect(within(tile).getByText('0')).toBeTruthy();
    expect(within(tile).getByText('—')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: "Today's agenda" })).getByText('No events today.')).toBeTruthy();
  });
});
