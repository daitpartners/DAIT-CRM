import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CallNoteForm } from '../src/pages/leads/CallNoteForm';
import { STATUSES, Wrap, inDays, makeClient, makeLead } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

describe('Call note: a passed follow-up date (review #13)', () => {
  it('says the date has passed and the lead stays overdue until a new date is picked', async () => {
    const u = userEvent.setup();
    render(
      <Wrap qc={makeClient()}>
        <CallNoteForm lead={makeLead({ nextFollowUp: inDays(-6), isOverdue: true })} statuses={STATUSES} />
      </Wrap>,
    );
    const date = screen.getByLabelText('Next follow-up');
    expect(date).toHaveValue(inDays(-6));
    expect(screen.getByText('This date has passed: the lead stays overdue. Pick a new date.')).toBeInTheDocument();
    await u.clear(date);
    await u.type(date, inDays(3));
    expect(screen.queryByText(/This date has passed/)).toBeNull();
  });

  it('a future follow-up shows no warning', () => {
    render(
      <Wrap qc={makeClient()}>
        <CallNoteForm lead={makeLead({ nextFollowUp: inDays(2) })} statuses={STATUSES} />
      </Wrap>,
    );
    expect(screen.queryByText(/This date has passed/)).toBeNull();
  });
});
