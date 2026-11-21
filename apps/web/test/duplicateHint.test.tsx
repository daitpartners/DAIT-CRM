import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DuplicateResult } from '../src/api/companies';
import { DuplicateHint } from '../src/pages/companies/DuplicateHint';

const northwind = { id: 3, number: 'CO-0318', name: 'Northwind Logistics' };
const helix = { id: 9, number: 'CO-0320', name: 'Helix Dental Group' };

function renderHint(result: DuplicateResult) {
  return render(
    <MemoryRouter>
      <DuplicateHint result={result} />
    </MemoryRouter>,
  );
}

describe('DuplicateHint', () => {
  it('renders nothing when there are no matches', () => {
    const { container } = renderHint({ auto: null, review: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a blocking note naming the matched company for an automatic match', () => {
    renderHint({ auto: northwind, review: [] });
    const note = screen.getByRole('alert');
    expect(note).toHaveClass('note', 'danger');
    expect(note).toHaveTextContent('This looks like CO-0318 Northwind Logistics. Open it instead?');
    expect(within(note).getByRole('link')).toHaveAttribute('href', '/companies/3');
  });

  it('renders a list of links for possible duplicates', () => {
    renderHint({
      auto: null,
      review: [
        { candidate: northwind, how: 'name_country' },
        { candidate: helix, how: 'legal_name' },
      ],
    });
    const note = screen.getByRole('status');
    expect(note).toHaveClass('note', 'warn');
    expect(note).toHaveTextContent('Possible duplicates');
    const links = within(note).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent('CO-0318 Northwind Logistics');
    expect(links[0]).toHaveAttribute('href', '/companies/3');
    expect(links[1]).toHaveAttribute('href', '/companies/9');
  });
});
