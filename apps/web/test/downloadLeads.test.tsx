import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { keys, type Me } from '../src/api/queries';
import { leadsExportPath } from '../src/api/leads';
import { ToastProvider } from '../src/components/Toast';
import { DownloadLeadsButton } from '../src/pages/leads/DownloadLeadsButton';

const manager: Me = {
  id: 4, email: 'neha@daitpartners.com', name: 'Neha Kapoor', role: 'Manager', language: 'en', timezone: 'Europe/London',
  dateFormat: 'DD MMM YYYY', rights: ['manage_leads', 'view_all_leads', 'import_leads'],
};
const rep: Me = { ...manager, id: 7, name: 'Rita Rep', role: 'Sales Representative', rights: ['manage_leads', 'claim_leads'] };

function renderButton(me: Me) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DownloadLeadsButton query={{ page: 3, pageSize: 50, q: 'freight', status: 'New', tab: 'prospects', sort: 'companyName', dir: 'asc' }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Download all leads (Leads page)', () => {
  it('never shown to a Sales Representative (no import_leads; the Manager case is the download test below)', () => {
    renderButton(rep);
    expect(screen.queryByRole('button', { name: 'Download all leads' })).toBeNull();
  });

  it('downloads the leads of the current filters, search, tab and sort (no paging)', async () => {
    expect(leadsExportPath({ page: 3, pageSize: 50, q: 'freight', status: 'New' })).toBe('/api/leads/export.xlsx?q=freight&status=New');
    const fetchFn = vi.fn(async (_url: string) => new Response(new Blob(['PK']), {
      status: 200, headers: { 'content-disposition': 'attachment; filename="leads-2026-11-24.xlsx"' },
    }));
    vi.stubGlobal('fetch', fetchFn);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderButton(manager);
    await userEvent.click(screen.getByRole('button', { name: 'Download all leads' }));
    await waitFor(() => expect(clicked).toHaveBeenCalled());
    const url = (fetchFn.mock.calls as unknown[][]).map((c) => String(c[0])).find((u) => u.startsWith('/api/leads/')) ?? '';
    const params = new URLSearchParams(url.split('?')[1]);
    expect(url.split('?')[0]).toBe('/api/leads/export.xlsx');
    expect(Object.fromEntries(params)).toEqual({ q: 'freight', status: 'New', tab: 'prospects', sort: 'companyName', dir: 'asc' });
    clicked.mockRestore();
  });

  it('more than 20,000 matching leads: asks to narrow the filter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'too_many_rows', total: 20001 }, { status: 400 })));
    renderButton(manager);
    await userEvent.click(screen.getByRole('button', { name: 'Download all leads' }));
    expect(await screen.findByText(/more than 20,000 cannot be downloaded at once\. Narrow the filter/)).toBeInTheDocument();
  });
});
