import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { quoteTotals } from '@dait-crm/shared';
import type { Me } from '../src/api/queries';
import type { QuotationDetail } from '../src/api/quotations';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { ToastProvider } from '../src/components/Toast';
import { QuotationEditor } from '../src/pages/quotations/QuotationEditor';
import { CompanyDetails } from '../src/pages/settings/CompanyDetails';
import { SettingsLayout } from '../src/pages/settings/SettingsLayout';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const seller: Me = { ...rep, rights: [...rep.rights, 'manage_quotes', 'use_email'] };
const admin: Me = {
  ...rep, id: 1, name: 'Maya Pillai', role: 'Administrator',
  rights: [...rep.rights, 'manage_quotes', 'use_email', 'manage_users', 'view_admin_settings', 'manage_lookups'],
};

type Line = QuotationDetail['lines'][number];
const line = (o: Partial<Line> = {}): Line => ({
  id: 11, sortOrder: 0, item: 'Consulting services', description: null, qty: 1, unit: 'project', unitPrice: 1000, discount: 0, total: 1000, ...o,
});

function detail(o: Partial<QuotationDetail> = {}): QuotationDetail {
  const base: QuotationDetail = {
    id: 7, number: 'Q-2026-007', status: 'Draft', revision: 1, editingNewRevision: false, locked: false, sending: false, canEdit: true,
    company: { id: 4, number: 'CO-0245', name: 'Meridian', legalName: 'Meridian Textiles Pvt Ltd', country: 'India' },
    contact: { id: 9, name: 'Tom Hale', email: 'tom@meridian.example' },
    lead: { id: 5, number: 'LD-1005', status: 'Qualified' },
    owner: { id: 2, name: 'Arjun Mehta' },
    quotationDate: '2026-11-20', validUntil: '2026-12-20', currency: 'INR', subject: 'Advisory services for Meridian',
    taxRate: 18, overallDiscount: 0, notes: 'Payment: 40% on acceptance.', projectId: null,
    lines: [line()],
    totals: quoteTotals({ lines: [{ qty: 1, price: 1000 }], taxRate: 18 }),
    displayTotals: { ...quoteTotals({ lines: [{ qty: 1, price: 1000 }], taxRate: 18 }), currency: 'INR' },
    revisions: [],
    history: [{ at: '2026-11-20T09:00:00.000Z', text: 'Draft created by Arjun Mehta' }],
    createdAt: '2026-11-20T09:00:00.000Z',
    updatedAt: '2026-11-20T09:00:00.000Z',
  };
  return { ...base, ...o };
}

const CONTACTS = [
  { id: 9, companyId: 4, firstName: 'Tom', lastName: 'Hale', designation: 'CFO', contactType: 'Decision maker', businessEmail: 'tom@meridian.example', isActive: true },
  { id: 10, companyId: 4, firstName: 'Ana', lastName: 'Ruiz', designation: null, contactType: 'Influencer', businessEmail: null, isActive: true },
];
const LEADS = [{ id: 5, number: 'LD-1005', companyId: 4, status: 'Qualified' }, { id: 8, number: 'LD-1008', companyId: 4, status: 'New' }];

type Call = { method: string; url: string; body?: Record<string, unknown> };

/**
 * `q` is what GET answers; `onWrite` answers PATCH / POST (default: the detail with the body applied and a new
 * updatedAt). Returns the recorded calls.
 */
