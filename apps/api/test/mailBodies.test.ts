import { describe, expect, test } from 'vitest';
import { BODY_TIMEOUT_MS, processEmailBody, setBodyWorkerMemoryForTests, storedColumns } from '../src/mail/bodies';
import { RAW_MAX, emailBodies, fallbackText } from '../src/mail/html';

/**
 * Like longestStall, but the timer keeps ticking for 60 ms after `p` settles: work done on the calling thread when the
 * result comes back (the fallback text is made there) shows up too (final review F1).
 */
async function lagThrough<T>(p: Promise<T>): Promise<{ value: T; lag: number }> {
  let last = performance.now();
  let lag = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last);
    last = now;
  }, 10);
  try {
    const value = await p;
    await new Promise((r) => setTimeout(r, 60));
    return { value, lag: Math.max(lag, performance.now() - last) };
  } finally {
    clearInterval(timer);
  }
}

/** Runs `p` while a 10 ms timer ticks; returns the longest gap between ticks (the caller's event loop staying free). */
async function longestStall<T>(p: Promise<T>): Promise<{ value: T; stall: number; ms: number }> {
  const started = performance.now();
  let last = started;
  let stall = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }, 10);
  try {
    const value = await p;
    return { value, stall: Math.max(stall, performance.now() - last), ms: performance.now() - started };
  } finally {
    clearInterval(timer);
  }
}

const divs = (n: number) => '<div>'.repeat(n);
const MB = (unit: string) => unit.repeat(Math.ceil(RAW_MAX / unit.length));

/** The re-review's triggers (24 Nov 2026), with 30k and 120k divs after them, and the earlier inputs at the 1 MB cap. */
const CASES: [string, string][] = [];
for (const n of [30_000, 120_000]) {
  CASES.push(
    [`<iframe> + ${n} divs`, `<iframe>${divs(n)}x`],
    [`<noembed> + ${n} divs`, `<noembed>${divs(n)}x`],
    [`<xmp> + ${n} divs`, `<xmp>${divs(n)}x`],
    [`unclosed quote + ${n} divs`, `<x '>${divs(n)}x`],
    [`quote in an unquoted value + ${n} divs`, `<div a=b'c>${divs(n)}x'>`],
    [`<!--> + ${n} divs`, `<!-->${divs(n)}x`],
  );
}
CASES.push(
  ['<div/> x 30k', '<div/>'.repeat(30_000) + 'x'],
  ['<b><p> x 15k', '<b><p>'.repeat(15_000) + 'x'],
  ['1 MB table newsletter', '<table>' + MB('<tr><td style="color:red">cell &amp; text</td></tr>') + '</table>'],
  ['1 MB of <div>x</div>', MB('<div>x</div>')],
  ['<pre> with 1 MB of spaces', '<pre>' + ' '.repeat(RAW_MAX) + 'x</pre><div>a</div>'],
  ['1 MB of newlines + divs', '\n'.repeat(RAW_MAX / 2) + MB('<div>a</div>')],
  ['2 MB of nested divs', divs(400_000) + 'x'],
);

describe('email bodies are processed in a worker thread with a time limit (security review N1)', () => {
  test.each(CASES)('%s: done in under 1 s, or stopped at the limit and given the plain fallback; the caller never stalls', async (_name, content) => {
    const { value, stall, ms } = await longestStall(processEmailBody({ contentType: 'html', content }, 50_000));
    expect(stall).toBeLessThan(50);
    if (value.fellBack) {
      expect(value.bodyHtml).toBeNull();
      expect(ms).toBeLessThan(BODY_TIMEOUT_MS + 1000);
    } else expect(ms).toBeLessThan(1000);
    // Stopped at the worker's own 1 s budget, or the 3 s hard limit, never in between unanswered.
    expect(ms).toBeLessThan(BODY_TIMEOUT_MS + 1000);
    expect(value.bodyText.length).toBeLessThanOrEqual(50_000);
    expect(value.bodyText).not.toMatch(/<[a-z]|color:red/i);
  }, 15_000);

  test('a normal email is processed in full (sanitised HTML and its text)', async () => {
    const r = await processEmailBody({ contentType: 'html', content: '<p>Hi <script>x()</script><b>there</b></p>' }, 50_000);
    expect(r).toEqual({ bodyHtml: '<p>Hi <b>there</b></p>', bodyText: 'Hi there' });
  });

  test('over the time limit: the worker is stopped, no HTML, the fallback text; the next body works on a new worker', async () => {
    const slow = '<style>.x{color:red}</style><p>Hello &amp; welcome</p>' + divs(150_000) + 'end';
    const r = await processEmailBody({ contentType: 'html', content: slow }, 50_000, { timeoutMs: 100 });
    expect(r).toEqual({ bodyHtml: null, bodyText: 'Hello & welcome end', fellBack: true, reason: 'timeout' });
    expect(await processEmailBody({ contentType: 'html', content: '<p>after</p>' }, 50_000)).toEqual({ bodyHtml: '<p>after</p>', bodyText: 'after' });
  });

  test('bodies queue: several at once each get their own answer', async () => {
    const all = await Promise.all([1, 2, 3].map((i) => processEmailBody({ contentType: 'html', content: `<p>n${i}</p>` }, 50_000)));
    expect(all.map((r) => r.bodyText)).toEqual(['n1', 'n2', 'n3']);
  });

  test('plain text needs no worker: cut to the cap', async () => {
    expect(await processEmailBody({ contentType: 'text', content: 'x'.repeat(60) }, 50)).toEqual({ bodyHtml: null, bodyText: 'x'.repeat(50) });
  });
});

