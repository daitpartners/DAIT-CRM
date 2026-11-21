import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from '../src/components/Tabs';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'contacts', label: 'Contacts', count: 2 },
  { id: 'locations', label: 'Locations', count: 3 },
  { id: 'leads', label: 'Leads & Prospects' },
  { id: 'activities', label: 'Activities' },
  { id: 'ai', label: 'AI Intelligence' },
  { id: 'sources', label: 'Research Sources' },
];

function Harness({ initial = 'overview' }: { initial?: string }) {
  const [active, setActive] = useState(initial);
  return (
    <Tabs tabs={TABS} active={active} onChange={setActive} label="Company sections">
      <p>Panel for {active}</p>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('renders seven tabs in a tablist with the active one selected and controlling its panel', () => {
    render(<Harness />);
    const list = screen.getByRole('tablist', { name: 'Company sections' });
    expect(list).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Overview', 'Contacts 2', 'Locations 3', 'Leads & Prospects', 'Activities', 'AI Intelligence', 'Research Sources',
    ]);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(overview).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /Contacts/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /Contacts/ })).toHaveAttribute('tabindex', '-1');

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('Panel for overview');
    expect(overview).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', overview.id);
  });

  it('moves focus and selection with ArrowRight, ArrowLeft, Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    await user.keyboard('{ArrowRight}');
    const contacts = screen.getByRole('tab', { name: /Contacts/ });
    expect(contacts).toHaveFocus();
    expect(contacts).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel for contacts');

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Research Sources' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Research Sources' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps hidden panels out of the DOM', async () => {
    const user = userEvent.setup();
    render(<Harness initial="locations" />);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.queryByText('Panel for overview')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'AI Intelligence' }));
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByText('Panel for ai')).toBeInTheDocument();
    expect(screen.queryByText('Panel for locations')).not.toBeInTheDocument();
  });
});
