import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Combobox } from '../src/components/Combobox';

const names = (n: number) =>
  ['Austria', 'Belgium', 'Canada', 'Denmark', 'France', 'Germany', 'India', 'Japan', 'Kenya', 'Mexico', 'Norway', 'Spain']
    .slice(0, n)
    .map((c) => ({ value: c, label: c }));

describe('Combobox', () => {
  it('renders a plain <select> when there are fewer than 8 options', () => {
    render(<Combobox id="c" label="Country" options={names(7)} value={null} onChange={() => {}} />);
    const select = screen.getByLabelText('Country');
    expect(select.tagName).toBe('SELECT');
    expect(screen.queryByRole('combobox', { name: 'Country' })?.tagName).toBe('SELECT');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toContain('Germany');
  });

  it('plain <select> calls onChange with the chosen value', async () => {
    const onChange = vi.fn();
    render(<Combobox id="c" label="Country" options={names(7)} value={null} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('Country'), 'France');
    expect(onChange).toHaveBeenCalledWith('France');
  });

  it('renders a searchable combobox for 12 options and filters with a highlighted match', async () => {
    const user = userEvent.setup();
    render(<Combobox id="c" label="Country" options={names(12)} value={null} onChange={() => {}} />);
    const input = screen.getByRole('combobox', { name: 'Country' });
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('aria-expanded', 'false');

    await user.click(input);
    await user.type(input, 'ger');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Germany');
    const mark = options[0]!.querySelector('mark');
    expect(mark?.textContent).toBe('Ger');
  });

  it('ArrowDown + Enter picks the highlighted option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Combobox id="c" label="Country" options={names(12)} value={null} onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.type(input, 'ger');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('Germany');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('ArrowDown moves the active descendant and ArrowUp moves back', async () => {
    const user = userEvent.setup();
    render(<Combobox id="c" label="Country" options={names(12)} value={null} onChange={() => {}} />);
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.keyboard('{ArrowDown}');
    const first = input.getAttribute('aria-activedescendant');
    await user.keyboard('{ArrowDown}');
    const second = input.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    expect(document.getElementById(second!)).toHaveAttribute('aria-selected');
    await user.keyboard('{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toBe(first);
  });

  it('Escape closes the listbox', async () => {
    const user = userEvent.setup();
    render(<Combobox id="c" label="Country" options={names(12)} value={null} onChange={() => {}} />);
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.type(input, 'ger');
    expect(screen.getByRole('listbox')).toBeVisible();
    await user.keyboard('{Escape}');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab closes and keeps an exact typed match', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Combobox id="c" label="Country" options={names(12)} value={null} onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Country' });
    await user.click(input);
    await user.type(input, 'spain');
    await user.tab();
    expect(onChange).toHaveBeenCalledWith('Spain');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the selected label when closed', () => {
    render(<Combobox id="c" label="Country" options={names(12)} value="Kenya" onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('Kenya');
  });
});
