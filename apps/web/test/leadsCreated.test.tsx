import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { LeadSummary } from '../src/api/leads';
import { keys, type Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { I18nProvider } from '../src/i18n';
import { LeadsList } from '../src/pages/leads/LeadsList';

const manager: Me = {
  id: 4, email: 'neha@daitpartners.com', name: 'Neha Kapoor', role: 'Manager', language: 'en', timezone: 'Europe/London',
  dateFormat: 'DD/MM/YYYY', rights: ['manage_leads', 'view_all_leads', 'import_leads'],
};

const lead = (id: number, extra: Partial<LeadSummary>): LeadSummary => ({
  id, number: `LD-10${id}`, leadType: 'Prospect', companyName: `Company ${id}`, companyId: null, company: null, contact: null,
  country: 'India', outreachLanguage: 'en', city: null, leadSource: 'Import', status: 'New', priority: 'Medium', assignedTo: null,
  nextFollowUp: null, isOverdue: false, archivedAt: null, createdAt: '2026-11-26T14:05:00.000Z', importBatch: null, importBatchId: null,
  updatedAt: '2026-11-26T14:05:00.000Z', ...extra,
} as LeadSummary);

const items = [
  lead(1, { importBatch: 'IMPORT-2026-11-22', importBatchId: 7 }),
  lead(2, { importBatch: 'CSV-20261120-0915', importBatchId: null }),
  lead(3, {}),
];

function renderList(me: Me) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/leads?')) {
      return Response.json({
        items, total: 3, page: 1, pageSize: 50,
        tiles: { newThisWeek: 0, followUpsDueToday: 0, unassigned: 0, unassignedProspects: 0, overdue: 0 },
        counts: { all: 3, leads: 0, prospects: 3, mine: 0, overdue: 0, unassigned: 3 },
      });
    }
    if (url === '/api/users') return Response.json({ items: [] });
    if (url === '/api/mailboxes') return Response.json({ mine: null });
    throw new Error(`unexpected fetch ${url}`);
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  qc.setQueryData(keys.lookups, { country: [], lead_source: [], lead_status: [] });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/leads']}>
            <Routes>
              <Route path="/leads" element={<LeadsList />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const createdCell = (number: string) => {
  const row = screen.getByRole('link', { name: number }).closest('tr')!;
  const cells = within(row).getAllByRole('cell');
  return cells[cells.length - 1]!;
};

afterEach(() => vi.unstubAllGlobals());

describe('Leads list: Created shows date, time and the upload (26 Nov 2026)', () => {
  it('date and 24-hour time in the viewer’s zone; an import links its batch number to the Data manager', async () => {
    renderList(manager);
    await screen.findByText('Company 1');
    const imported = createdCell('LD-101');
    expect(imported).toHaveClass('muted', 'nowrap');
    expect(imported).toHaveTextContent(/^26\/11\/2026, 14:05IMPORT-2026-11-22$/);
    const link = within(imported).getByRole('link', { name: 'Import batch IMPORT-2026-11-22' });
    expect(link).toHaveAttribute('href', '/leads/import/manager?batch=7');
    expect(link).toHaveClass('cell-sub');
    expect(link).toHaveTextContent('IMPORT-2026-11-22');

    // An older CSV import (not in the Data manager): the number as plain text.
    const csv = createdCell('LD-102');
    expect(within(csv).queryByRole('link')).toBeNull();
    expect(within(csv).getByText('CSV-20261120-0915')).toHaveAttribute('title', 'Import batch CSV-20261120-0915');
    // A lead made by hand: date and time only.
    expect(createdCell('LD-103')).toHaveTextContent(/^26\/11\/2026, 14:05$/);
  });

  it('in Spanish, in another time zone', async () => {
    renderList({ ...manager, language: 'es', timezone: 'Asia/Kolkata' });
    await screen.findByText('Company 1');
    const imported = createdCell('LD-101');
    expect(imported).toHaveTextContent(/^26\/11\/2026, 19:35IMPORT-2026-11-22$/);
    expect(within(imported).getByRole('link', { name: 'Lote de importación IMPORT-2026-11-22' })).toBeInTheDocument();
  });
});
