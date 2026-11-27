import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageEditor, type MessageValue } from '../src/components/MessageEditor';
import { cleanPastedHtml, editorText, safeLinkUrl, textToEditorHtml } from '../src/lib/richText';

/** The editor with its value held as a form holds it; `seen` records every change. */
function Harness({ start, seen, extra }: { start: MessageValue; seen: MessageValue[]; extra?: Partial<ComponentProps<typeof MessageEditor>> }) {
  const [v, setV] = useState(start);
  return (
    <MessageEditor
      {...extra}
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

describe('MessageEditor toolbar="mail" (web-mail release 3)', () => {
  /** Each toolbar control's name, in order. */
  const toolbarNames = () => {
    const bar = within(screen.getByRole('toolbar', { name: 'Formatting' }));
    return [...bar.getAllByRole('button'), ...bar.getAllByRole('combobox')]
      .sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((c) => c.getAttribute('aria-label') ?? c.getAttribute('title'));
  };

  it('mail toolbar shows the mockup controls in order', () => {
    render(<MessageEditor toolbar="mail" id="b" label="Message" value={{ text: '', html: '<p></p>' }} onChange={() => {}} />);
    // (The brief's getAllByRole(/button|combobox/): this Testing Library takes no pattern for a role, so both roles in page order.)
    expect(toolbarNames()).toEqual([
      'Font', 'Size', 'Bold', 'Italic', 'Underline', 'Font colour', 'Highlight', 'Bullets', 'Numbering', 'Decrease indent',
      'Increase indent', 'Insert link', 'Insert picture', 'Attach file', 'Template', 'Signature',
    ]);
    expect(screen.getByRole('combobox', { name: 'Font' }).querySelectorAll('option')).toHaveLength(5);
    expect(Array.from(screen.getByRole('combobox', { name: 'Font' }).querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Aptos', 'Arial', 'Calibri', 'Georgia', 'Montserrat',
    ]);
    expect(Array.from(screen.getByRole('combobox', { name: 'Size' }).querySelectorAll('option')).map((o) => o.textContent)).toEqual(['11', '12', '14']);
  });

  it('the basic toolbar of the Mailer and templates is unchanged', () => {
    render(<MessageEditor id="b" label="Message" value={{ text: 'Hi', html: null }} onChange={() => {}} />);
    expect(
      within(screen.getByRole('toolbar', { name: 'Formatting' }))
        .getAllByRole('button')
        .map((c) => c.getAttribute('aria-label') ?? c.textContent),
    ).toEqual(['Bold', 'Italic', 'Bulleted list', 'Numbered list', 'Link']);
    expect(screen.queryByRole('combobox')).toBeNull();
    // A plain message is still the textarea there.
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
  });

  it('is always formatted: a plain value opens in the frame in the mail font, with no Remove formatting', async () => {
    render(<Harness start={{ text: 'Hi Ana,\n\nThanks', html: null }} seen={[]} extra={{ toolbar: 'mail' }} />);
    expect(document.querySelector('textarea')).toBeNull();
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi Ana,</p><p>Thanks</p>'));
    expect(frame()).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(screen.queryByRole('button', { name: 'Remove formatting' })).toBeNull();
    const style = frame().contentDocument!.head.querySelector('style')!.textContent!;
    expect(style).toContain('font:14px/1.55 Aptos, Calibri, "Segoe UI", Arial, sans-serif');
  });

  it('runs its commands on the frame, with styleWithCSS for font, colour, highlight, underline and indent', async () => {
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={[]} extra={{ toolbar: 'mail' }} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    const exec = spyExec();
    for (const name of ['Bold', 'Italic', 'Underline', 'Bullets', 'Numbering', 'Decrease indent', 'Increase indent']) {
      await userEvent.click(screen.getByRole('button', { name }));
    }
    const calls = () => exec.mock.calls.map((c) => (c as unknown[]).filter((x, i) => i !== 1 && x !== undefined));
    expect(calls()).toEqual([
      ['styleWithCSS', 'false'], ['bold'],
      ['styleWithCSS', 'false'], ['italic'],
      ['styleWithCSS', 'true'], ['underline'],
      ['styleWithCSS', 'false'], ['insertUnorderedList'],
      ['styleWithCSS', 'false'], ['insertOrderedList'],
      ['styleWithCSS', 'true'], ['outdent'],
      ['styleWithCSS', 'true'], ['indent'],
    ]);
    exec.mockClear();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Font' }), 'Georgia');
    expect(calls()).toEqual([['styleWithCSS', 'true'], ['fontName', 'Georgia, serif']]);
    exec.mockClear();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Size' }), '12');
    expect(calls()).toContainEqual(['fontSize', '7']);
    exec.mockClear();
    // Font colour: a palette of eight; the chosen colour is applied and shown under the A.
    await userEvent.click(screen.getByRole('button', { name: 'Font colour' }));
    const colours = screen.getByRole('group', { name: 'Font colour' });
    expect(within(colours).getAllByRole('button').map((b) => b.getAttribute('title'))).toEqual([
      '#1F1533', '#C62828', '#E65100', '#2E7D32', '#1565C0', '#6811CF', '#6B7280', '#FFFFFF',
    ]);
    await userEvent.click(within(colours).getByTitle('#1565C0'));
    expect(calls()).toEqual([['styleWithCSS', 'true'], ['foreColor', '#1565C0']]);
    expect(screen.queryByRole('group', { name: 'Font colour' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Font colour' }).querySelector('.clr')).toHaveStyle({ background: '#1565C0' });
    exec.mockClear();
    // Highlight: four colours and none.
    await userEvent.click(screen.getByRole('button', { name: 'Highlight' }));
    const marks = screen.getByRole('group', { name: 'Highlight' });
    expect(within(marks).getAllByRole('button').map((b) => b.getAttribute('title'))).toEqual(['#FFE14D', '#B9F6CA', '#B3E5FC', '#F8BBD0', 'No highlight']);
    await userEvent.click(within(marks).getByTitle('No highlight'));
    expect(calls()).toEqual([['styleWithCSS', 'true'], ['hiliteColor', 'transparent']]);
  });

  it('Signature inserts the signature block once and replaces it on a second click', async () => {
    const seen: MessageValue[] = [];
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={seen} extra={{ toolbar: 'mail', signatureHtml: '<b>Maya</b>' }} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    await userEvent.click(screen.getByRole('button', { name: 'Signature' }));
    expect(frameBody().innerHTML).toBe('<p>Hi</p><p><br></p><div class="dait-sig"><b>Maya</b></div>');
    expect(seen.at(-1)!.html).toBe('<p>Hi</p><p><br></p><div class="dait-sig"><b>Maya</b></div>');
    // The signature changed by hand is put back as it is, not added twice.
    frameBody().querySelector('.dait-sig')!.innerHTML = 'edited';
    await userEvent.click(screen.getByRole('button', { name: 'Signature' }));
    expect(frameBody().innerHTML).toBe('<p>Hi</p><p><br></p><div class="dait-sig"><b>Maya</b></div>');
    expect(frameBody().querySelectorAll('.dait-sig')).toHaveLength(1);
  });

  it('Signature, picture, attach and template stay disabled without what they need', () => {
    render(<MessageEditor toolbar="mail" id="b" label="Message" value={{ text: '', html: '<p></p>' }} onChange={() => {}} />);
    for (const name of ['Insert picture', 'Attach file', 'Template', 'Signature']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('Insert picture calls onPicture and inserts the returned picture', async () => {
    const seen: MessageValue[] = [];
    const onPicture = vi.fn(async () => ({ contentId: 'img-1@dait', dataUrl: 'data:image/png;base64,AA==' }));
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={seen} extra={{ toolbar: 'mail', onPicture }} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.click(screen.getByRole('button', { name: 'Insert picture' }));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept="image/png,image/jpeg,image/gif"]')!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' });
    await userEvent.upload(input, file);
    expect(onPicture).toHaveBeenCalledWith(file);
    await waitFor(() => expect(frameBody().innerHTML).toContain('<img src="data:image/png;base64,AA==" data-cid="img-1@dait">'));
    expect(seen.at(-1)!.html).toContain('data-cid="img-1@dait"');
  });

  it('a picture refused by the composer (null) or not a data:image address is not inserted', async () => {
    const onPicture = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ contentId: 'x', dataUrl: 'javascript:alert(1)' });
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={[]} extra={{ toolbar: 'mail', onPicture }} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept="image/png,image/jpeg,image/gif"]')!;
    await userEvent.upload(input, new File(['a'], 'a.png', { type: 'image/png' }));
    await userEvent.upload(input, new File(['b'], 'b.png', { type: 'image/png' }));
    await waitFor(() => expect(onPicture).toHaveBeenCalledTimes(2));
    expect(frameBody().innerHTML).toBe('<p>Hi</p>');
  });

  it('Attach file hands the chosen files to onAttach; Template gives onTemplate its button', async () => {
    const onAttach = vi.fn();
    const onTemplate = vi.fn();
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={[]} extra={{ toolbar: 'mail', onAttach, onTemplate }} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
    const files = [new File(['a'], 'a.pdf', { type: 'application/pdf' }), new File(['b'], 'b.pdf', { type: 'application/pdf' })];
    await userEvent.upload(input, files);
    expect(onAttach).toHaveBeenCalledWith(files);
    await userEvent.click(screen.getByRole('button', { name: 'Template' }));
    expect(onTemplate).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Template' }));
  });

  it("typing in the frame never reaches the page's keyboard shortcuts", async () => {
    render(<Harness start={{ text: 'Hi', html: '<p>Hi</p>' }} seen={[]} extra={{ toolbar: 'mail' }} />);
    await waitFor(() => expect(frameBody().innerHTML).toBe('<p>Hi</p>'));
    const onKey = vi.fn();
    window.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    frameBody().dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('keydown', onKey);
    expect(onKey).not.toHaveBeenCalled();
  });
});
