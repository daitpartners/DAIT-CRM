import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  resolveRecipients, useAutoSave, useDraftFile, useRecipientSuggestions, useSendDraft, useUnsend, type DraftFields, type DraftView,
} from '../src/api/drafts';
import { keys } from '../src/api/queries';
import { makeClient } from './leadFixture';

type Answer = { status: number; body?: unknown };
type Call = { url: string; method: string; body: unknown };

/** fetch answered by `answer` (a promise to hold the answer back); every call is kept. */
function stubFetch(answer: (call: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const a = await answer(call);
    return a.status === 204 ? new Response(null, { status: 204 }) : Response.json(a.body ?? {}, { status: a.status });
  }));
  return calls;
}

/** An answer the test releases when it wants. */
function later() {
  let release!: (a: Answer) => void;
  const answer = new Promise<Answer>((r) => {
    release = r;
  });
  return { answer, release };
}

const wrap = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

const fields = (bodyHtml: string, over: Partial<DraftFields> = {}): DraftFields => ({ to: ['ana@acme.com'], cc: [], bcc: [], subject: 'Proposal', bodyHtml, ...over });

/** Lets timers and promises run for `ms`. */
const tick = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAutoSave (web-mail release 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  function mount(id: number | null = 7, enabled = true) {
    return renderHook(({ f, id: draftId, on }) => useAutoSave(draftId, f, { enabled: on }), {
      initialProps: { f: fields('<p>Hi</p>'), id, on: enabled },
      wrapper: wrap(makeClient()),
    });
  }

  it('auto-save waits 2 s after typing, sends one request at a time, and reports the saved time', async () => {
    const first = later();
    const second = later();
    const answers = [first, second];
    const calls = stubFetch(() => answers.shift()!.answer);
    const { result, rerender } = mount();

    // Opening is not a change: nothing is saved.
    await tick(5000);
    expect(calls).toHaveLength(0);

    rerender({ f: fields('<p>Hi A</p>'), id: 7, on: true });
    await tick(1500);
    rerender({ f: fields('<p>Hi An</p>'), id: 7, on: true });
    await tick(1999);
    expect(calls).toHaveLength(0); // 2 s after the last change, not the first
    await tick(1);
    expect(calls).toEqual([{ url: '/api/mail/drafts/7', method: 'PATCH', body: fields('<p>Hi An</p>') }]);
    expect(result.current.saving).toBe(true);

    // Typing on while the save is out: no second request until it answers.
    rerender({ f: fields('<p>Hi Ana</p>'), id: 7, on: true });
    await tick(2000);
    expect(calls).toHaveLength(1);

    await act(async () => first.release({ status: 200, body: { savedAt: '2026-11-27T14:31:58.000Z' } }));
    await tick(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(fields('<p>Hi Ana</p>'));

    await act(async () => second.release({ status: 200, body: { savedAt: '2026-11-27T14:32:03.000Z' } }));
    await tick(0);
    expect(result.current).toMatchObject({ savedAt: '2026-11-27T14:32:03.000Z', saving: false, error: null });

    // Nothing new: no more requests.
    await tick(10_000);
    expect(calls).toHaveLength(2);
  });

  it('auto-save meeting 409 draft_gone reports the error and stops saving', async () => {
    const calls = stubFetch(() => ({ status: 409, body: { error: 'draft_gone' } }));
    const { result, rerender } = mount();
    rerender({ f: fields('<p>Hi A</p>'), id: 7, on: true });
    await tick(2000);
    expect(calls).toHaveLength(1);
    expect(result.current).toMatchObject({ error: 'draft_gone', saving: false, savedAt: null });

    rerender({ f: fields('<p>Hi An</p>'), id: 7, on: true });
    await tick(5000);
    await act(async () => result.current.flush());
    expect(calls).toHaveLength(1);
  });

  it('a passing failure (Outlook busy) is reported and the next change saves again, clearing it', async () => {
    let busy = true;
    const calls = stubFetch(() => (busy ? { status: 503, body: { error: 'outlook_busy' } } : { status: 200, body: { savedAt: '2026-11-27T14:40:00.000Z' } }));
    const { result, rerender } = mount();
    rerender({ f: fields('<p>A</p>'), id: 7, on: true });
    await tick(2000);
    expect(result.current.error).toBe('outlook_busy');
    busy = false;
    rerender({ f: fields('<p>AB</p>'), id: 7, on: true });
    await tick(2000);
    expect(calls).toHaveLength(2);
    expect(result.current).toMatchObject({ error: null, savedAt: '2026-11-27T14:40:00.000Z' });
  });

  it('flush saves at once, and waits for a save already out and the change after it', async () => {
    const first = later();
    const answers = [first.answer, Promise.resolve({ status: 200, body: { savedAt: '2026-11-27T14:33:00.000Z' } })];
    const calls = stubFetch(() => answers.shift()!);
    const { result, rerender } = mount();
    rerender({ f: fields('<p>One</p>'), id: 7, on: true });
    let flushed = false;
    act(() => {
      void result.current.flush().then(() => {
        flushed = true;
      });
    });
    await tick(0);
    expect(calls).toHaveLength(1); // at once, not after 2 s
    rerender({ f: fields('<p>Two</p>'), id: 7, on: true });
    act(() => {
      void result.current.flush();
    });
    await tick(0);
    expect(calls).toHaveLength(1);
    expect(flushed).toBe(false);
    await act(async () => first.release({ status: 200, body: { savedAt: '2026-11-27T14:32:00.000Z' } }));
    await tick(0);
    expect(calls.map((c) => c.body)).toEqual([fields('<p>One</p>'), fields('<p>Two</p>')]);
    expect(flushed).toBe(true);
    expect(result.current.savedAt).toBe('2026-11-27T14:33:00.000Z');
  });

  it('saves nothing while disabled or without a draft', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { savedAt: 'x' } }));
    const off = mount(7, false);
    off.rerender({ f: fields('<p>A</p>'), id: 7, on: false });
    await tick(3000);
    await act(async () => off.result.current.flush());
    const none = mount(null, true);
    none.rerender({ f: fields('<p>A</p>'), id: null, on: true });
    await tick(3000);
    expect(calls).toHaveLength(0);
  });
});

