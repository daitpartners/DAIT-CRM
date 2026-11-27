import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ComposeModal, type ComposeStart } from '../src/pages/email/ComposeModal';
import { ToastProvider } from '../src/components/Toast';
import { I18nProvider } from '../src/i18n';
import { makeClient, rep } from './leadFixture';

afterEach(() => {
  vi.unstubAllGlobals();
});

const me = { ...rep, rights: [...rep.rights, 'use_email' as const] };

function stub() {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ id: 99 }, { status: 201 });
    }
    if (url === '/api/me') return Response.json(me);
    if (url === '/api/lookups') return Response.json({ groups: {} });
    if (url.startsWith('/api/email-templates')) return Response.json({ items: [] });
    return Response.json({ items: [], total: 0, page: 1, pageSize: 25 });
  }));
  return posts;
}

function show(start: ComposeStart) {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={makeClient(me)}>
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter>
            <ComposeModal start={start} connected from="arjun@daitpartners.com" onClose={onClose} />
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

describe('Compose for Reply, Reply all and Forward (web-mail release 2)', () => {
  it('Forward: To required and editable, subject Fw:, posts mode forward with to', async () => {
    const user = userEvent.setup();
    const posts = stub();
    const onClose = show({ replyTo: 4, mode: 'forward', to: '', cc: [], subject: 'Fw: Proposal', leadId: 5 });
    const dialog = await screen.findByRole('dialog', { name: 'Forward' });
    const to = within(dialog).getByLabelText('To');
    expect(to).not.toHaveAttribute('readonly');
    expect(to).toBeRequired();
    const subject = within(dialog).getByLabelText('Subject');
    expect(subject).toHaveValue('Fw: Proposal');
    expect(subject).toHaveAttribute('readonly');
    // No address: refused with the reason, nothing posted.
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a valid To address.');
    await user.type(to, 'not-an-address');
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter a valid To address.');
    expect(posts).toEqual([]);
    await user.clear(to);
    await user.type(to, 'Tom@Acme.com, li@acme.com');
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/mail/4/reply');
    expect(posts[0]!.body).toMatchObject({ mode: 'forward', to: ['tom@acme.com', 'li@acme.com'], cc: [] });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Reply all: To read-only, Cc pre-filled, posts mode replyAll', async () => {
    const user = userEvent.setup();
    const posts = stub();
    show({ replyTo: 4, mode: 'replyAll', to: 'ana@acme.com, tom@acme.com', cc: ['li@acme.com'], subject: 'Re: Proposal' });
    const dialog = await screen.findByRole('dialog', { name: 'Reply all' });
    expect(within(dialog).getByLabelText('To')).toHaveValue('ana@acme.com, tom@acme.com');
    expect(within(dialog).getByLabelText('To')).toHaveAttribute('readonly');
    expect(within(dialog).getByLabelText(/^Cc/)).toHaveValue('li@acme.com');
    expect(within(dialog).getByLabelText('Subject')).toHaveAttribute('readonly');
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ mode: 'replyAll', to: [], cc: ['li@acme.com'] });
  });

  it('Reply (no mode given): title Reply, posts mode reply', async () => {
    const user = userEvent.setup();
    const posts = stub();
    show({ replyTo: 4, to: 'ana@acme.com', subject: 'Re: Proposal' });
    const dialog = await screen.findByRole('dialog', { name: 'Reply' });
    expect(within(dialog).getByLabelText('To')).toHaveAttribute('readonly');
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ mode: 'reply', to: [], cc: [] });
  });
});
