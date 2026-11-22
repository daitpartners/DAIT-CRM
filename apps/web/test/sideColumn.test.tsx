import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SideColumn } from '../src/pages/leads/SideColumn';
import { Wrap, makeClient, makeLead } from './leadFixture';

describe('SideColumn', () => {
  it('a lead without a company asks for the company before adding a contact', async () => {
    const u = userEvent.setup();
    render(
      <Wrap qc={makeClient()}>
        <SideColumn lead={makeLead({ contact: null, contactId: null, company: null, companyId: null })} live />
      </Wrap>,
    );
    await u.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(screen.queryByRole('dialog', { name: 'Add contact' })).toBeNull();
    expect(await screen.findByText('Choose the company for this lead first, above.')).toBeInTheDocument();
  });

  it('shows Coming up only when something is scheduled', () => {
    const qc = makeClient();
    const { rerender } = render(
      <Wrap qc={qc}>
        <SideColumn lead={makeLead({ nextFollowUp: null, tasks: [] })} live />
      </Wrap>,
    );
    expect(screen.queryByRole('heading', { name: 'Coming up' })).toBeNull();
    rerender(
      <Wrap qc={qc}>
        <SideColumn lead={makeLead({ nextFollowUp: '2030-01-02', tasks: [] })} live />
      </Wrap>,
    );
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument();
  });

  it('shows a call in Coming up as the prototype event: date and time, linking to its week', () => {
    const call = {
      id: 7, leadId: 1, lead: null, title: 'Call back about the proposal', dueDate: '2030-01-03', kind: 'call' as const, dueTime: '10:30',
      durationMinutes: 30, assignedTo: { id: 2, name: 'Arjun Mehta' }, isDone: false, doneAt: null, origin: 'manual', closedReason: null,
      isOverdue: false, isToday: false, updatedAt: '2030-01-01T10:00:00.000Z',
    };
    render(
      <Wrap qc={makeClient()}>
        <SideColumn lead={makeLead({ nextFollowUp: null, tasks: [call] })} live />
      </Wrap>,
    );
    const link = screen.getByRole('link', { name: /Call back about the proposal/ });
    expect(link).toHaveAttribute('href', '/calendar?view=week&d=2030-01-03');
    expect(link.textContent).toMatch(/10:30$/);
  });
});