describe('send hooks (web-mail release 3)', () => {
  it('useSendDraft posts the draft with its time and follow-up, then refreshes the mail, the badges and the lead', async () => {
    const calls = stubFetch(() => ({ status: 202, body: { id: 7, sendAt: '2026-11-27T14:00:10.000Z', undoUntil: '2026-11-27T14:00:10.000Z', followUp: null } }));
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSendDraft(), { wrapper: wrap(qc) });
    const f = fields('<p>Hi</p>', { leadId: 12 });
    const sent = await act(async () => result.current.mutateAsync({ id: 7, fields: f, at: null, followUp: null }));
    expect(sent.undoUntil).toBe('2026-11-27T14:00:10.000Z');
    expect(calls).toEqual([{ url: '/api/mail/drafts/7/send', method: 'POST', body: { ...f, at: null, followUp: null } }]);
    const invalidated = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidated).toEqual(expect.arrayContaining([['mail'], keys.navCounts, keys.lead(12)]));
  });

  it('useUnsend answers the draft as the editor opens it, and refreshes its lead', async () => {
    const view = { id: 7, leadId: 12, status: 'draft' } as DraftView;
    const calls = stubFetch(() => ({ status: 200, body: view }));
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUnsend(), { wrapper: wrap(qc) });
    expect(await act(async () => result.current.mutateAsync(7))).toEqual(view);
    expect(calls[0]).toMatchObject({ url: '/api/mail/7/unsend', method: 'POST' });
    expect(qc.getQueryData(['mail-draft', 7])).toEqual(view);
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual(expect.arrayContaining([['mail'], keys.lead(12)]));
  });

  it('useDraftFile uploads the file as base64 and removes by its encoded id', async () => {
    const calls = stubFetch((c) => (c.method === 'DELETE' ? { status: 204 } : { status: 201, body: { id: 'AAMk=', name: 'a.pdf' } }));
    const { result } = renderHook(() => useDraftFile(7), { wrapper: wrap(makeClient()) });
    await act(async () => {
      await result.current.add(new File(['%PDF-1'], 'a.pdf', { type: 'application/pdf' }), false);
    });
    expect(calls[0]).toEqual({ url: '/api/mail/drafts/7/files', method: 'POST', body: { name: 'a.pdf', data: btoa('%PDF-1'), inline: false } });
    await act(async () => {
      await result.current.remove('AAMk/x=');
    });
    expect(calls[1]).toMatchObject({ url: '/api/mail/drafts/7/files/AAMk%2Fx%3D', method: 'DELETE' });
  });
});

describe('recipients (web-mail release 3)', () => {
  it('suggestions are asked 250 ms after the last key, from 2 characters', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = stubFetch(() => ({ status: 200, body: { items: [{ address: 'ana@acme.com', name: 'Ana Ruiz', leadNumber: 'L-0007' }] } }));
    const { result, rerender } = renderHook(({ q }) => useRecipientSuggestions(q), { initialProps: { q: 'a' }, wrapper: wrap(makeClient()) });
    await tick(1000);
    expect(calls).toHaveLength(0);
    rerender({ q: 'an' });
    await tick(100);
    rerender({ q: 'ana' });
    await tick(249);
    expect(calls).toHaveLength(0);
    await tick(1);
    await tick(0);
    expect(calls.map((c) => c.url)).toEqual(['/api/mail/recipients?q=ana']);
    expect(result.current.data).toEqual([{ address: 'ana@acme.com', name: 'Ana Ruiz', leadNumber: 'L-0007' }]);
  });

  it('resolveRecipients asks only when there are addresses', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { items: [{ address: 'ana@acme.com', name: 'Ana', leadNumber: null }] } }));
    expect(await resolveRecipients([])).toEqual([]);
    expect(await resolveRecipients(['ana@acme.com'])).toEqual([{ address: 'ana@acme.com', name: 'Ana', leadNumber: null }]);
    expect(calls).toEqual([{ url: '/api/mail/recipients/resolve', method: 'POST', body: { addresses: ['ana@acme.com'] } }]);
  });
});
