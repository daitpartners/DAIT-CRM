import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FollowUpPanel } from '../src/pages/leads/FollowUpPanel';
import type { Me } from '../src/api/queries';
import { STATUSES, Wrap, inDays, makeClient, makeLead, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

function stubPatch() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/leads/5' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return Response.json({ ...makeLead(), ...body, updatedAt: '2026-11-21T10:00:00.000Z' });
    }
    // A save refetches the signed-in user; answer like the API does.
    if (url === '/api/me') return Response.json(rep);
    return Response.json({});
  }));
  return bodies;
}

describe('FollowUpPanel', () => {
  it('has no quick date or Clear buttons (prototype Follow-up tab)', () => {
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(3) })} statuses={STATUSES} live />
      </Wrap>,
    );
    for (const name of ['Tomorrow', '+4 days', 'Next week', 'Clear']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('a half-typed date is not saved on Enter', async () => {
    const bodies = stubPatch();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(3) })} statuses={STATUSES} live />
      </Wrap>,
    );
    const input = screen.getByLabelText('Next follow-up', { selector: 'input' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 50));
    expect(bodies).toHaveLength(0);
  });

  it('emptying the date asks first, then clears the follow-up', async () => {
    const u = userEvent.setup();
    const bodies = stubPatch();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(3) })} statuses={STATUSES} live />
      </Wrap>,
    );
    const input = screen.getByLabelText('Next follow-up', { selector: 'input' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    const dialog = await screen.findByRole('dialog', { name: 'Clear follow-up?' });
    await u.click(within(dialog).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ nextFollowUp: null, updatedAt: '2026-11-20T10:00:00.000Z' });
  });

  it('cancelling the clear puts the stored date back', async () => {
    const u = userEvent.setup();
    const bodies = stubPatch();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead({ nextFollowUp: inDays(3) })} statuses={STATUSES} live />
      </Wrap>,
    );
    const input = screen.getByLabelText('Next follow-up', { selector: 'input' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    const dialog = await screen.findByRole('dialog', { name: 'Clear follow-up?' });
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(input).toHaveValue(inDays(3));
    expect(bodies).toHaveLength(0);
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

  it('picking Lost in Status opens Close lead with Lost chosen', async () => {
    const u = userEvent.setup();
    stubPatch();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    const status = screen.getByLabelText('Status');
    expect(within(status).getByRole('option', { name: 'Won' })).toBeEnabled();
    await u.selectOptions(status, 'Lost');
    const dialog = await screen.findByRole('dialog', { name: 'Close lead' });
    expect(within(dialog).getByRole('radio', { name: /^Lost/ })).toBeChecked();
    // Nothing is saved until the dialog is confirmed: the select still shows the stored status.
    expect(status).toHaveValue('New');
  });

  it('Emails tab shows the prototype empty state', async () => {
    const u = userEvent.setup();
    render(
      <Wrap qc={makeClient()}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('tab', { name: /Emails/ }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('No emails yet')).toBeInTheDocument();
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
  });

  it("Emails tab marks another user's mail with their mailbox (web-mail release 1, team view)", async () => {
    const u = userEvent.setup();
    const mail = (id: number, subject: string, ownerName: string | null) => ({
      ownerName, id, leadId: 5, folder: 'inbox', status: 'received', fromAddress: 'tom@meridian.com', toAddresses: ['x@daitpartners.com'],
      ccAddresses: [], subject, bodyText: 'Hello', occurredAt: '2026-11-20T10:00:00.000Z', lastError: null,
    });
    const admin: Me = { ...rep, role: 'Administrator', rights: [...rep.rights, 'use_email', 'view_team_mail'] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return Response.json(admin);
      if (url === '/api/leads/5/emails') return Response.json({ items: [mail(1, 'Re: Proposal', 'Carlos Torres'), mail(2, 'My note', null)] });
      return Response.json({});
    }));
    render(
      <Wrap qc={makeClient(admin)}>
        <FollowUpPanel lead={makeLead()} statuses={STATUSES} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('tab', { name: /Emails/ }));
    const list = await screen.findByRole('list', { name: 'Emails' });
    const [theirs, mine] = within(list).getAllByRole('listitem');
    expect(theirs).toHaveTextContent("Carlos's mailbox");
    expect(mine).not.toHaveTextContent('mailbox');
  });
});
