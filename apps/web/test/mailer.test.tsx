import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CampaignDetail, RecipientCheck } from '../src/api/mailer';
import { t as translate } from '@dait-crm/shared';
import { MailerWizard, SendViaMailerButton } from '../src/pages/mailer/MailerWizard';
import { CampaignPage } from '../src/pages/mailer/CampaignPage';
import { LeadsBulkBar } from '../src/pages/leads/LeadsBulkBar';
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

const CARLOS = { id: 4, name: 'Carlos Torres', email: 'carlos@daitpartners.com', role: 'Administrator', language: 'es', timezone: 'UTC', isActive: true, lastLoginAt: null };

function stub(campaign?: CampaignDetail, rows: RecipientCheck[] = ROWS, users: unknown[] = [CARLOS], mailbox: { address: string } | null = { address: 'arjun@daitpartners.com' }) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/mailer/check') {
      posts.push({ url, body });
      return Response.json({ mailbox, rows });
    }
    if (init?.method === 'POST') {
      posts.push({ url, body });
      return Response.json(campaign ? { ...campaign, status: url.endsWith('/pause') ? 'Paused' : campaign.status } : { id: 7 }, { status: 201 });
    }
    if (url.startsWith('/api/email-templates')) return Response.json({ items: [TEMPLATE] });
    if (url === '/api/users') return Response.json({ items: users });
    if (url === '/api/mailer/7' && campaign) return Response.json(campaign);
    if (url === '/api/me') return Response.json(me);
    return Response.json({});
  }));
  return posts;
}

function wrap(ui: React.ReactNode, path = '/', users: unknown[] = [CARLOS]) {
  const qc = makeClient(me);
  qc.setQueryData(keys.users, users);
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
    // Review #21: Legitimate interest is pre-selected (prototype); clearing it marks the field itself, and the
    // summary no longer says the emails will be queued.
    const law = within(dialog).getByLabelText(/Lawful basis/);
    expect(law).toHaveValue('Legitimate interest (B2B outreach relevant to their role)');
    await u.selectOptions(law, '');
    await u.click(within(dialog).getByRole('button', { name: 'Queue 1 email' }));
    expect(law).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Choose the lawful basis before sending')).toHaveClass('err-msg');
    expect(within(dialog).queryByText('1 email will be queued.')).toBeNull();
    await u.selectOptions(law, 'Consent (they asked to be contacted)');
    expect(within(dialog).getByText('1 email will be queued.')).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Queue 1 email' }));
    await waitFor(() => expect(posts[1]).toMatchObject({
      url: '/api/mailer',
      body: { leadIds: [5, 6], templateId: 3, cc: [], bcc: ['carlos@daitpartners.com'], startAt: null, intervalMinutes: 3, workingHoursOnly: true, unsubscribeLine: true, lawfulBasis: 'Consent (they asked to be contacted)' },
    }));
  });
});

