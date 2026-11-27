import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { keys, type Me } from '../src/api/queries';
import { ToastProvider } from '../src/components/Toast';
import { SignatureCard } from '../src/pages/settings/SignatureCard';

const me: Me = {
  id: 1, email: 'maya@daitpartners.com', name: 'Maya', role: 'Sales Representative', language: 'en',
  timezone: 'UTC', dateFormat: 'DD/MM/YYYY', rights: [],
};

let puts: unknown[] = [];
const lastBody = () => puts.at(-1);

function stubFetch(saved: { html: string | null; auto: boolean }) {
  puts = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/me/signature' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { html: string | null; auto: boolean };
      puts.push(body);
      return Response.json(body);
    }
    if (url === '/api/me/signature') return Response.json(saved);
    return Response.json({});
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.me, me);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <SignatureCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const frame = () => document.querySelector('iframe') as HTMLIFrameElement;

afterEach(() => vi.unstubAllGlobals());

describe('Settings: email signature', () => {
  it('Settings: edit the signature, untick Add automatically, Save', async () => {
    stubFetch({ html: null, auto: true });
    const user = userEvent.setup();
    renderCard();
    expect(screen.getByRole('region', { name: 'Email signature' })).toBeInTheDocument();
    expect(screen.getByText('Added to new emails and replies you write in the CRM.')).toBeInTheDocument();
    const box = await screen.findByRole('checkbox', { name: 'Add automatically' });
    expect(box).toBeChecked();
    // Formatted from the start: the sandboxed frame, not the plain textarea.
    await waitFor(() => expect(frame()?.contentDocument?.body.dataset.editor).toBe('on'));
    act(() => {
      frame().contentDocument!.body.innerHTML = '<p><b>Maya</b> · DAIT Partners</p>';
      frame().contentDocument!.dispatchEvent(new Event('input'));
    });
    await user.click(screen.getByRole('checkbox', { name: 'Add automatically' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastBody()).toEqual({ html: expect.stringContaining('Maya'), auto: false }));
    expect(await screen.findByText('Signature saved')).toBeInTheDocument();
  });

  it('shows the saved signature and setting; an emptied signature is saved as none', async () => {
    stubFetch({ html: '<p><i>Maya</i></p>', auto: false });
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByRole('checkbox', { name: 'Add automatically' })).not.toBeChecked();
    await waitFor(() => expect(frame()?.contentDocument?.body.innerHTML).toBe('<p><i>Maya</i></p>'));
    act(() => {
      frame().contentDocument!.body.innerHTML = '<p><br></p>';
      frame().contentDocument!.dispatchEvent(new Event('input'));
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastBody()).toEqual({ html: null, auto: false }));
  });

  it('ticking only Add automatically keeps the saved signature', async () => {
    stubFetch({ html: '<p><i>Maya</i></p>', auto: false });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole('checkbox', { name: 'Add automatically' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastBody()).toEqual({ html: '<p><i>Maya</i></p>', auto: true }));
  });

  it('a signature too long is refused with a message', async () => {
    const mock = stubFetch({ html: null, auto: true });
    mock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? Response.json({ error: 'signature_too_long' }, { status: 400 }) : Response.json({ html: '<p>x</p>', auto: true }),
    );
    const user = userEvent.setup();
    renderCard();
    await screen.findByRole('checkbox', { name: 'Add automatically' });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The signature is too long.')).toBeInTheDocument();
  });
});