function stub(q: QuotationDetail, onWrite?: (call: Call) => Response | undefined, me: Me = seller) {
  const calls: Call[] = [];
  let current = q;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined };
    calls.push(call);
    if (url === '/api/me') return Response.json(me);
    if (call.method !== 'GET') {
      const custom = onWrite?.(call);
      if (custom) {
        // A successful write to this quotation answers its new state, which later GETs return too.
        if (custom.ok && call.url.startsWith(`/api/quotations/${q.id}`) && !call.url.endsWith('/duplicate')) current = (await custom.clone().json()) as QuotationDetail;
        return custom;
      }
      if (url === `/api/quotations/${q.id}` && call.method === 'PATCH') {
        const { updatedAt: _u, lines, ...rest } = call.body ?? {};
        current = {
          ...current, ...(rest as Partial<QuotationDetail>), updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString(),
          ...(lines ? { lines: (lines as Line[]).map((l, i) => ({ ...l, id: 100 + i, sortOrder: i, total: l.qty * l.unitPrice * (1 - l.discount / 100) })) } : {}),
        };
        if (rest.currency && rest.taxRate === undefined) current = { ...current, taxRate: rest.currency === 'INR' ? 18 : 0 };
        return Response.json(current);
      }
      if (url === '/api/settings/company') return Response.json(call.body);
      const decided = { accept: 'Accepted', reject: 'Rejected', negotiate: 'Negotiating' }[url.split('/').pop() ?? ''] as QuotationDetail['status'] | undefined;
      if (decided) current = { ...current, status: decided, locked: decided !== 'Negotiating', canEdit: decided === 'Negotiating', editingNewRevision: false };
      return Response.json(current);
    }
    if (url.startsWith(`/api/quotations/${q.id}`)) return Response.json(current);
    const other = /^\/api\/quotations\/(\d+)$/.exec(url);
    if (other) return Response.json(detail({ id: Number(other[1]), number: `Q-2026-0${other[1]}` }));
    if (url.startsWith('/api/contacts')) return Response.json({ items: CONTACTS, total: CONTACTS.length, page: 1, pageSize: 100 });
    if (url.startsWith('/api/leads')) return Response.json({ items: LEADS, total: LEADS.length, page: 1, pageSize: 100 });
    if (url === '/api/settings/company') {
      return Response.json({
        legalName: 'DAIT Partners LLP', addressLines: ['D-303, Sagar Sadan', 'IP Extension', 'Delhi 110092', 'India'], email: 'info@daitpartners.com',
        gstin: null, taxInr: 18, taxUsd: 0, taxCad: 0, defaultNotes: 'Payment: 40% on acceptance.',
      });
    }
    return Response.json({});
  }));
  return calls;
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function mount(me: Me = seller, at = '/quotations/7') {
  const qc = makeClient(me);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[at]}>
            <Routes>
              <Route path="/quotations/:id" element={<QuotationEditor />} />
              <Route path="/settings" element={<SettingsLayout />}>
                <Route path="company" element={<CompanyDetails />} />
              </Route>
              <Route path="*" element={null} />
            </Routes>
            <Where />
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return qc;
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const rowOf = (item: string) => screen.getByDisplayValue(item).closest('tr') as HTMLElement;
const totalsBlock = () => document.querySelector('.totals') as HTMLElement;

