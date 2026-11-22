import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CampaignDetail, RecipientCheck } from '../src/api/mailer';
import { t as translate } from '@dait-crm/shared';
import { MailerWizard, SendViaMailerButton } from '../src/pages/mailer/MailerWizard';
import { CampaignPage } from '../src/pages/mailer/CampaignPage';
import { pauseReasonText } from '../src/pages/mailer/status';
import { zoneText } from '../src/pages/mailer/zones';
import type { TFn } from '../src/i18n/useT';
import es from '../src/locales/es.json';
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

function stub(campaign?: CampaignDetail, rows: RecipientCheck[] = ROWS) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/mailer/check') {
      posts.push({ url, body });
      return Response.json({ mailbox: { address: 'arjun@daitpartners.com' }, rows });
    }
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
    wrap(<SendViaMailerButton leadIds={[5, 6]} onQueued={() => undefined} />);
    await u.click(screen.getByRole('button', { name: 'Send via mailer' }));
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
    expect(within(table).getByText(/· America\/Santiago$/)).toBeTruthy();
    expect(within(table).getByText('No email address')).toBeTruthy();
    expect(within(table).getByText('United States — all zones')).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Queue 1 email' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('Choose the lawful basis before sending');
    await u.selectOptions(within(dialog).getByLabelText(/Lawful basis/), 'Consent (they asked to be contacted)');
    await u.click(within(dialog).getByRole('button', { name: 'Queue 1 email' }));
    await waitFor(() => expect(posts[1]).toMatchObject({
      url: '/api/mailer',
      body: { leadIds: [5, 6], templateId: 3, cc: [], bcc: ['carlos@daitpartners.com'], startAt: null, intervalMinutes: 3, workingHoursOnly: true, unsubscribeLine: true, lawfulBasis: 'Consent (they asked to be contacted)' },
    }));
  });
});

