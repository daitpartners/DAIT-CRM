import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CampaignDetail, RecipientCheck } from '../src/api/mailer';
import { MailerWizard } from '../src/pages/mailer/MailerWizard';
import { CampaignPage } from '../src/pages/mailer/CampaignPage';
import { ToastProvider } from '../src/components/Toast';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { keys } from '../src/api/queries';
import { makeClient, rep } from './leadFixture';

afterEach(() => vi.unstubAllGlobals());
const me = { ...rep, rights: [...rep.rights, 'use_email' as const] };

const ROWS: RecipientCheck[] = [
  { leadId: 5, leadNumber: 'LD-1005', contactId: 9, to: 'ana@andino.cl', name: 'Ana Torres', company: 'Andino', block: null, zones: ['America/Santiago'], source: 'country' },
  { leadId: 6, leadNumber: 'LD-1006', contactId: null, to: '', name: '', company: 'Nomail', block: 'No email address', zones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'], source: 'country' },
];
const TEMPLATE = { id: 3, name: 'Intro ES', language: 'es', subject: 'Hola {first_name}', body: 'Hola {first_name} de {company}.\n{me}', sourceType: 'manual', fileName: null, fileSize: null, createdBy: null, createdAt: '', updatedAt: '' };

function stub(campaign?: CampaignDetail) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/mailer/check') return Response.json({ mailbox: { address: 'arjun@daitpartners.com' }, rows: ROWS });
    if (init?.method === 'POST') {
      posts.push({ url, body });
      return Response.json(campaign ? { ...campaign, status: url.endsWith('/pause') ? 'Paused' : campaign.status } : { id: 7 }, { status: 201 });
    }
    if (url.startsWith('/api/email-templates')) return Response.json({ items: [TEMPLATE] });
    if (url === '/api/users') return Response.json([{ id: 4, name: 'Carlos Torres', email: 'carlos@daitpartners.com', role: 'Administrator', isActive: true }]);
    if (url === '/api/mailer/7' && campaign) return Response.json(campaign);
    if (url === '/api/me') return Response.json(me);
    return Response.json({});
  }));
  return posts;
}

function wrap(ui: React.ReactNode, path = '/') {
  const qc = makeClient(me);
  qc.setQueryData(keys.users, [{ id: 4, name: 'Carlos Torres', email: 'carlos@daitpartners.com', role: 'Administrator', language: 'es', timezone: 'UTC', isActive: true, lastLoginAt: null }]);
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/" element={ui} />
              <Route path="/mailer/:id" element={ui} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Send via mailer wizard (release 2C, prototype V.mailerWizard)', () => {
  it('walks Template → Cc/Bcc → Timing → Review and queues the campaign', async () => {
    const u = userEvent.setup();
    const posts = stub();
    wrap(<MailerWizard leadIds={[5, 6]} onClose={() => undefined} onQueued={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Send via mailer' });
    // Step 1: template + preview for the first sendable lead.
    expect(await within(dialog).findByText('Hola Ana')).toBeTruthy();
    expect(within(dialog).getByText(/Preview for Ana Torres · ana@andino.cl/)).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    // Step 2: Cc / Bcc, a bad address is refused.
    await u.type(within(dialog).getByRole('textbox', { name: /^Bcc/ }), 'nope');
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('“nope” is not a full email address');
    await u.clear(within(dialog).getByRole('textbox', { name: /^Bcc/ }));
    await u.click(within(within(dialog).getByRole('group', { name: 'Bcc' })).getByRole('button', { name: '+ Carlos Torres' }));
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    // Step 3: timing; working hours are the client's.
    await u.click(within(dialog).getByLabelText(/Only send in the client's working hours/));
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    // Step 4: review with local time, lawful basis required.
    const table = within(dialog).getByRole('table');
    expect(within(table).getByText('America/Santiago')).toBeTruthy();
    expect(within(table).getByText('No email address')).toBeTruthy();
    expect(within(table).getByText('United States — all zones')).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Queue 1 email' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('Choose the lawful basis before sending');
    await u.selectOptions(within(dialog).getByLabelText(/Lawful basis/), 'Consent (they asked to be contacted)');
    await u.click(within(dialog).getByRole('button', { name: 'Queue 1 email' }));
    await waitFor(() => expect(posts[0]).toMatchObject({
      url: '/api/mailer',
      body: { leadIds: [5, 6], templateId: 3, cc: [], bcc: ['carlos@daitpartners.com'], startAt: null, intervalMinutes: 3, workingHoursOnly: true, unsubscribeLine: true, lawfulBasis: 'Consent (they asked to be contacted)' },
    }));
  });
});

const CAMPAIGN: CampaignDetail = {
  id: 7, number: 'MC-007', name: 'Chile · Nov', templateName: 'Intro ES', sender: { id: 2, name: 'Arjun Mehta' }, status: 'Sending', pauseReason: null,
  waitReason: 'working_hours', startAt: null, nextSendAt: null, createdAt: '2026-11-22T10:00:00.000Z', completedAt: null, intervalMinutes: 3, workingHoursOnly: true,
  stats: { total: 2, queued: 1, sending: 0, sent: 1, failed: 0, skipped: 0, toSend: 2, replied: 1 }, next: 'Luis Vega', templateUpdatedAt: null,
  subject: 'Hola {first_name}', body: 'Hola', senderAddress: 'arjun@daitpartners.com', cc: [], bcc: [], unsubscribeLine: true,
  lawfulBasis: 'Consent (they asked to be contacted)', isSender: true,
  recipients: [
    { id: 1, leadId: 5, leadNumber: 'LD-1005', name: 'Ana Torres', company: 'Andino', to: 'ana@andino.cl', status: 'Replied', sentAt: '2026-11-22T10:00:00.000Z', error: null, timezones: ['America/Santiago'], timezoneSource: 'country' },
    { id: 2, leadId: 8, leadNumber: 'LD-1008', name: 'Luis Vega', company: 'Vega', to: 'luis@vega.mx', status: 'Queued', sentAt: null, error: null, timezones: ['America/Mexico_City'], timezoneSource: 'address' },
  ],
};

describe('Campaign page (prototype mailer detail)', () => {
  it('shows tiles, the waiting reason, recipients with local time, and pauses after confirming nothing', async () => {
    const u = userEvent.setup();
    const posts = stub(CAMPAIGN);
    wrap(<CampaignPage />, '/mailer/7');
    expect(await screen.findByRole('heading', { name: /MC-007 · Chile · Nov/ })).toBeTruthy();
    expect(screen.getByText(/Waiting for the client's working hours/)).toBeTruthy();
    const recipients = screen.getByRole('table', { name: 'Recipients' });
    expect(within(recipients).getByText('Replied')).toBeTruthy();
    expect(within(recipients).getByText('America/Mexico_City')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/api/mailer/7/pause']));
  });

  it('an administrator viewing someone else’s campaign gets no actions', async () => {
    stub({ ...CAMPAIGN, isSender: false });
    wrap(<CampaignPage />, '/mailer/7');
    expect(await screen.findByRole('heading', { name: /MC-007/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel remaining' })).toBeNull();
  });
});
