import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ActivityRow } from '../src/api/leads';
import { TimelineEntry } from '../src/pages/leads/Timeline';
import { Wrap, makeClient } from './leadFixture';

const row = (over: Partial<ActivityRow>): ActivityRow => ({
  id: 1, leadId: 5, activityType: 'call', title: 'Call · Connected', body: null, url: null, statusFrom: null, statusTo: null,
  relatedType: null, relatedId: null, by: { id: 2, name: 'Arjun Mehta' }, occurredAt: '2026-11-03T14:05:00.000Z', ...over,
});

function show(a: ActivityRow) {
  const { container } = render(
    <Wrap qc={makeClient()}>
      <ol>
        <TimelineEntry activity={a} />
      </ol>
    </Wrap>,
  );
  return container;
}

describe('timeline entries (review #17, prototype UI.timeline)', () => {
  it('show the time, an icon coloured by type and the status change as badges', () => {
    const c = show(row({ activityType: 'status', title: 'Status changed', statusFrom: 'New', statusTo: 'Contacted' }));
    expect(screen.getByText(/03\/11\/2026, 14:05/)).toBeInTheDocument();
    expect(c.querySelector('.dot')).toHaveClass('t-status');
    expect(screen.getByText('New')).toHaveClass('badge');
    expect(screen.getByText('Contacted')).toHaveClass('badge');
  });

  it('a call gets the call colour', () => {
    const c = show(row({}));
    expect(c.querySelector('.dot')).toHaveClass('t-call');
  });
});
