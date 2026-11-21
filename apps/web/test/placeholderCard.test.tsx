import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaceholderCard } from '../src/components/PlaceholderCard';

describe('PlaceholderCard', () => {
  it('renders title and "Available in release 2"', () => {
    render(<PlaceholderCard title="Projects" release="2" hint="Projects linked to this contact appear here." />);
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByText('Available in release 2')).toBeInTheDocument();
    expect(screen.getByText('Projects linked to this contact appear here.')).toBeInTheDocument();
  });

  it('placeholder has no enabled controls', () => {
    const { container } = render(<PlaceholderCard title="Email" release="2" />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).toHaveAttribute('aria-disabled', 'true');
    const controls = container.querySelectorAll('button, a[href], input, select, textarea, [tabindex], [role=button], [role=link]');
    const enabled = Array.from(controls).filter((el) => !(el as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('omits the hint line when no hint is given', () => {
    const { container } = render(<PlaceholderCard title="Original enquiry" release="1D" />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(screen.getByText('Available in release 1D')).toBeInTheDocument();
  });
});