describe('fallbacks never block the calling thread, and are retried once when not the email\'s fault (final review)', () => {
  test('F1: fallbackText on 1 MB of "&" takes well under 100 ms', () => {
    const started = performance.now();
    expect(fallbackText('&'.repeat(RAW_MAX), 50_000)).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test.each([
    ['"&" x 50k + <x \'> + <div> x 190k', '&'.repeat(50_000) + "<x '>" + '<div>'.repeat(190_000)],
    ['deep divs + 590 KB of "&"', "<x '>" + '<div>'.repeat(80_000) + '&'.repeat(590_000)],
  ])('F1: %s through processEmailBody: under 100 ms of lag, the fallback included', async (_name, content) => {
    const { value, lag } = await lagThrough(processEmailBody({ contentType: 'html', content }, 50_000));
    expect(lag).toBeLessThan(100);
    expect(value.bodyText.length).toBeLessThanOrEqual(50_000);
  }, 15_000);

  test('F1: a forced timeout on deep divs + 590 KB of "&" (the fallback made on the calling thread): under 100 ms of lag', async () => {
    const content = "<x '>" + '<div>'.repeat(80_000) + '&'.repeat(590_000);
    const { value, lag } = await lagThrough(processEmailBody({ contentType: 'html', content }, 50_000, { timeoutMs: 30 }));
    expect(value).toMatchObject({ fellBack: true, reason: 'timeout' });
    expect(value.bodyText).toHaveLength(50_000);
    expect(lag).toBeLessThan(100);
  });

  test('F2: a worker that runs out of memory gives the fallback (and the next body a fresh worker)', async () => {
    setBodyWorkerMemoryForTests(16);
    try {
      const r = await processEmailBody({ contentType: 'html', content: '<p>big</p>'.repeat(90_000) }, 50_000, { retryKey: 'oom-1' });
      expect(r).toMatchObject({ bodyHtml: null, fellBack: true, reason: 'crash' });
      expect(r.bodyText.startsWith('big big')).toBe(true);
    } finally {
      setBodyWorkerMemoryForTests(null);
    }
    expect(await processEmailBody({ contentType: 'html', content: '<p>ok</p>' }, 50_000)).toEqual({ bodyHtml: '<p>ok</p>', bodyText: 'ok' });
  });

  test('F4: a timeout or crash is retried once (null stored), then kept as plain text (\'\'); a budget fallback is final at once', async () => {
    const slow = '<p>Hi</p>' + '<div>'.repeat(150_000);
    const first = await processEmailBody({ contentType: 'html', content: slow }, 50_000, { timeoutMs: 50, retryKey: 'u1:g-timeout' });
    expect(first).toMatchObject({ fellBack: true, reason: 'timeout', retry: true });
    expect(storedColumns(first)).toEqual({ bodyHtml: null, bodyText: 'Hi' });
    const second = await processEmailBody({ contentType: 'html', content: slow }, 50_000, { timeoutMs: 50, retryKey: 'u1:g-timeout' });
    expect(second.retry).toBeUndefined();
    expect(storedColumns(second)).toEqual({ bodyHtml: '', bodyText: 'Hi' });
    const budget = await processEmailBody({ contentType: 'html', content: "<p>Hi</p><x '>" + '<div>'.repeat(200_000) }, 50_000, { retryKey: 'u1:g-budget' });
    expect(budget).toMatchObject({ fellBack: true, reason: 'budget' });
    expect(budget.retry).toBeUndefined();
    expect(storedColumns(budget).bodyHtml).toBe('');
  }, 15_000);

  test('F5: when the sanitised HTML and its text both come out empty, the text is the plain fallback', () => {
    expect(emailBodies({ contentType: 'html', content: '<iframe><p>Hello there</p><div>more' }, 50_000)).toEqual({ bodyHtml: '', bodyText: 'Hello there more' });
    // Nothing to read at all stays empty.
    expect(emailBodies({ contentType: 'html', content: '<div></div>' }, 50_000)).toEqual({ bodyHtml: '<div></div>', bodyText: '' });
  });
});

describe('fallbackText (no parser, one pass)', () => {
  test('drops tags and the content of script / style / head / title; decodes common entities; collapses whitespace', () => {
    expect(fallbackText('<html><head><title>T</title><style>.a{color:red}</style></head><body><p>Fish &amp; chips&nbsp;&lt;3</p>\n\n<div>next   line</div><script>x()</script>&unknown;</body>', 1000))
      .toBe('Fish & chips <3 next line &unknown;');
  });

  test('an "&" looks at most 10 characters ahead for its ";"; unknown names (even ones on Object.prototype) stay as typed', () => {
    expect(fallbackText('a &amp; b &toString; c &valueOf; &nbsp;x &verylongname; &amp', 1000)).toBe('a & b &toString; c &valueOf; x &verylongname; &amp');
  });

  test('caps the length and is fast on hostile input', () => {
    const started = performance.now();
    expect(fallbackText('<div>'.repeat(200_000) + 'x', 100)).toBe('x');
    expect(fallbackText('a'.repeat(RAW_MAX), 50)).toHaveLength(50);
    expect(fallbackText("<x '>" + 'y'.repeat(1000), 100)).toBe('y'.repeat(1000).slice(0, 100));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
