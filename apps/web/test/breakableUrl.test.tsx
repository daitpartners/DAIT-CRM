import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { breakableUrl } from '../src/pages/companies/tabs/OverviewTab';

describe('breakableUrl (review #31, M-8)', () => {
  it('keeps the text and adds a break chance after each separator', () => {
    const { container } = render(<span>{breakableUrl('linkedin.com/company/northwind-logistics/')}</span>);
    expect(container.textContent).toBe('linkedin.com/company/northwind-logistics/');
    expect(container.querySelectorAll('wbr')).toHaveLength(4);
    expect(container.innerHTML).toBe('<span>linkedin.<wbr>com/<wbr>company/<wbr>northwind-<wbr>logistics/</span>');
  });

  it('a word without separators stays whole', () => {
    const { container } = render(<span>{breakableUrl('northwind')}</span>);
    expect(container.innerHTML).toBe('<span>northwind</span>');
  });
});