describe('Send via mailer from the Leads bulk bar (prototype V.mailerWizard guard)', () => {
  it('send via mailer refuses when no ticked lead can be emailed', async () => {
    const u = userEvent.setup();
    const blocked: RecipientCheck[] = [ROWS[1]!, { ...ROWS[1]!, leadId: 7, leadNumber: 'LD-1007', block: 'Do not email' }];
    stub(undefined, blocked);
    wrap(<SendViaMailerButton leadIds={[6, 7]} onQueued={() => undefined} />);
    await u.click(screen.getByRole('button', { name: 'Send via mailer' }));
    expect(await screen.findByText('None of the selected leads can be emailed (no email address, …).')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Send via mailer' })).toBeNull();
  });

  it('one blocked lead: no ", …"', async () => {
    const u = userEvent.setup();
    stub(undefined, [ROWS[1]!]);
    wrap(<SendViaMailerButton leadIds={[6]} onQueued={() => undefined} />);
    await u.click(screen.getByRole('button', { name: 'Send via mailer' }));
    expect(await screen.findByText('None of the selected leads can be emailed (no email address).')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('more than 500 ticked leads shows the limit', async () => {
    const u = userEvent.setup();
    const posts = stub();
    wrap(<SendViaMailerButton leadIds={Array.from({ length: 501 }, (_, i) => i + 1)} onQueued={() => undefined} />);
    await u.click(screen.getByRole('button', { name: 'Send via mailer' }));
    expect(await screen.findByText('You can send to at most 500 leads in one run.')).toBeTruthy();
    expect(posts).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Mailer display helpers', () => {
  const tEs: TFn = (phrase, vars) => translate(es as Record<string, string>, phrase, vars);

  it('pause reason is translated', () => {
    expect(pauseReasonText(tEs, 'Paused by Carlos Torres')).toBe(tEs('Paused by {name}', { name: 'Carlos Torres' }));
    expect(pauseReasonText(tEs, 'Paused by Carlos Torres')).toContain('Carlos Torres');
    expect(pauseReasonText(tEs, 'Paused by Carlos Torres')).not.toBe('Paused by Carlos Torres');
    expect(pauseReasonText(tEs, 'Mailbox disconnected')).toBe(es['Mailbox disconnected']);
    expect(pauseReasonText(tEs, 'Mailbox needs reconnecting')).toBe((es as Record<string, string>)['Mailbox needs reconnecting']);
    expect(pauseReasonText(tEs, 'Mailbox needs reconnecting')).not.toBe('Mailbox needs reconnecting');
    expect(pauseReasonText(tEs, 'Something else')).toBe('Something else');
    expect(pauseReasonText(tEs, null)).toBeNull();
  });

  it('local time shows the current time there', () => {
    const tEn: TFn = (phrase, vars) => translate({}, phrase, vars);
    const now = new Date('2026-11-23T15:00:00.000Z');
    expect(zoneText(tEn, ['America/Chicago'], now)).toBe('09:00 · America/Chicago');
    expect(zoneText(tEn, ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'], now)).toBe('United States — all zones');
  });
});

const CAMPAIGN: CampaignDetail = {
  id: 7, number: 'MC-007', name: 'Chile · Nov', templateName: 'Intro ES', sender: { id: 2, name: 'Arjun Mehta' }, status: 'Sending', pauseReason: null,
  waitReason: 'working_hours', startAt: null, nextSendAt: null, createdAt: '2026-11-22T10:00:00.000Z', completedAt: null, intervalMinutes: 3, workingHoursOnly: true,
  stats: { total: 2, queued: 1, sending: 0, sent: 1, failed: 0, skipped: 0, toSend: 2, replied: 1 }, next: 'Luis Vega', templateUpdatedAt: null,
  subject: 'Hola {first_name}', body: 'Hola', senderAddress: 'arjun@daitpartners.com', cc: [], bcc: [], unsubscribeLine: true,
  lawfulBasis: 'Consent (they asked to be contacted)', isSender: true,
  recipients: [
    { id: 1, leadId: 5, leadNumber: 'LD-1005', name: 'Ana Torres', company: 'Andino', to: 'ana@andino.cl', status: 'Replied', sentAt: '2026-11-22T10:00:00.000Z', error: null, timezones: ['America/Santiago'], timezoneSource: 'country', messageId: '<abc@mail.outlook.com>' },
    { id: 2, leadId: 8, leadNumber: 'LD-1008', name: 'Luis Vega', company: 'Vega', to: 'luis@vega.mx', status: 'Queued', sentAt: null, error: null, timezones: ['America/Mexico_City'], timezoneSource: 'address', messageId: null },
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
    expect(within(recipients).getByText(/· America\/Mexico_City$/)).toBeTruthy();
    // Times, not just dates (prototype fmtDT): sent 10:00 UTC, the user's zone is UTC.
    expect(within(recipients).getByText('22/11/2026, 10:00')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/api/mailer/7/pause']));
  });

  it('campaign page has a Message column', async () => {
    stub(CAMPAIGN);
    wrap(<CampaignPage />, '/mailer/7');
    const recipients = await screen.findByRole('table', { name: 'Recipients' });
    const headers = within(recipients).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Lead', 'Name', 'To', 'Local time', 'Status', 'Sent at', 'Message']);
    const [, ana, luis] = within(recipients).getAllByRole('row');
    expect(within(ana!).getAllByRole('cell').at(-1)!.textContent).toBe('<abc@mail.outlook.com>');
    expect(within(luis!).getAllByRole('cell').at(-1)!.textContent).toBe('—');
  });

  it('a paused campaign shows its reason translated', async () => {
    stub({ ...CAMPAIGN, status: 'Paused', pauseReason: 'Paused by Carlos Torres', waitReason: null });
    wrap(<CampaignPage />, '/mailer/7');
    expect(await screen.findByText(/Paused by Carlos Torres/)).toBeTruthy();
  });

  it('an administrator viewing someone else’s campaign gets no actions', async () => {
    stub({ ...CAMPAIGN, isSender: false });
    wrap(<CampaignPage />, '/mailer/7');
    expect(await screen.findByRole('heading', { name: /MC-007/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel remaining' })).toBeNull();
  });
});
