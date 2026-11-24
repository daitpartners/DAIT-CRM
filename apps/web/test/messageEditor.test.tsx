import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageEditor, type MessageValue } from '../src/components/MessageEditor';
import { cleanPastedHtml, editorText, safeLinkUrl, textToEditorHtml } from '../src/lib/richText';

/** The editor with its value held as a form holds it; `seen` records every change. */
function Harness({ start, seen }: { start: MessageValue; seen: MessageValue[] }) {
  const [v, setV] = useState(start);
  return (
    <MessageEditor
      id="m"
      label="Message"
      value={v}
      onChange={(next) => {
        seen.push(next);
        setV(next);
      }}
    />
  );
}

const frame = () => document.querySelector('iframe') as HTMLIFrameElement;
const frameBody = () => frame().contentDocument!.body;
/** jsdom has no editing commands: a spy stands in for the browser's on the frame's document. */
const spyExec = () => {
  const spy = vi.fn(() => true);
  (frame().contentDocument as unknown as { execCommand: typeof spy }).execCommand = spy;
  return spy;
};

describe('richText helpers', () => {
  it('plain text becomes escaped paragraphs', () => {
    expect(textToEditorHtml('Hi <Ana> & co,\n\nLine one\nLine two')).toBe('<p>Hi &lt;Ana&gt; &amp; co,</p><p>Line one<br>Line two</p>');
  });

  it('links: http, https and mailto only', () => {
    expect(safeLinkUrl('https://dait.example/a')).toBe('https://dait.example/a');
    expect(safeLinkUrl('www.dait.example')).toBe('https://www.dait.example/');
    expect(safeLinkUrl('ana@andino.cl')).toBe('mailto:ana@andino.cl');
    expect(safeLinkUrl('mailto:ana@andino.cl')).toBe('mailto:ana@andino.cl');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>', 'vbscript:x', '/relative', 'ftp://x.y', 'tel:+1', '', 'http://a b']) {
      expect(safeLinkUrl(bad)).toBeNull();
    }
  });

  it('pasted HTML is rebuilt from formatting tags only: no scripts, handlers, styles or unsafe links', () => {
    const out = cleanPastedHtml(
      '<meta charset="utf-8"><style>p{color:red}</style><p style="color:red" onclick="x()"><b>Bold</b> <span class="c">and</span> <em>it</em></p>'
      + '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a> <a href="https://ok.example" target="_top">ok</a>'
      + '<ul><li>one</li></ul><iframe src="https://evil.example"></iframe><svg><script>alert(2)</script></svg>',
    );
    expect(out).toBe('<p><b>Bold</b> and <i>it</i></p>bad <a href="https://ok.example/">ok</a><ul><li>one</li></ul>');
  });

  it('editor text: blocks on their own lines, list items marked, styles left out', () => {
    const div = document.createElement('div');
    div.innerHTML = '<style>p{}</style><p>Hi <b>Ana</b>,</p><ul><li>One</li><li>Two</li></ul><p>Bye<br>Me</p>';
    expect(editorText(div)).toBe('Hi Ana,\n- One\n- Two\nBye\nMe');
  });
});

describe('MessageEditor (formatted message editor, 24 Nov 2026)', () => {
  it('a plain message stays the plain textarea; typing keeps it plain', async () => {
    const seen: MessageValue[] = [];
    render(<Harness start={{ text: 'Hi', html: null }} seen={seen} />);
    const box = screen.getByRole('textbox', { name: '' });
    expect(box.tagName).toBe('TEXTAREA');
    await userEvent.type(box, '!');
    expect(seen.at(-1)).toEqual({ text: 'Hi!', html: null });
    expect(frame()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove formatting' })).toBeNull();
  });

  it('a toolbar button on a plain message makes it formatted (its text as paragraphs) in the sandboxed frame', async () => {
    const seen: MessageValue[] = [];
    render(<Harness start={{ text: 'Hi Ana,\n\nThanks', html: null }} seen={seen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(seen[0]).toEqual({ text: 'Hi Ana,\n\nThanks', html: '<p>Hi Ana,</p><p>Thanks</p>' });
    expect(frame()).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame()).toHaveAttribute('title', 'Message');
    // No scripts in the frame; its loads carry no CRM cookies where the browser supports credentialless (review I1).
    expect(frame().getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame()).toHaveAttribute('credentialless');
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi Ana,</p><p>Thanks</p>'));
    expect(frameBody().getAttribute('contenteditable')).toBe('true');
    // Remove formatting goes back to the plain textarea with the text.
    await userEvent.click(screen.getByRole('button', { name: 'Remove formatting' }));
    expect(seen.at(-1)!.html).toBeNull();
    expect(frame()).toBeNull();
  });

  it('toolbar commands run on the frame: bold, italic, bulleted and numbered lists', async () => {
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={[]} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    const exec = spyExec();
    for (const name of ['Bold', 'Italic', 'Bulleted list', 'Numbered list']) await userEvent.click(screen.getByRole('button', { name }));
    expect(exec.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['bold', 'italic', 'insertUnorderedList', 'insertOrderedList']);
  });

  it('link: only http, https or mailto is added', async () => {
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={[]} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    const exec = spyExec();
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    const address = screen.getByRole('textbox', { name: 'Link address' });
    await userEvent.type(address, 'javascript:alert(1)');
    await userEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Links must start with http://, https:// or mailto:');
    expect(exec).not.toHaveBeenCalled();
    await userEvent.clear(address);
    await userEvent.type(address, 'https://dait.example{Enter}');
    expect(exec).toHaveBeenCalledWith('insertHTML', false, '<a href="https://dait.example/">https://dait.example/</a>');
    expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull();
  });

  it('paste: HTML is rebuilt from formatting tags (no scripts or handlers); plain text goes in as text', async () => {
    const seen: MessageValue[] = [];
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={seen} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    const exec = spyExec();
    const paste = (data: Record<string, string>) => {
      const e = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'clipboardData', { value: { getData: (k: string) => data[k] ?? '' } });
      act(() => {
        frame().contentDocument!.dispatchEvent(e);
      });
      return e;
    };
    const e = paste({ 'text/html': '<b onclick="x()">Hey</b><script>alert(1)</script><img src=x onerror=alert(1)>', 'text/plain': 'Hey' });
    expect(e.defaultPrevented).toBe(true);
    expect(exec).toHaveBeenLastCalledWith('insertHTML', false, '<b>Hey</b>');
    paste({ 'text/plain': 'just <text>' });
    expect(exec).toHaveBeenLastCalledWith('insertText', false, 'just <text>');
    // Each paste reports the frame's content.
    expect(seen.at(-1)).toEqual({ text: 'Hi', html: '<p>Hi</p>' });
  });

  it('typing in the frame reports its HTML and text; a new value from outside (a template) replaces the content', async () => {
    const seen: MessageValue[] = [];
    const { rerender } = render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={seen} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    frameBody().innerHTML = '<p>Hi <b>there</b></p>';
    act(() => {
      frame().contentDocument!.dispatchEvent(new Event('input'));
    });
    expect(seen.at(-1)).toEqual({ text: 'Hi there', html: '<p>Hi <b>there</b></p>' });
    // A different editor value given by the parent is written in.
    const Outside = ({ v }: { v: MessageValue }) => <MessageEditor id="m" label="Message" value={v} onChange={() => undefined} />;
    rerender(<Outside v={{ text: 'Tpl', html: '<p><i>Tpl</i></p>' }} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p><i>Tpl</i></p>'));
  });
});