describe('Quotation editor (prototype V.quoteEditor)', () => {
  it('shows the topbar, details, lines and totals as the prototype', async () => {
    stub(detail());
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Q-2026-007 · Meridian Textiles Pvt Ltd' })).toBeTruthy();
    expect(screen.getByText('Revision 1')).toHaveClass('badge', 'b-grey');
    expect(screen.getByText('Draft', { selector: '.topbar .badge' })).toBeTruthy();
    const sub = document.querySelector('.topbar .sub') as HTMLElement;
    expect(sub).toHaveTextContent('Lead LD-1005 · Contact Tom Hale · Company CO-0245 · Owner Arjun Mehta');
    expect(within(sub).getByRole('link', { name: 'LD-1005' })).toHaveAttribute('href', '/leads/5');
    expect(within(sub).getByRole('link', { name: 'CO-0245' })).toHaveAttribute('href', '/companies/4');
    expect(screen.getByRole('button', { name: 'Preview PDF' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send by email' })).toBeTruthy();

    expect(screen.getByLabelText('Quotation number')).toHaveValue('Q-2026-007');
    expect(screen.getByLabelText('Quotation number')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Company')).toHaveValue('Meridian Textiles Pvt Ltd · CO-0245');
    expect(screen.getByLabelText('Currency')).toHaveValue('INR');
    await waitFor(() => expect(screen.getByLabelText('Contact')).toHaveValue('9'));
    expect(within(screen.getByLabelText('Contact')).getByRole('option', { name: 'Tom Hale · CFO' })).toBeTruthy();
    expect(within(screen.getByLabelText('Lead')).getByRole('option', { name: 'LD-1008 · New' })).toBeTruthy();
    expect(screen.getByLabelText('Subject')).toHaveValue('Advisory services for Meridian');

    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Item', 'Qty', 'Unit', 'Unit price', 'Discount %', 'Line total', '']);
    expect(rowOf('Consulting services')).toHaveTextContent('1,000.00');
    const totals = totalsBlock();
    expect(totals).toHaveTextContent('Subtotal1,000.00');
    expect(totals).toHaveTextContent('Line discounts− 0.00');
    expect(totals).toHaveTextContent('GST');
    expect(totals).toHaveTextContent('180.00');
    expect(totals).toHaveTextContent('Total INR1,180.00');
    for (const h of ['Status', 'Revisions', 'History', 'On accept']) expect(screen.getByRole('heading', { level: 2, name: h })).toBeTruthy();
    expect(screen.getByText(/Lead moves to/)).toHaveTextContent(
      'Lead moves to Won, the company gets a Client flag, and "Convert to project" creates a project with these line items as the scope. No new company or contact record is created.',
    );
    expect(screen.getByText('Rev 1 · editing')).toBeTruthy();
  });

  it('totals update as you type, then the lines are saved with updatedAt', async () => {
    const calls = stub(detail());
    mount();
    await screen.findByDisplayValue('Consulting services');
    const row = rowOf('Consulting services');
    const qty = within(row).getByLabelText('Qty');
    fireEvent.change(qty, { target: { value: '3' } });
    fireEvent.change(within(row).getByLabelText('Discount %'), { target: { value: '10' } });
    // Live, before any save: 3 × 1,000 less 10% = 2,700; GST 18% = 486; total 3,186.
    expect(row).toHaveTextContent('2,700.00');
    expect(totalsBlock()).toHaveTextContent('Subtotal3,000.00');
    expect(totalsBlock()).toHaveTextContent('Line discounts− 300.00');
    expect(totalsBlock()).toHaveTextContent('Total INR3,186.00');
    await waitFor(() => expect(patches(calls)).toHaveLength(1), { timeout: 3000 });
    const body = patches(calls)[0]!.body!;
    expect(body.updatedAt).toBe('2026-11-20T09:00:00.000Z');
    expect(body.lines).toEqual([{ item: 'Consulting services', description: null, qty: 3, unit: 'project', unitPrice: 1000, discount: 10 }]);
  });

  it('+ Add line adds the prototype line and × removes one', async () => {
    const calls = stub(detail());
    mount();
    await screen.findByDisplayValue('Consulting services');
    await userEvent.click(screen.getByRole('button', { name: '+ Add line' }));
    expect(screen.getByDisplayValue('New line')).toBeTruthy();
    await userEvent.click(within(rowOf('Consulting services')).getByRole('button', { name: 'Remove line' }));
    expect(screen.queryByDisplayValue('Consulting services')).toBeNull();
    await waitFor(() => expect(patches(calls).length).toBeGreaterThan(0), { timeout: 3000 });
    expect(patches(calls).at(-1)!.body!.lines).toEqual([{ item: 'New line', description: null, qty: 1, unit: 'unit', unitPrice: 0, discount: 0 }]);
  });

  it('changing the currency resets GST to that currency\'s default (the server applies Company details)', async () => {
    const calls = stub(detail());
    mount();
    await screen.findByDisplayValue('Consulting services');
    const gst = screen.getByLabelText('GST %');
    expect(gst).toHaveValue(18);
    await userEvent.selectOptions(screen.getByLabelText('Currency'), 'USD');
    expect(gst).toHaveValue(0);
    expect(totalsBlock()).toHaveTextContent('Total USD1,000.00');
    await waitFor(() => expect(patches(calls)).toHaveLength(1), { timeout: 3000 });
    expect(patches(calls)[0]!.body!.currency).toBe('USD');
    expect(patches(calls)[0]!.body).not.toHaveProperty('taxRate');
  });

  it('the first edit on a Sent quotation toasts "Revision n opened · previous version kept"', async () => {
    const sent = detail({
      status: 'Sent', revision: 1,
      revisions: [{ revisionNo: 1, sentAt: '2026-11-20T10:00:00.000Z', sentTo: 'tom@meridian.example', subtotal: 1000, discountTotal: 0, taxTotal: 180, grandTotal: 1180, note: 'Sent by email as PDF', currency: 'INR' }],
    });
    stub(sent, (c) => (c.method === 'PATCH' ? Response.json({ ...sent, revision: 2, editingNewRevision: true, updatedAt: '2026-11-20T11:00:00.000Z' }) : undefined));
    mount();
    await screen.findByText('Rev 1 · current');
    fireEvent.change(screen.getByLabelText('Overall discount %'), { target: { value: '5' } });
    expect(await screen.findByText('Revision 2 opened · previous version kept', {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText('Revision 2 · editing')).toHaveClass('badge');
    expect(screen.getByText('Rev 2 · editing')).toBeTruthy();
    expect(screen.getByText(/Rev 1 · sent/)).toBeTruthy();
  });

  it('a stale save toasts and reloads the quotation', async () => {
    stub(detail(), (c) => (c.method === 'PATCH' ? Response.json({ error: 'stale' }, { status: 409 }) : undefined));
    mount();
    await screen.findByDisplayValue('Consulting services');
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Changed subject' } });
    expect(await screen.findByText('Someone else changed this record. Reload and try again.', {}, { timeout: 3000 })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveValue('Advisory services for Meridian'));
  });

  it('a locked quotation hides Send by email and editing; Duplicate stays; Convert to project waits for 3B', async () => {
    stub(detail({ status: 'Accepted', locked: true, canEdit: false }));
    mount();
    await screen.findByDisplayValue('Consulting services');
    expect(screen.queryByRole('button', { name: 'Send by email' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add line' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove line' })).toBeNull();
    expect(screen.getByDisplayValue('Consulting services')).toBeDisabled();
    expect(screen.getByLabelText('Subject')).toBeDisabled();
    expect(screen.getByLabelText('GST %')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Mark accepted' })).toBeNull();
    const convert = screen.getByRole('button', { name: 'Convert to project' });
    expect(convert).toBeDisabled();
    expect(convert).toHaveAttribute('title', 'Available in release 3B');
  });

  it('Duplicate opens the new Draft', async () => {
    const calls = stub(detail({ status: 'Accepted', locked: true, canEdit: false }), (c) =>
      c.url.endsWith('/duplicate') ? Response.json(detail({ id: 12, number: 'Q-2026-012' }), { status: 201 }) : undefined);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/quotations/12'));
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/quotations/7/duplicate')).toBe(true);
    expect(await screen.findByText('Duplicated as Q-2026-012')).toBeTruthy();
  });

  it('status buttons: Mark negotiating only when Sent; Mark accepted posts to accept', async () => {
    const calls = stub(detail({ status: 'Sent' }));
    mount();
    await screen.findByDisplayValue('Consulting services');
    const buttons = within(screen.getByRole('heading', { level: 2, name: 'Status' }).closest('section') as HTMLElement).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Mark accepted', 'Mark rejected', 'Mark negotiating']);
    await userEvent.click(screen.getByRole('button', { name: 'Mark accepted' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/quotations/7/accept')).toBe(true));
    expect(calls.find((c) => c.url === '/api/quotations/7/accept')!.body).toEqual({});
    expect(await screen.findByText('Q-2026-007 marked Accepted')).toBeTruthy();
  });

  it('accepting while revision n+1 is unsent asks first, then sends discardUnsent', async () => {
    const calls = stub(detail({ status: 'Sent', revision: 2, editingNewRevision: true }));
    mount();
    await screen.findByDisplayValue('Consulting services');
    await userEvent.click(screen.getByRole('button', { name: 'Mark accepted' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Revision 2 has unsent changes — they will be discarded');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark accepted' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/quotations/7/accept')?.body).toEqual({ discardUnsent: true }));
  });

  it('cancelling that confirm sends nothing', async () => {
    const calls = stub(detail({ status: 'Negotiating', revision: 2, editingNewRevision: true }));
    mount();
    await screen.findByDisplayValue('Consulting services');
    await userEvent.click(screen.getByRole('button', { name: 'Mark rejected' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url.endsWith('/reject'))).toBe(false);
  });

  it('Send by email needs a contact with an email address (prototype toast)', async () => {
    const calls = stub(detail({ contact: { id: 10, name: 'Ana Ruiz', email: null } }));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send by email' }));
    expect(await screen.findByText('Choose a contact with an email address before sending')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/send'))).toBe(false);
  });

  it('the send dialog: prototype text, To read-only, the message editable and sent', async () => {
    const calls = stub(detail(), (c) => (c.url.endsWith('/send') ? Response.json(detail({ sending: true, canEdit: false }), { status: 202 }) : undefined));
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Send by email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send Q-2026-007 by email' });
    expect(dialog).toHaveTextContent(
      'A PDF of revision 1 (INR 1,180.00) is attached and the revision is frozen. The lead moves to Proposal Sent if it is earlier in the pipeline.',
    );
    expect(within(dialog).getByLabelText('To')).toHaveValue('tom@meridian.example');
    expect(within(dialog).getByLabelText('To')).toHaveAttribute('readonly');
    const message = within(dialog).getByLabelText('Message');
    expect(message).toHaveValue('Please find attached quotation Q-2026-007 (revision 1), valid until 20 Dec 2026.');
    await userEvent.clear(message);
    await userEvent.type(message, 'Hello Tom');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/quotations/7/send')?.body).toEqual({ body: 'Hello Tom' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Sending…' })).toBeDisabled();
  });

  it('while sending the editor is read-only and shows "Sending…"', async () => {
    stub(detail({ status: 'Sent', sending: true, canEdit: false }));
    mount();
    await screen.findByDisplayValue('Consulting services');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByDisplayValue('Consulting services')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '+ Add line' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark accepted' })).toBeDisabled();
  });

  it('Preview PDF shows the PDF in a dialog with Download', async () => {
    stub(detail());
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Preview PDF' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quotation Q-2026-007' });
    expect(dialog.querySelector('iframe')).toHaveAttribute('src', '/api/quotations/7/pdf#toolbar=0&navpanes=0&view=FitH');
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/quotations/7/pdf');
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'Q-2026-007-rev1.pdf');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clearing the lead hides the quotation from this user: treated as saved', async () => {
    stub(detail(), (c) => (c.method === 'PATCH' ? Response.json({ error: 'not_found' }, { status: 404 }) : undefined));
    mount();
    await waitFor(() => expect(screen.getByLabelText('Lead')).toHaveValue('5'));
    await userEvent.selectOptions(screen.getByLabelText('Lead'), '');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/quotations$/), { timeout: 3000 });
    expect(await screen.findByText('Saved · without its lead you can no longer see this quotation')).toBeTruthy();
  });
});

describe('Settings → Company details', () => {
  it('Administrators edit and save the issuer and defaults', async () => {
    const calls = stub(detail(), undefined, admin);
    mount(admin, '/settings/company');
    expect(await screen.findByRole('link', { name: 'Company details' })).toBeTruthy();
    const name = await screen.findByLabelText(/^Legal name/);
    await waitFor(() => expect(name).toHaveValue('DAIT Partners LLP'));
    expect(screen.getByLabelText('Address')).toHaveValue('D-303, Sagar Sadan\nIP Extension\nDelhi 110092\nIndia');
    expect(screen.getByLabelText(/^Email/)).toHaveValue('info@daitpartners.com');
    expect(screen.getByLabelText('GSTIN')).toHaveValue('');
    expect(screen.getByLabelText('Default GST % · INR')).toHaveValue(18);
    expect(screen.getByLabelText('Default GST % · USD')).toHaveValue(0);
    expect(screen.getByLabelText('Default GST % · CAD')).toHaveValue(0);
    await userEvent.type(screen.getByLabelText('GSTIN'), '07aaafd1234a1z5');
    await userEvent.clear(screen.getByLabelText('Default GST % · CAD'));
    await userEvent.type(screen.getByLabelText('Default GST % · CAD'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/company')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      legalName: 'DAIT Partners LLP', addressLines: ['D-303, Sagar Sadan', 'IP Extension', 'Delhi 110092', 'India'], email: 'info@daitpartners.com',
      gstin: '07aaafd1234a1z5', taxInr: 18, taxUsd: 0, taxCad: 5, defaultNotes: 'Payment: 40% on acceptance.',
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('is hidden from sales representatives', async () => {
    stub(detail());
    mount(seller, '/settings/company');
    expect(await screen.findByText('You do not have access')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Company details' })).toBeNull();
    expect(screen.queryByLabelText(/^Legal name/)).toBeNull();
  });
});
