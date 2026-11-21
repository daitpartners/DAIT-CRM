import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FollowUpPanel } from '../src/pages/leads/FollowUpPanel';
import { STATUSES, Wrap, inDays, makeClient, makeLead } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

function stubPatch() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/leads/5' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return Response.json({ ...makeLead(), ...body, updatedAt: '2026-11-21T10:00:00.000Z' });
    }
    return Response.json({});
  }));
  return bodies;
}

describe('FollowUpPanel', () => {
  it.each([
    ['Tomorrow', 1],
    ['+4 days', 4],
    ['Next week', 7],
  ])('quick button %s sets the follow-up date and saves it', async (label, days) => {
    const u = userEvent.setup();
    const bodies = stubPatch();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ nextFollowUp: inDays(days), updatedAt: '2026-11-20T10:00:00.000Z' });
    expect(screen.getByLabelText('Next follow-up', { selector: 'input' })).toHaveValue(inDays(days));
  });

  it('a cleared or half-typed date is not saved on blur or Enter', async () => {
    const bodies = stubPatch();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(3) })} statuses={STATUSES} live />
      </Wrap>,
    );
    const input = screen.getByLabelText('Next follow-up', { selector: 'input' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await new Promise((r) => setTimeout(r, 50));
    expect(bodies).toHaveLength(0);
    // The stored date comes back.
    expect(input).toHaveValue(inDays(3));
  });

  it('Clear asks first, then clears the follow-up', async () => {
    const u = userEvent.setup();
    const bodies = stubPatch();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(3) })} statuses={STATUSES} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: 'Clear' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear follow-up?' });
    await u.click(within(dialog).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ nextFollowUp: null, updatedAt: '2026-11-20T10:00:00.000Z' });
  });

  it('no Clear button without a follow-up date', () => {
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('shows Scheduled for a future follow-up, Today for today and Overdue when late; none without a date', () => {
    const qc = makeClient();
    const { rerender } = render(
      <Wrap qc={qc}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(3) })} statuses={STATUSES} live />
      </Wrap>,
    );
    const panel = () => screen.getByRole('group', { name: 'Next follow-up' });
    expect(within(panel()).getByText('Scheduled')).toHaveClass('badge');
    rerender(
      <Wrap qc={qc}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(0) })} statuses={STATUSES} live />
      </Wrap>,
    );
    expect(within(panel()).getByText('Today')).toHaveClass('badge');
    rerender(
      <Wrap qc={qc}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(-2), isOverdue: true })} statuses={STATUSES} live />
      </Wrap>,
    );
    expect(within(panel()).getByText('Overdue')).toHaveClass('badge');
    rerender(
      <Wrap qc={qc}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    expect(within(panel()).queryByText(/Scheduled|Today|Overdue/)).toBeNull();
  });

  it('offers closed statuses only as disabled options (they go through Close lead)', () => {
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    const status = screen.getByLabelText('Status');
    expect(within(status).getByRole('option', { name: 'Contacted' })).toBeEnabled();
    expect(within(status).getByRole('option', { name: 'Lost' })).toBeDisabled();
    expect(within(status).getByRole('option', { name: 'Won' })).toBeDisabled();
  });

  it('Emails tab is a placeholder with no controls', async () => {
    const u = userEvent.setup();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('tab', { name: /Emails/ }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Available in release 2')).toBeInTheDocument();
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
  });
});
