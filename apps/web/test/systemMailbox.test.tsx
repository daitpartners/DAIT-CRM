import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { keys, type RetryableJob, type Me, type SystemMailbox as Mailbox } from '../src/api/queries';
import { ConfirmProvider } from '../src/components/ConfirmDialog';
import { ToastProvider } from '../src/components/Toast';
import { SystemMailbox } from '../src/pages/settings/SystemMailbox';

const admin: Me = {
  id: 1, email: 'admin@daitpartners.com', name: 'Admin', role: 'Administrator', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: ['manage_users', 'view_admin_settings'],
};

const failedJob: RetryableJob = {
  interrupted: false,
  id: 7, type: 'send_email', status: 'failed', attempts: 8, maxAttempts: 8, lastError: 'graph_send_failed status=503',
  runAt: '2026-11-20T10:00:00.000Z', createdAt: '2026-11-20T09:00:00.000Z',
  payloadSummary: { to: ['client@example.com'], subject: 'Your quote' },
};

function renderPage(opts: { me?: Me; mailbox: Mailbox; failed?: RetryableJob[]; url?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(keys.me, opts.me ?? admin);
  qc.setQueryData(keys.systemMailbox, opts.mailbox);
  qc.setQueryData(keys.failedEmailJobs, opts.failed ?? []);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[opts.url ?? '/settings/mailbox']}>
            <Routes>
              <Route path="/settings/mailbox" element={<SystemMailbox />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Answers the action call and the list refetches that follow it. */
function stubFetch(action: () => Response) {
  const mock = vi.fn(async (url: string) => {
    if (url === '/api/mailboxes/system') return Response.json({ account: null, pendingJobs: 0, failedJobs: 0, staleJobs: 0 });
    if (url.startsWith('/api/jobs?')) return Response.json({ items: [] });
    return action();
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('System mailbox page', () => {
  it('explains that emails wait while no mailbox is connected and offers a connect link', () => {
    renderPage({ mailbox: { account: null, pendingJobs: 3, failedJobs: 0, staleJobs: 0 }, url: '/settings/mailbox?connected=1' });
    expect(screen.getByText(/Emails wait here until the mailbox is connected/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect mailbox' })).toHaveAttribute('href', '/api/auth/microsoft/connect?mode=system');
    expect(screen.getByText('Mailbox connected')).toBeInTheDocument();
    expect(screen.getByText('No failed or interrupted emails')).toBeInTheDocument();
  });

  it('shows the connect error toast', () => {
    renderPage({ mailbox: { account: null, pendingJobs: 0, failedJobs: 0, staleJobs: 0 }, url: '/settings/mailbox?error=connect-failed' });
    expect(screen.getByText('The mailbox could not be connected. Please try again.')).toBeInTheDocument();
  });

  it('lists failed emails and retries one', async () => {
    const fetchMock = stubFetch(() => Response.json({ ...failedJob, status: 'queued', attempts: 0 }));
    renderPage({
      mailbox: { account: { address: 'crm@daitpartners.com', sendAs: null, status: 'error', lastError: 'graph_send_failed status=401', updatedAt: '2026-11-20T10:00:00.000Z' }, pendingJobs: 0, failedJobs: 1, staleJobs: 0 },
      failed: [failedJob],
    });
    expect(screen.getByText('crm@daitpartners.com')).toBeInTheDocument();
    expect(screen.getByText('Needs reconnecting')).toBeInTheDocument();
    expect(screen.getByText('Your quote')).toBeInTheDocument();
    expect(screen.getByText('8 of 8')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/7/retry', expect.objectContaining({ method: 'POST' }));
  });

  it('disconnect asks for confirmation first', async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));
    renderPage({ mailbox: { account: { address: 'crm@daitpartners.com', sendAs: null, status: 'connected', lastError: null, updatedAt: '2026-11-20T10:00:00.000Z' }, pendingJobs: 0, failedJobs: 0, staleJobs: 0 } });
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Disconnect mailbox?' });
    await userEvent.click(dialog.querySelector('button.danger')!);
    expect(fetchMock).toHaveBeenCalledWith('/api/mailboxes/system/disconnect', expect.objectContaining({ method: 'POST' }));
  });

  it('shows interrupted jobs with a Retry button and the interrupted count', async () => {
    const fetchMock = stubFetch(() => Response.json({ ...failedJob, id: 9, status: 'queued', attempts: 0 }));
    renderPage({
      mailbox: { account: { address: 'crm@daitpartners.com', sendAs: null, status: 'connected', lastError: null, updatedAt: '2026-11-20T10:00:00.000Z' }, pendingJobs: 1, failedJobs: 0, staleJobs: 1 },
      failed: [{ ...failedJob, id: 9, status: 'running', attempts: 0, lastError: null, interrupted: true }],
    });
    expect(screen.getAllByText('Interrupted')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/9/retry', expect.objectContaining({ method: 'POST' }));
  });

  it('passes the optional Send as address to the connect link and shows it once connected', async () => {
    renderPage({
      mailbox: { account: { address: 'admin@daitpartners.com', sendAs: 'hello@daitpartners.com', status: 'connected', lastError: null, updatedAt: '2026-11-20T10:00:00.000Z' }, pendingJobs: 0, failedJobs: 0, staleJobs: 0 },
    });
    expect(screen.getByText('Sends as')).toBeInTheDocument();
    expect(screen.getByText('hello@daitpartners.com')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Reconnect' });
    expect(link).toHaveAttribute('href', '/api/auth/microsoft/connect?mode=system');
    await userEvent.type(screen.getByLabelText('Send as (shared mailbox address)'), 'hello@daitpartners.com');
    expect(link).toHaveAttribute('href', '/api/auth/microsoft/connect?mode=system&sendAs=hello%40daitpartners.com');
  });

  it('sends a test email and refreshes the counts', async () => {
    const fetchMock = stubFetch(() => Response.json({ jobId: 42 }, { status: 201 }));
    renderPage({ mailbox: { account: { address: 'crm@daitpartners.com', sendAs: null, status: 'connected', lastError: null, updatedAt: '2026-11-20T10:00:00.000Z' }, pendingJobs: 0, failedJobs: 0, staleJobs: 0 } });
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/mailboxes/system/test-email', expect.objectContaining({ method: 'POST' }));
    expect(await screen.findByText('Test email queued to admin@daitpartners.com')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/mailboxes/system', expect.anything());
  });

  it('disables the test email button until a mailbox is connected', () => {
    renderPage({ mailbox: { account: null, pendingJobs: 0, failedJobs: 0, staleJobs: 0 } });
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
    expect(screen.getByText('Connect a mailbox first')).toBeInTheDocument();
  });

  it('hides connect, disconnect and retry from a Manager', () => {
    renderPage({
      me: { ...admin, role: 'Manager', rights: ['view_admin_settings'] },
      mailbox: { account: { address: 'crm@daitpartners.com', sendAs: null, status: 'connected', lastError: null, updatedAt: '2026-11-20T10:00:00.000Z' }, pendingJobs: 0, failedJobs: 1, staleJobs: 0 },
      failed: [failedJob],
    });
    expect(screen.queryByRole('link', { name: /Connect|Reconnect/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send test email' })).toBeNull();
    expect(screen.getByText('Your quote')).toBeInTheDocument();
  });
});
