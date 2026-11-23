import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CompanyDetail } from '../src/api/companies';
import type { Me } from '../src/api/queries';
import type { SourceRow } from '../src/api/research';
import { SourcesTab } from '../src/pages/companies/tabs/AiTabs';
import { Wrap, makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());

const COMPANY = { id: 4, number: 'CO-0318', name: 'Northwind Logistics' } as unknown as CompanyDetail;

const ROWS: SourceRow[] = [
  { id: 2, title: 'Northwind Logistics · About us', url: 'https://northwind.in/about', sourceType: 'Company website', collectedAt: '2026-11-23T09:00:00.000Z',
    collectedBy: 'Website reader', fieldsPopulated: 'Year established, City', confidence: '70–90', snapshot: 'Founded in 2004 in Pune.' },
  { id: 1, title: 'Trade fair list (manual)', url: null, sourceType: 'Business directory', collectedAt: '2026-11-22T09:00:00.000Z',
    collectedBy: 'Arjun Mehta (manual)', fieldsPopulated: null, confidence: 'Manual', snapshot: null },
];

type Call = { method: string; url: string; body?: unknown };

let signedIn: Me = rep;

function stub(items: SourceRow[] = ROWS, postStatus = 201) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/me') return Response.json(signedIn);
    if (method === 'GET' && url === '/api/companies/4/sources') return Response.json({ items });
    if (method === 'POST' && url === '/api/companies/4/sources') {
      return postStatus === 201
        ? Response.json({ ...ROWS[1], id: 3, title: 'Chamber listing' }, { status: 201 })
        : Response.json({ error: 'validation', issues: [{ path: ['url'], message: 'Invalid url' }] }, { status: 400 });
    }
    return Response.json({});
  }));
  return calls;
}

function mount(me: Me = rep) {
  signedIn = me;
  render(
    <Wrap qc={makeClient(me)}>
      <SourcesTab company={COMPANY} />
    </Wrap>,
  );
}

const table = () => screen.getByRole('region', { name: /Research sources/ });

describe('Research Sources tab (prototype views-companies.js tab sources)', () => {
  it('empty: the hint, the foot text, "No sources recorded." and no snapshot card', async () => {
    stub([]);
    mount();
    expect(await screen.findByText('No sources recorded.')).toBeInTheDocument();
    expect(table()).toHaveTextContent('source_records · every URL and dataset the profile was built from');
    expect(table()).toHaveTextContent(
      'Only approved sources are used: public websites, the approved Google Places integration, licensed directories, CSV imports and visitor submissions. No invented values: missing facts stay NULL.',
    );
    expect(within(table()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(
      ['Source', 'Type', 'Collected', 'By', 'Fields populated', 'Confidence'],
    );
    expect(screen.queryByRole('region', { name: /Snapshot/ })).toBeNull();
  });

  it('rows link to their URL; the newest record with a snapshot shows read only', async () => {
    stub();
    mount();
    const about = await screen.findByRole('row', { name: /About us/ });
    expect(within(about).getByRole('link', { name: 'Northwind Logistics · About us' })).toHaveAttribute('href', 'https://northwind.in/about');
    expect(about).toHaveTextContent('Company website');
    expect(about).toHaveTextContent('Website readerYear established, City70–90');
    const manual = screen.getByRole('row', { name: /Trade fair list/ });
    expect(within(manual).queryByRole('link')).toBeNull();
    expect(manual).toHaveTextContent('Arjun Mehta (manual)—Manual');
    const snap = screen.getByRole('region', { name: /Snapshot/ });
    expect(within(snap).getByRole('heading')).toHaveTextContent('Snapshot · Northwind Logistics · About us read only');
    expect(snap).toHaveTextContent('Founded in 2004 in Pune.');
  });

  it('+ Add source manually posts the dialog and toasts "Source recorded"', async () => {
    const u = userEvent.setup();
    const calls = stub();
    mount();
    await u.click(await screen.findByRole('button', { name: '+ Add source manually' }));
    const dlg = screen.getByRole('dialog', { name: 'Add research source' });
    await u.click(within(dlg).getByRole('button', { name: 'Add' }));
    expect(within(dlg).getByText('Enter a title')).toBeInTheDocument();
    await u.type(within(dlg).getByLabelText(/Title/), 'Chamber listing');
    await u.type(within(dlg).getByLabelText('URL'), 'https://chamber.example/northwind');
    await u.selectOptions(within(dlg).getByLabelText('Type'), 'Business directory');
    await u.type(within(dlg).getByLabelText('Fields populated'), 'Street address');
    await u.type(within(dlg).getByLabelText('Notes'), 'Listed as a member since 2010.');
    await u.click(within(dlg).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Source recorded')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { title: 'Chamber listing', url: 'https://chamber.example/northwind', sourceType: 'Business directory', fieldsPopulated: 'Street address', notes: 'Listed as a member since 2010.' },
    ]);
  });

  it('a URL the server refuses is shown on the field', async () => {
    const u = userEvent.setup();
    stub(ROWS, 400);
    mount();
    await u.click(await screen.findByRole('button', { name: '+ Add source manually' }));
    const dlg = screen.getByRole('dialog', { name: 'Add research source' });
    await u.type(within(dlg).getByLabelText(/Title/), 'Chamber listing');
    await u.type(within(dlg).getByLabelText('URL'), 'chamber');
    await u.click(within(dlg).getByRole('button', { name: 'Add' }));
    expect(await within(dlg).findByText('Enter a valid web address, for example https://example.com')).toBeInTheDocument();
  });

  it('a user who may not edit companies has no Add button', async () => {
    stub();
    mount({ ...rep, rights: ['manage_leads'] });
    await screen.findByRole('row', { name: /About us/ });
    expect(screen.queryByRole('button', { name: '+ Add source manually' })).toBeNull();
  });
});
