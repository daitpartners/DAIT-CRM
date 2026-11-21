import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LookupValue } from '../src/api/queries';
import { StatusStepper } from '../src/pages/leads/StatusStepper';

const status = (value: string, sortOrder: number, isActive = true): LookupValue => ({
  id: sortOrder, group: 'lead_status', value, label: value, labelEs: null, labelFr: null, sortOrder, isActive,
});

// Deliberately out of order: the stepper follows sortOrder, not array order.
const STATUSES = [
  status('Won', 80), status('Contacted', 30), status('New', 10), status('Lost', 90), status('Not Contacted', 20),
  status('Qualified', 50), status('Not Relevant', 100), status('Interested', 40), status('Retired', 45, false),
];

describe('StatusStepper', () => {
  it('renders active statuses in lookup order with the current one marked and earlier ones done', () => {
    render(<StatusStepper statuses={STATUSES} current="Contacted" onChange={() => {}} />);
    const list = screen.getByRole('list', { name: 'Lead status' });
    const steps = within(list).getAllByRole('button');
    expect(steps.map((b) => b.textContent)).toEqual([
      'New', 'Not Contacted', 'Contacted', 'Interested', 'Qualified', 'Won', 'Lost', 'Not Relevant',
    ]);
    const current = screen.getByRole('button', { name: 'Contacted' });
    expect(current).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'New' }).closest('li')).toHaveClass('done');
    expect(screen.getByRole('button', { name: 'Not Contacted' }).closest('li')).toHaveClass('done');
    expect(screen.getByRole('button', { name: 'Interested' }).closest('li')).not.toHaveClass('done');
  });

  it('disables closed statuses: they go through the Close dialog', () => {
    render(<StatusStepper statuses={STATUSES} current="New" onChange={() => {}} />);
    for (const name of ['Won', 'Lost', 'Not Relevant']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Qualified' })).toBeEnabled();
  });

  it('clicking an open status fires onChange; the current one does not', async () => {
    const onChange = vi.fn();
    render(<StatusStepper statuses={STATUSES} current="New" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Interested' }));
    expect(onChange).toHaveBeenCalledWith('Interested');
    await userEvent.click(screen.getByRole('button', { name: 'New' }));
    await userEvent.click(screen.getByRole('button', { name: 'Won' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows a retired current status and can be disabled as a whole', () => {
    render(<StatusStepper statuses={STATUSES} current="Retired" onChange={() => {}} disabled />);
    expect(screen.getByRole('button', { name: 'Retired' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Interested' })).toBeDisabled();
  });
});