describe('Send via mailer wizard matches the prototype (parity 6.x)', () => {
  async function open(u: ReturnType<typeof userEvent.setup>, users?: unknown[]) {
    stub(undefined, ROWS, users);
    wrap(<SendViaMailerButton leadIds={[5, 6]} onQueued={() => undefined} />, '/', users);
    await u.click(screen.getByRole('button', { name: 'Send via mailer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send via mailer' });
    await within(dialog).findByText('Hola Ana');
    return dialog;
  }

  it('default campaign name uses the user’s date format (6.2)', async () => {
    const u = userEvent.setup();
    const dialog = await open(u);
    const today = new Date().toISOString().slice(0, 10).split('-'); // the user's zone is UTC
    expect((within(dialog).getByLabelText('Campaign name') as HTMLInputElement).value).toBe(`Mailer · ${today[2]}/${today[1]}/${today[0]} · 1 lead`);
  });

  it('step 1 shows the merge fields as code (6.3)', async () => {
    const u = userEvent.setup();
    const dialog = await open(u);
    expect([...dialog.querySelectorAll('.mw-help code')].map((c) => c.textContent)).toEqual(['{first_name}', '{company}', '{me}', '{lead_id}']);
    expect(within(dialog).getByText(/From: arjun@daitpartners.com\./)).toBeTruthy();
  });

  it('step 2 focuses Cc, has the prototype placeholder, and lists colleagues in user order (6.4, 6.5)', async () => {
    const u = userEvent.setup();
    const users = [
      { ...CARLOS, id: 4, name: 'Zoe Admin', email: 'zoe@daitpartners.com' },
      { ...CARLOS, id: 8, name: 'Ana Rep', email: 'ana@daitpartners.com' },
    ];
    const dialog = await open(u, users);
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    const cc = within(dialog).getByRole('textbox', { name: /^Cc/ });
    expect(document.activeElement).toBe(cc);
    expect(cc.getAttribute('placeholder')).toBe('name@company.com, another@company.com');
    expect(within(dialog).getByRole('textbox', { name: /^Bcc/ }).getAttribute('placeholder')).toBe('name@company.com');
    const quick = within(within(dialog).getByRole('group', { name: 'Cc' })).getAllByRole('button').map((b) => b.textContent);
    expect(quick).toEqual(['+ Zoe Admin', '+ Ana Rep']);
  });

  it('step 3 note carries the prototype Microsoft 365 limits sentence (6.7)', async () => {
    const u = userEvent.setup();
    const dialog = await open(u);
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(dialog.querySelector('.note.info')!.textContent).toContain("That is far inside Microsoft 365's limits (about 30 a minute, 10,000 recipients a day).");
  });

  it('the bulk-bar button is primary with the send icon (6.10)', () => {
    stub();
    wrap(<SendViaMailerButton leadIds={[5]} onQueued={() => undefined} />);
    const b = screen.getByRole('button', { name: 'Send via mailer' });
    expect(b.className).toContain('primary');
    expect(b.querySelector('svg')).toBeTruthy();
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

  it('a mailbox disconnected since the page loaded is refused on Send via mailer, before the wizard', async () => {
    const u = userEvent.setup();
    stub(undefined, ROWS, [CARLOS], null);
    wrap(<SendViaMailerButton leadIds={[5]} onQueued={() => undefined} />);
    await u.click(screen.getByRole('button', { name: 'Send via mailer' }));
    expect(await screen.findByText('Connect your Microsoft 365 mailbox in Settings to send email from the CRM.')).toBeTruthy();
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

describe('Leads bulk bar (prototype views-leads2.js .mbulk, parity 6.10)', () => {
  const bar = (props: Partial<React.ComponentProps<typeof LeadsBulkBar>> = {}) => (
    <LeadsBulkBar leadIds={[5, 6, 7]} canMail mailboxConnected onClear={() => undefined} onQueued={() => undefined} {...props}>
      <button type="button" className="btn sm">Archive</button>
    </LeadsBulkBar>
  );

  it('reads "<n> selected" and ends with Clear then the primary Send via mailer with its icon', () => {
    stub();
    wrap(bar());
    const region = screen.getByRole('region', { name: 'Bulk actions' });
    expect(region.className).toBe('mbulk on');
    expect(region.querySelector('strong')!.textContent).toBe('3');
    expect(region.firstElementChild!.textContent).toBe('3 selected');
    expect(within(region).getAllByRole('button').map((b) => b.textContent)).toEqual(['Archive', 'Clear', 'Send via mailer']);
    const send = within(region).getByRole('button', { name: 'Send via mailer' });
    expect(send.className).toBe('btn sm primary');
    expect(send.querySelector('svg')).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(false);
    expect(send.previousElementSibling!.previousElementSibling!.className).toBe('grow');
    expect(within(region).queryByRole('link', { name: 'Open Settings' })).toBeNull();
  });

  it('mailbox not connected: the prototype hint after the count, and Send disabled with the reason as its title', () => {
    stub();
    wrap(bar({ mailboxConnected: false }));
    const region = screen.getByRole('region', { name: 'Bulk actions' });
    expect(region.firstElementChild!.textContent).toBe('3 selected · Connect your Microsoft 365 mailbox in Settings to use the mailer. Open Settings');
    expect(within(region).getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings/connections');
    const send = within(region).getByRole('button', { name: 'Send via mailer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe('Connect your Microsoft 365 mailbox in Settings to use the mailer.');
  });

  it('the wizard stays open when the ticked leads clear (the Leads list refreshed)', async () => {
    const u = userEvent.setup();
    stub();
    function Harness() {
      const [ids, setIds] = useState([5, 6]);
      return (
        <>
          <button type="button" onClick={() => setIds([])}>Refresh</button>
          {bar({ leadIds: ids })}
        </>
      );
    }
    wrap(<Harness />);
    await u.click(screen.getByRole('button', { name: 'Send via mailer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send via mailer' });
    // A list refresh clears the ticks while the wizard is open (the click goes through, as a refetch would).
    dialog.ownerDocument.querySelectorAll('button').forEach((b) => b.textContent === 'Refresh' && b.click());
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Send via mailer' })).toBeTruthy();
  });

  it('without the mailer right there is no Send via mailer and no hint', () => {
    stub();
    wrap(bar({ canMail: false, mailboxConnected: false }));
    const region = screen.getByRole('region', { name: 'Bulk actions' });
    expect(within(region).getAllByRole('button').map((b) => b.textContent)).toEqual(['Archive', 'Clear']);
    expect(region.firstElementChild!.textContent).toBe('3 selected');
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

  it('campaign page has a Message column; the local time sits under the address (review #22)', async () => {
    stub(CAMPAIGN);
    wrap(<CampaignPage />, '/mailer/7');
    const recipients = await screen.findByRole('table', { name: 'Recipients' });
    const headers = within(recipients).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Lead', 'Name', 'To', 'Status', 'Sent at', 'Message']);
    expect(within(recipients).getByText(/· America\/Mexico_City$/).closest('td')).toHaveClass('mw-to');
    const [, ana, luis] = within(recipients).getAllByRole('row');
    expect(within(ana!).getAllByRole('cell').at(-1)!.textContent).toBe('<abc@mail.outlook.com>');
    expect(within(luis!).getAllByRole('cell').at(-1)!.textContent).toBe('—');
  });

  it('a paused campaign shows its reason translated', async () => {
    stub({ ...CAMPAIGN, status: 'Paused', pauseReason: 'Paused by Carlos Torres', waitReason: null });
    wrap(<CampaignPage />, '/mailer/7');
    expect(await screen.findByText(/Paused by Carlos Torres/)).toBeTruthy();
  });

  it('details show the creator, the template version date dimmed, and the progress bar in the Sent tile (5.3, 5.5, 5.6)', async () => {
    stub({ ...CAMPAIGN, templateUpdatedAt: '2026-10-01T09:30:00.000Z' });
    const { container } = wrap(<CampaignPage />, '/mailer/7');
    await screen.findByRole('heading', { name: /MC-007/ });
    const created = screen.getByText('Created').nextElementSibling!;
    expect(created.textContent).toBe('Arjun Mehta · 22/11/2026, 10:00');
    const tpl = screen.getByText('Template', { selector: 'dt' }).nextElementSibling!;
    expect(tpl.textContent).toBe('Intro ES · version of 01/10/2026');
    expect(tpl.querySelector('.dim')!.textContent).toBe(' · version of 01/10/2026');
    expect(container.querySelector('.tile .mbar')).toBeTruthy();
    expect(container.querySelector('.card .head .mbar')).toBeNull();
    // Lead links bold (prototype font-weight 600).
    expect(screen.getByRole('link', { name: 'LD-1005' }).className).toContain('strong');
  });

  it('an administrator viewing someone else’s campaign gets no actions', async () => {
    stub({ ...CAMPAIGN, isSender: false });
    wrap(<CampaignPage />, '/mailer/7');
    expect(await screen.findByRole('heading', { name: /MC-007/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel remaining' })).toBeNull();
  });
});
