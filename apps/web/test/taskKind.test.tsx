import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t as translate } from '@dait-crm/shared';
import es from '../src/locales/es.json';
import type { TaskRow } from '../src/api/tasks';
import { errorText, taskKindText, taskWhenText } from '../src/i18n/labels';
import { FollowUpPanel } from '../src/pages/leads/FollowUpPanel';
import { TaskItem } from '../src/pages/tasks/TasksList';
import { TaskModal } from '../src/pages/tasks/TaskModal';
import { STATUSES, Wrap, inDays, makeClient, makeLead, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const en = (phrase: string) => phrase.replace(/\|[^|]*$/, '');
const esT = (phrase: string, vars?: Record<string, string | number>) =>
  translate(es as Record<string, string>, Object.hasOwn(es, phrase) ? phrase : phrase.replace(/\|[^|]*$/, ''), vars);

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 11, leadId: 5, lead: { id: 5, number: 'LD-1005', companyName: 'Meridian Textiles' }, title: 'Call Tom back',
    dueDate: inDays(2), kind: 'followup', dueTime: null, durationMinutes: null, assignedTo: { id: 2, name: 'Arjun Mehta' },
    isDone: false, doneAt: null, origin: 'manual', closedReason: null, isOverdue: false, isToday: false,
    updatedAt: '2026-11-20T10:00:00.000Z', ...overrides,
  };
}

/** Answers task writes with `reply` (default: the saved row) and records each body. */
function stubTasks(reply?: (body: Record<string, unknown>) => Response) {
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/tasks') && init?.method) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ method: init.method, url, body });
      return reply ? reply(body) : Response.json(task(body as Partial<TaskRow>));
    }
    // A save refetches the signed-in user; answer like the API does.
    if (url === '/api/me') return Response.json(rep);
    return Response.json({});
  }));
  return calls;
}

describe('taskKindText / taskWhenText', () => {
  it('names each kind', () => {
    expect(taskKindText(en, 'followup')).toBe('Follow-up');
    expect(taskKindText(en, 'call')).toBe('Call');
    expect(taskKindText(en, 'meeting')).toBe('Meeting');
  });

  it('shows kind and start–end for calls and meetings, the time alone for a timed follow-up, nothing otherwise', () => {
    expect(taskWhenText(en, task({ kind: 'call', dueTime: '10:00', durationMinutes: 30 }))).toBe('Call · 10:00–10:30');
    expect(taskWhenText(en, task({ kind: 'meeting', dueTime: '14:00', durationMinutes: 60 }))).toBe('Meeting · 14:00–15:00');
    expect(taskWhenText(en, task({ kind: 'followup', dueTime: '10:00' }))).toBe('10:00');
    expect(taskWhenText(en, task())).toBe('');
  });

  it('caps the end at 23:59', () => {
    expect(taskWhenText(en, task({ kind: 'meeting', dueTime: '23:30', durationMinutes: 60 }))).toBe('Meeting · 23:30–23:59');
  });

  it('is translated in Spanish, as is the time_required error', () => {
    expect(taskKindText(esT, 'followup')).toBe('Seguimiento');
    expect(taskWhenText(esT, task({ kind: 'call', dueTime: '10:00', durationMinutes: 30 }))).toBe('Llamada · 10:00–10:30');
    expect(taskWhenText(esT, task({ kind: 'meeting', dueTime: '09:15', durationMinutes: 60 }))).toBe('Reunión · 09:15–10:15');
    expect(errorText(esT, 'time_required')).not.toBe(errorText(esT, 'unknown'));
    expect(errorText(en, 'time_required')).toBe('Enter a time for a call or meeting');
  });
});

