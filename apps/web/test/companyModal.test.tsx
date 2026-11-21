import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { keys, type LookupValue, type Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { CompanyModal } from '../src/pages/companies/CompanyModal';

const me: Me = {
  id: 1, email: 'maya@daitpartners.com', name: 'Maya', role: 'Administrator', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: ['manage_companies'],
};

const lookup = (group: LookupValue['group'], value: string, id: number): LookupValue => ({
  id, group, value, label: value, labelEs: null, labelFr: null, sortOrder: id, isActive: true,
});

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(keys.me, me);
  qc.setQueryData(keys.lookups, {
    country: [lookup('country', 'India', 1), lookup('country', 'Germany', 2)],
    industry: [lookup('industry', 'Retail', 3)],
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <CompanyModal onClose={() => {}} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('CompanyModal', () => {
  it('shows the field message and the form note for a 400 with array issue paths', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/companies/check-duplicates') return Response.json({ auto: null, review: [] });
        if (url === '/api/companies') {
          return Response.json({ error: 'validation', issues: [{ path: ['industry'], message: 'x' }] }, { status: 400 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    renderModal();
    await user.type(screen.getByLabelText(/Company name/), 'Acme Retail');
    await user.selectOptions(screen.getByLabelText(/Country/), 'India');
    await user.selectOptions(screen.getByLabelText(/Industry/), 'Retail');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Check this value')).toBeInTheDocument();
    expect(screen.getByLabelText(/Industry/)).toHaveAccessibleDescription('Check this value');
    expect(await screen.findByText('Please check the highlighted fields')).toHaveClass('note');
  });
});

