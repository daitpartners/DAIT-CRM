import { describe, expect, test } from 'vitest';
import { BODY_TIMEOUT_MS, processEmailBody } from '../src/mail/bodies';
import { RAW_MAX, fallbackText } from '../src/mail/html';

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
    expect(r).toEqual({ bodyHtml: null, bodyText: 'Hello & welcome end', fellBack: true });
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

describe('fallbackText (no parser, one pass)', () => {
  test('drops tags and the content of script / style / head / title; decodes common entities; collapses whitespace', () => {
    expect(fallbackText('<html><head><title>T</title><style>.a{color:red}</style></head><body><p>Fish &amp; chips&nbsp;&lt;3</p>\n\n<div>next   line</div><script>x()</script>&unknown;</body>', 1000))
      .toBe('Fish & chips <3 next line &unknown;');
  });

  test('caps the length and is fast on hostile input', () => {
    const started = performance.now();
    expect(fallbackText('<div>'.repeat(200_000) + 'x', 100)).toBe('x');
    expect(fallbackText('a'.repeat(RAW_MAX), 50)).toHaveLength(50);
    expect(fallbackText("<x '>" + 'y'.repeat(1000), 100)).toBe('y'.repeat(1000).slice(0, 100));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