describe('Edit task: Type and Time', () => {
  it('shows Type (Follow-up / Call / Meeting) and Time filled from the task', () => {
    render(
      <Wrap qc={makeClient()}>
        <TaskModal task={task({ kind: 'call', dueTime: '10:00', durationMinutes: 30 })} onClose={() => {}} />
      </Wrap>,
    );
    const type = screen.getByLabelText('Type');
    expect(within(type).getAllByRole('option').map((o) => o.textContent)).toEqual(['Follow-up', 'Call', 'Meeting']);
    expect(type).toHaveValue('call');
    expect(screen.getByLabelText('Time')).toHaveValue('10:00');
  });

  it('a call without a time is not saved and says why beside Time', async () => {
    const u = userEvent.setup();
    const calls = stubTasks();
    render(
      <Wrap qc={makeClient()}>
        <TaskModal task={task()} onClose={() => {}} />
      </Wrap>,
    );
    await u.selectOptions(screen.getByLabelText('Type'), 'call');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a time for a call or meeting')).toBeTruthy();
    expect(screen.getByLabelText('Time')).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
  });

  it('saving sends kind and dueTime', async () => {
    const u = userEvent.setup();
    const calls = stubTasks();
    const onClose = vi.fn();
    render(
      <Wrap qc={makeClient()}>
        <TaskModal task={task()} onClose={onClose} />
      </Wrap>,
    );
    await u.selectOptions(screen.getByLabelText('Type'), 'meeting');
    await u.type(screen.getByLabelText('Time'), '14:00');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toMatchObject({ kind: 'meeting', dueTime: '14:00', updatedAt: '2026-11-20T10:00:00.000Z' });
  });

  it('an emptied time on a follow-up is sent as null', async () => {
    const u = userEvent.setup();
    const calls = stubTasks();
    const onClose = vi.fn();
    render(
      <Wrap qc={makeClient()}>
        <TaskModal task={task({ dueTime: '09:00' })} onClose={onClose} />
      </Wrap>,
    );
    await u.clear(screen.getByLabelText('Time'));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls[0]!.body).toMatchObject({ kind: 'followup', dueTime: null });
  });

  it('the server time_required refusal marks Time', async () => {
    const u = userEvent.setup();
    stubTasks(() => Response.json({ error: 'time_required' }, { status: 400 }));
    render(
      <Wrap qc={makeClient()}>
        <TaskModal task={task({ kind: 'call', dueTime: '10:00', durationMinutes: 30 })} onClose={() => {}} />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: 'Save' }));
    const err = await screen.findByText('Enter a time for a call or meeting', { selector: '#tk-dueTime-err' });
    expect(err).toBeTruthy();
  });

  it('the Add task dialog stays without Type and Time and sends neither', async () => {
    const u = userEvent.setup();
    const calls = stubTasks();
    const onClose = vi.fn();
    render(
      <Wrap qc={makeClient()}>
        <TaskModal lead={{ id: 5, number: 'LD-1005', companyName: 'Meridian Textiles' }} onClose={onClose} />
      </Wrap>,
    );
    expect(screen.queryByLabelText('Type')).toBeNull();
    expect(screen.queryByLabelText('Time')).toBeNull();
    await u.type(screen.getByLabelText(/Title/), 'Send brochure');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls[0]!.method).toBe('POST');
    // TaskCreate's default kind may ride along; the dialog itself offers no type or time.
    expect(calls[0]!.body.kind ?? 'followup').toBe('followup');
    expect(calls[0]!.body).not.toHaveProperty('dueTime');
  });
});

describe('type and time beside the title', () => {
  it('Tasks list row', () => {
    render(
      <Wrap qc={makeClient()}>
        <ul>
          <TaskItem task={task({ kind: 'call', dueTime: '10:00', durationMinutes: 30 })} busy={false} onTick={() => {}} />
        </ul>
      </Wrap>,
    );
    expect(screen.getByText('Call · 10:00–10:30')).toBeTruthy();
  });

  it('lead page Open tasks', () => {
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel
          lead={makeLead({ tasks: [task({ kind: 'meeting', dueTime: '14:00', durationMinutes: 60 }), task({ id: 12, title: 'Plain' })] })}
          statuses={STATUSES}
          live
        />
      </Wrap>,
    );
    expect(screen.getByText('Meeting · 14:00–15:00')).toBeTruthy();
  });
});
