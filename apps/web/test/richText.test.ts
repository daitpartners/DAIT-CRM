import { describe, expect, test } from 'vitest';
import { applyFontSize, toEditorHtml, toSendHtml } from '../src/lib/richText';

describe('mail editor HTML (web-mail release 3)', () => {
  test('toSendHtml turns editor pictures into cid: and toEditorHtml back', () => {
    expect(toSendHtml('<p><img data-cid="img-1@dait" src="data:image/png;base64,AA=="></p>')).toBe('<p><img src="cid:img-1@dait"></p>');
    expect(toEditorHtml('<p><img src="cid:img-1@dait"></p>', [{ contentId: 'img-1@dait', dataUrl: 'data:image/png;base64,AA==' }])).toBe(
      '<p><img src="data:image/png;base64,AA==" data-cid="img-1@dait"></p>',
    );
    // Round trip.
    const editor = '<p>Hi<img src="data:image/gif;base64,R0==" data-cid="a@b"></p>';
    expect(toEditorHtml(toSendHtml(editor), [{ contentId: 'a@b', dataUrl: 'data:image/gif;base64,R0==' }])).toBe(editor);
  });

  test('toSendHtml leaves other pictures alone; toEditorHtml leaves a cid: with no file (or no data) as it is', () => {
    expect(toSendHtml('<p><img src="https://x.example/a.png"></p>')).toBe('<p><img src="https://x.example/a.png"></p>');
    expect(toEditorHtml('<p><img src="cid:gone@x"></p>', [{ contentId: 'gone@x', dataUrl: null }, { contentId: null, dataUrl: 'data:image/png;base64,AA==' }])).toBe(
      '<p><img src="cid:gone@x"></p>',
    );
    expect(toSendHtml('')).toBe('');
  });

  test('applyFontSize wraps the selection in a pt span', () => {
    // The page's own document (a document made with createHTMLDocument has no selection in jsdom).
    const doc = document;
    doc.body.innerHTML = '<p>Hello world</p>';
    const calls: string[][] = [];
    // The browser's fontSize 7 (absent in jsdom): the selection wrapped in <font size="7">.
    (doc as unknown as { execCommand: (c: string, u: boolean, v?: string) => boolean }).execCommand = (c, _u, v) => {
      calls.push([c, v ?? '']);
      if (c === 'fontSize') doc.body.querySelector('p')!.innerHTML = 'Hello <font size="7">world</font>';
      return true;
    };
    applyFontSize(doc, 12);
    expect(calls).toContainEqual(['fontSize', '7']);
    expect(doc.body.innerHTML).toBe('<p>Hello <span style="font-size:12pt">world</span></p>');
    // The resized text stays selected for the next command (the replaced <font> took the selection with it).
    expect(doc.getSelection()!.toString()).toBe('world');
    doc.body.innerHTML = '';
    delete (doc as unknown as { execCommand?: unknown }).execCommand;
  });

  test('applyFontSize: a span the browser styled xxx-large gets the size in pt', () => {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = '<p>Hello world</p>';
    (doc as unknown as { execCommand: (c: string) => boolean }).execCommand = (c) => {
      if (c === 'fontSize') doc.body.querySelector('p')!.innerHTML = 'Hello <span style="color: red; font-size: xxx-large;">world</span>';
      return true;
    };
    applyFontSize(doc, 14);
    const span = doc.body.querySelector('span')!;
    expect(span.style.fontSize).toBe('14pt');
    expect(span.style.color).toBe('red');
  });
});
