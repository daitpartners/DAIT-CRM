import { useEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useT } from '../i18n/useT';
import { applyFontSize, cleanPastedHtml, editorText, safeLinkUrl, textToEditorHtml, type MailFontSize } from '../lib/richText';
import { Icons } from './Icons';

/** A message body: plain text (`html` null, sent as today) or formatted (its HTML, and the text derived from it). */
export type MessageValue = { text: string; html: string | null };

type Command = 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList' | 'underline' | 'indent' | 'outdent';
type StyleCommand = Command | 'fontName' | 'foreColor' | 'hiliteColor';
/** Mail toolbar commands the browser writes as CSS (a span's style), as Outlook does; the rest keep their tags. */
const CSS_COMMANDS = new Set<StyleCommand>(['fontName', 'foreColor', 'hiliteColor', 'underline', 'indent', 'outdent']);

/** The mail toolbar's fonts: the name shown, and the family written (with fallbacks for a reader without the font). */
const MAIL_FONTS: [string, string][] = [
  ['Aptos', 'Aptos, Calibri, sans-serif'],
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Calibri', 'Calibri, Carlito, sans-serif'],
  ['Georgia', 'Georgia, serif'],
  ['Montserrat', 'Montserrat, Arial, sans-serif'],
];
const MAIL_SIZES: MailFontSize[] = [11, 12, 14];
/** A picture the composer hands back: a data:image address of a picture type the server takes. */
const PICTURE_DATA = /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/i;

/** Where a quoted message starts in a draft made in Outlook (Outlook's reply header, Gmail's quote, a cited quote). */
const QUOTE_START = '#appendonsend, #divRplyFwdMsg, [id^="divRplyFwdMsg"], .gmail_quote, blockquote[type="cite"]';

/** The browser's editing commands on the frame's document (absent where there is no editing, e.g. jsdom). */
const exec = (d: Document, cmd: string, arg?: string) => d.execCommand?.(cmd, false, arg);

/** The frame's selection (null where the environment has none). */
function selection(d: Document): Selection | null {
  try {
    return d.getSelection();
  } catch {
    return null;
  }
}

/** Nothing runs or loads in the editing frame but images and its own styles (the sandbox has no scripts either). */
const CSP = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'";
/** The frame's base look: the CRM's field text (as a textarea .in); a template's own styles win over it. */
const FRAME_STYLE =
  'html{color-scheme:light}body{margin:0;padding:10px 12px;font:13.5px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;'
  + 'color:#1F1533;background:#fff;overflow-wrap:anywhere;min-height:calc(100% - 20px);outline:none}p{margin:0 0 .6em}'
  + 'img{max-width:100%;height:auto}a{color:#6811CF}ul,ol{margin:0 0 .6em;padding-left:1.6em}';
/**
 * The mail editor's look: the message as web mail writes it (the mockup's .rbody), not the CRM's field text; the
 * signature block as the mockup's .sig (these rules live in the frame only: what is sent carries the signature's own
 * formatting).
 */
const MAIL_FRAME_STYLE =
  'html{color-scheme:light}body{margin:0;padding:12px 14px 6px;font:14px/1.55 Aptos, Calibri, "Segoe UI", Arial, sans-serif;'
  + 'color:#1F1533;background:#fff;overflow-wrap:anywhere;min-height:calc(100% - 18px);outline:none}p{margin:0 0 10px}'
  + 'img{max-width:100%;height:auto}a{color:#6811CF}ul,ol{margin:0 0 10px;padding-left:1.6em}'
  + '.dait-sig{margin-top:10px;padding-top:8px;border-top:1px solid #EEE;font-size:12.5px;color:#4A3F66;line-height:1.45}'
  + '.dait-sig b{color:#1F0249}';

type Props = {
  id: string;
  /** The field's name: the frame's title (a label's htmlFor reaches the plain textarea only). */
  label: string;
  value: MessageValue;
  onChange: (v: MessageValue) => void;
  rows?: number;
  disabled?: boolean;
  invalid?: boolean;
  /** aria-invalid / aria-describedby from the form's error marking. */
  aria?: Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-invalid' | 'aria-describedby'>;
  /**
   * `basic` (templates, the Mailer, the signature card, the lead page): bold, italic, lists and link. `mail` (web mail's
   * composer): always formatted, in the mail font, with the mockup's full toolbar.
   */
  toolbar?: 'basic' | 'mail';
  /** Mail: uploads a chosen picture to the draft; its content id and data are inserted at the caret (null: refused). */
  onPicture?: (file: File) => Promise<{ contentId: string; dataUrl: string } | null>;
  /** Mail: files chosen with Attach file. */
  onAttach?: (files: File[]) => void;
  /** Mail: the Template button was pressed (the composer opens its templates menu at it). */
  onTemplate?: (anchor: HTMLElement) => void;
  /** Mail: the user's signature HTML (server-sanitised); the Signature button is off without one. */
  signatureHtml?: string | null;
  /** Mail: the message frame grows with what it holds (at least 120 px), as the mockup's inline reply and New message do. */
  autoGrow?: boolean;
};

/**
 * The formatted message editor (owner, 24 Nov 2026: an .oft template "comes as text, not in html formatted"): a
 * toolbar (bold, italic, bulleted and numbered lists, link) over the message. A plain message stays the plain textarea
 * it always was; a formatted template, or a toolbar button, turns it into a formatted one, edited in a sandboxed frame
 * (no scripts run there, and a template's styles stay inside it). What it holds came from the server already
 * sanitised, pastes are rebuilt from formatting tags only, links are http, https or mailto, and the server sanitises
 * the HTML again when the message is sent.
 */
export function MessageEditor(props: Props) {
  const { id, label, value, onChange, rows = 7, disabled, invalid, aria, toolbar = 'basic', onPicture, onAttach, onTemplate, signatureHtml, autoGrow = false } = props;
  const t = useT();
  const mail = toolbar === 'mail';
  const frame = useRef<HTMLIFrameElement>(null);
  /** The HTML the frame holds now (written to it, or read from it): an outside change (a template) differs from it. */
  const shown = useRef<string | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  /** A toolbar command chosen while the message was plain: run once the frame holds the converted text. */
  const pending = useRef<Command | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState(false);
  /** Mail: the open colour palette, and the last colours chosen (shown under the buttons, as the mockup). */
  const [palette, setPalette] = useState<'colour' | 'highlight' | null>(null);
  const [colour, setColour] = useState('#C62828');
  const [mark, setMark] = useState('#FFE14D');
  const [font, setFont] = useState(MAIL_FONTS[0][0]);
  const [size, setSize] = useState<MailFontSize>(11);
  /** Mail: the frame's last selection, put back after a toolbar select, palette or file dialog took the focus. */
  const saved = useRef<Range | null>(null);
  const paletteBox = useRef<HTMLSpanElement | null>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  /** The HTML the editor shows: a mail editor shows a plain value as paragraphs (it is never the textarea). */
  const editorHtml = value.html ?? (mail ? textToEditorHtml(value.text) : null);
  const formatted = editorHtml !== null;

  const doc = () => frame.current?.contentDocument ?? null;

  function emit() {
    const d = doc();
    if (!d?.body) return;
    const html = d.body.innerHTML;
    shown.current = html;
    change.current({ text: editorText(d.body), html });
    fit();
  }

  /**
   * autoGrow: the frame as tall as its content (the last element's bottom plus the body's bottom padding), at least
   * 120 px. Measured from the content, since the body's own height never drops below the frame's.
   */
  function fit() {
    const f = frame.current;
    const d = doc();
    if (!autoGrow || !f || !d?.body) return;
    const last = d.body.lastElementChild;
    const bottom = last ? last.getBoundingClientRect().bottom + 6 : 0;
    f.style.height = `${Math.max(120, Math.ceil(bottom))}px`;
  }

  /** The frame's head, listeners and editing switched on (again after a browser replaced its first blank document). */
  function setUp(d: Document) {
    if (!d.body) return;
    if (d.body.dataset.editor !== 'on') {
      d.head.innerHTML = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><style>${mail ? MAIL_FRAME_STYLE : FRAME_STYLE}</style>`;
      d.body.dataset.editor = 'on';
      d.body.setAttribute('role', 'textbox');
      d.body.setAttribute('aria-multiline', 'true');
      d.body.setAttribute('aria-label', label);
      d.addEventListener('input', emit);
      d.addEventListener('paste', (e) => {
        e.preventDefault();
        const html = e.clipboardData?.getData('text/html') ?? '';
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (html) exec(d, 'insertHTML', cleanPastedHtml(html));
        else if (text) exec(d, 'insertText', text);
        emit();
      });
      // Dropped content would arrive unfiltered: only its plain text goes in.
      d.addEventListener('drop', (e) => {
        e.preventDefault();
        const text = e.dataTransfer?.getData('text/plain') ?? '';
        if (text) exec(d, 'insertText', text);
        emit();
      });
      if (mail) {
        d.addEventListener('selectionchange', () => {
          const sel = selection(d);
          if (sel && sel.rangeCount > 0 && d.body.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
        });
        // A click in the message closes an open palette (the page's own clicks never see the frame's).
        d.addEventListener('mousedown', () => setPalette(null));
      }
      shown.current = null;
    }
    d.body.setAttribute('contenteditable', disabled ? 'false' : 'true');
  }

  /** Puts the value's HTML in the frame when it changed from outside (a template, the reset after sending). */
  function sync() {
    const d = doc();
    if (!d || editorHtml === null) return;
    setUp(d);
    if (editorHtml !== shown.current) {
      d.body.innerHTML = editorHtml;
      shown.current = editorHtml;
      fit();
    }
    if (pending.current) {
      const cmd = pending.current;
      pending.current = null;
      focusEnd(d);
      run(cmd);
    }
  }

  useEffect(() => {
    if (editorHtml === null) shown.current = null;
    else sync();
  });

  // autoGrow: a narrower or wider frame wraps its text again.
  useEffect(() => {
    const f = frame.current;
    if (!autoGrow || !f || typeof ResizeObserver === 'undefined') return;
    let width = f.clientWidth;
    const watch = new ResizeObserver(() => {
      if (f.clientWidth === width) return;
      width = f.clientWidth;
      fit();
    });
    watch.observe(f);
    return () => watch.disconnect();
  }, [autoGrow, formatted]);

  // An open palette closes on a click elsewhere on the page or on Escape.
  useEffect(() => {
    if (!palette) return;
    const away = (e: MouseEvent) => {
      if (!paletteBox.current?.contains(e.target as Node)) setPalette(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPalette(null);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [palette]);

  /** The caret at the end of the message. */
  function focusEnd(d: Document) {
    frame.current?.focus();
    const sel = selection(d);
    if (!sel || !d.body) return;
    const range = d.createRange();
    range.selectNodeContents(d.body.lastElementChild ?? d.body);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** The frame focused; in a mail editor its last selection is put back when the focus had left it. */
  function focusFrame(d: Document) {
    frame.current?.focus();
    if (!mail || !saved.current) return;
    const sel = selection(d);
    if (sel && (sel.rangeCount === 0 || !d.body.contains(sel.anchorNode))) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
  }

  function run(cmd: StyleCommand, arg?: string) {
    const d = doc();
    if (!d) return;
    if (mail) {
      focusFrame(d);
      exec(d, 'styleWithCSS', CSS_COMMANDS.has(cmd) ? 'true' : 'false');
    } else frame.current?.focus();
    exec(d, cmd, arg);
    emit();
  }

  /** Mail: a node put at the caret (the end of the message when there is none), as the browser's own insert. */
  function insertAtCaret(d: Document, node: Element) {
    focusFrame(d);
    if (exec(d, 'insertHTML', node.outerHTML)) return;
    const sel = selection(d);
    if (sel && sel.rangeCount > 0 && d.body.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(node);
    } else d.body.appendChild(node);
  }

  async function addPicture(file: File) {
    let got: { contentId: string; dataUrl: string } | null | undefined;
    try {
      got = await onPicture?.(file);
    } catch {
      return; // the composer says why (its onPicture shows the refusal)
    }
    const d = doc();
    if (!got || !d?.body || !PICTURE_DATA.test(got.dataUrl)) return;
    const img = d.createElement('img');
    img.setAttribute('src', got.dataUrl);
    img.setAttribute('data-cid', got.contentId);
    insertAtCaret(d, img);
    emit();
  }

  /**
   * Mail: the signature block at the end of the user's own part, or the one already there put back as the signature. A
   * quoted message (a draft made in Outlook opens whole, its quote under the user's part) is never touched: neither its
   * own `.dait-sig` nor anything under where it starts.
   */
  function addSignature() {
    const d = doc();
    if (!signatureHtml || !d?.body) return;
    const quote = d.body.querySelector(QUOTE_START);
    const own = Array.from(d.body.querySelectorAll('.dait-sig'))
      .filter((el) => !quote || (!quote.contains(el) && (quote.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0));
    const last = own[own.length - 1];
    const block = `<p><br></p><div class="dait-sig">${signatureHtml}</div>`;
    if (last) last.innerHTML = signatureHtml;
    else if (quote) (quote.previousElementSibling?.tagName === 'HR' ? quote.previousElementSibling : quote).insertAdjacentHTML('beforebegin', block);
    else d.body.insertAdjacentHTML('beforeend', block);
    emit();
  }

  function chooseSize(pt: MailFontSize) {
    setSize(pt);
    const d = doc();
    if (!d?.body) return;
    focusFrame(d);
    applyFontSize(d, pt);
    emit();
  }

  /** A toolbar button: on a plain message it first becomes formatted (its text as paragraphs). */
  function command(cmd: Command) {
    if (disabled) return;
    if (!formatted) {
      pending.current = cmd;
      change.current({ text: value.text, html: textToEditorHtml(value.text) });
      return;
    }
    run(cmd);
  }

  function addLink() {
    const url = safeLinkUrl(link);
    if (!url) return setLinkError(true);
    const d = doc();
    if (!d) return;
    focusFrame(d);
    const sel = selection(d);
    if (!sel || sel.rangeCount === 0 || !d.body.contains(sel.anchorNode)) focusEnd(d);
    if (selection(d)?.isCollapsed ?? true) {
      // No text chosen: the address itself becomes the link text.
      const a = d.createElement('a');
      a.href = url;
      a.textContent = url.replace(/^mailto:/, '');
      exec(d, 'insertHTML', a.outerHTML);
    } else exec(d, 'createLink', url);
    emit();
    setLinkOpen(false);
    setLink('');
    setLinkError(false);
  }

  function openLink() {
    if (disabled) return;
    if (!formatted) change.current({ text: value.text, html: textToEditorHtml(value.text) });
    setLinkOpen(true);
    setLinkError(false);
  }

  const tool = (cmd: Command, name: string, glyph: ReactNode) => (
    <button
      type="button"
      className="btn xs"
      aria-label={name}
      title={name}
      disabled={disabled}
      // Keeps the selection in the message while the button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => command(cmd)}
    >
      {glyph}
    </button>
  );

  /** A mail toolbar button: keeps the selection in the message while it is pressed. */
  const tb = (name: string, glyph: ReactNode, onClick: (el: HTMLButtonElement) => void, opts: { off?: boolean; wide?: boolean; title?: string; expanded?: boolean } = {}) => (
    <button
      type="button"
      className={opts.wide ? 'tb wide' : 'tb'}
      aria-label={name}
      title={opts.title ?? name}
      disabled={disabled || opts.off}
      aria-expanded={opts.expanded}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onClick(e.currentTarget)}
    >
      {glyph}
    </button>
  );
  const ico = (name: string) => (
    <span className="ico" aria-hidden="true">
      {Icons[name]}
    </span>
  );
  /** A colour button and, while open, its palette of swatches. */
  const swatches = (
    kind: 'colour' | 'highlight',
    name: string,
    glyph: ReactNode,
    choices: { hex: string; name: string; title?: string; value?: string }[],
    choose: (c: { hex: string; value?: string }) => void,
  ) => (
    <span className="tb-pop" ref={palette === kind ? paletteBox : undefined}>
      {tb(name, glyph, () => setPalette(palette === kind ? null : kind), { expanded: palette === kind })}
      {palette === kind ? (
        <span className={kind === 'highlight' ? 'tb-pal hl' : 'tb-pal'} role="group" aria-label={name}>
          {choices.map((c) => (
            <button
              key={c.hex}
              type="button"
              className={c.value === 'transparent' ? 'tb-sw none' : 'tb-sw'}
              title={c.title ?? c.hex}
              aria-label={c.name}
              style={c.value === 'transparent' ? undefined : { background: c.hex }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPalette(null);
                choose(c);
              }}
            />
          ))}
        </span>
      ) : null}
    </span>
  );

  const mailTools = (
    <div className="tbar" role="toolbar" aria-label={t('Formatting')} aria-controls={id}>
      <select
        aria-label={t('Font')}
        value={font}
        disabled={disabled}
        onChange={(e) => {
          setFont(e.target.value);
          const family = MAIL_FONTS.find(([n]) => n === e.target.value)?.[1];
          if (family) run('fontName', family);
        }}
      >
        {MAIL_FONTS.map(([n]) => (
          <option key={n}>{n}</option>
        ))}
      </select>
      <select aria-label={t('Size')} value={size} disabled={disabled} onChange={(e) => chooseSize(Number(e.target.value) as MailFontSize)}>
        {MAIL_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <span className="tb-sep" />
      {tb(t('Bold'), <b>B</b>, () => run('bold'))}
      {tb(t('Italic'), <i className="tb-i">I</i>, () => run('italic'))}
      {tb(t('Underline'), <u>U</u>, () => run('underline'))}
      {swatches(
        'colour',
        t('Font colour'),
        <span className="tb-a">
          A<span className="clr" style={{ background: colour }} />
        </span>,
        [
          { hex: '#1F1533', name: t('Black') },
          { hex: '#C62828', name: t('Red') },
          { hex: '#E65100', name: t('Orange') },
          { hex: '#2E7D32', name: t('Green') },
          { hex: '#1565C0', name: t('Blue') },
          { hex: '#6811CF', name: t('Purple') },
          { hex: '#6B7280', name: t('Grey') },
          { hex: '#FFFFFF', name: t('White') },
        ],
        (c) => {
          setColour(c.hex);
          run('foreColor', c.hex);
        },
      )}
      {swatches(
        'highlight',
        t('Highlight'),
        <span className="tb-a">
          <span className="ico mk" aria-hidden="true">
            {Icons.marker}
          </span>
          <span className="clr" style={{ background: mark }} />
        </span>,
        [
          { hex: '#FFE14D', name: t('Yellow') },
          { hex: '#B9F6CA', name: t('Green') },
          { hex: '#B3E5FC', name: t('Blue') },
          { hex: '#F8BBD0', name: t('Pink') },
          { hex: 'none', name: t('No highlight'), title: t('No highlight'), value: 'transparent' },
        ],
        (c) => {
          const v = c.value ?? c.hex;
          setMark(v);
          run('hiliteColor', v);
        },
      )}
      <span className="tb-sep" />
      {tb(t('Bullets'), ico('bullets'), () => run('insertUnorderedList'))}
      {tb(t('Numbering'), ico('numbers'), () => run('insertOrderedList'))}
      {tb(t('Decrease indent'), ico('outdent'), () => run('outdent'))}
      {tb(t('Increase indent'), ico('indent'), () => run('indent'))}
      <span className="tb-sep" />
      {tb(t('Insert link'), ico('link'), openLink)}
      {tb(t('Insert picture'), ico('image'), () => pictureInput.current?.click(), { off: !onPicture })}
      {tb(t('Attach file'), ico('clip'), () => attachInput.current?.click(), { off: !onAttach })}
      <span className="tb-sep" />
      {tb(t('Template'), <>{ico('template')}{t('Template')}</>, (el) => onTemplate?.(el), { off: !onTemplate, wide: true, title: t('Insert template') })}
      {tb(t('Signature'), <>{ico('pen')}{t('Signature')}</>, addSignature, { off: !signatureHtml, wide: true })}
    </div>
  );

  return (
    <div className={mail ? 'msg-editor mail' : 'msg-editor'}>
      {mail ? (
        <>
          {mailTools}
          <input
            ref={pictureInput}
            type="file"
            accept="image/png,image/jpeg,image/gif"
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void addPicture(file);
            }}
          />
          <input
            ref={attachInput}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (files.length) onAttach?.(files);
            }}
          />
        </>
      ) : (
        <div className="msg-tools" role="toolbar" aria-label={t('Formatting')} aria-controls={id}>
          {tool('bold', t('Bold'), <b>B</b>)}
          {tool('italic', t('Italic'), <i>I</i>)}
          {tool('insertUnorderedList', t('Bulleted list'), '•')}
          {tool('insertOrderedList', t('Numbered list'), '1.')}
          <button type="button" className="btn xs" title={t('Link|format')} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={openLink}>
            {t('Link|format')}
          </button>
          {formatted ? (
            <>
              <span className="grow" />
              <button
                type="button"
                className="btn xs"
                disabled={disabled}
                onClick={() => {
                  setLinkOpen(false);
                  change.current({ text: value.text, html: null });
                }}
              >
                {t('Remove formatting')}
              </button>
            </>
          ) : null}
        </div>
      )}
      {linkOpen ? (
        <div className="msg-link">
          <input
            className={linkError ? 'in err' : 'in'}
            aria-label={t('Link address')}
            placeholder="https://"
            value={link}
            autoFocus
            aria-invalid={linkError || undefined}
            onChange={(e) => {
              setLink(e.target.value);
              setLinkError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addLink();
              } else if (e.key === 'Escape') setLinkOpen(false);
            }}
          />
          <button type="button" className="btn xs primary" onClick={addLink}>
            {t('Add link')}
          </button>
          <button type="button" className="btn xs" onClick={() => setLinkOpen(false)}>
            {t('Cancel')}
          </button>
          {linkError ? (
            <div className="err-msg" role="alert">
              {t('Links must start with http://, https:// or mailto:')}
            </div>
          ) : null}
        </div>
      ) : null}
      {formatted ? (
        <iframe
          ref={frame}
          id={id}
          title={label}
          className={mail ? `rbody${autoGrow ? ' grow' : ''}${invalid ? ' err' : ''}` : invalid ? 'in msg-frame err' : 'in msg-frame'}
          // Same-origin so the CRM can edit it; no allow-scripts, so nothing in a message can run. Where supported,
          // `credentialless` also keeps the CRM's cookies off anything the frame loads (security review I1; the server
          // already removes pictures that point at the CRM).
          {...{ credentialless: '' }}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          aria-invalid={aria?.['aria-invalid']}
          aria-describedby={aria?.['aria-describedby']}
          onLoad={() => {
            shown.current = null;
            sync();
          }}
        />
      ) : (
        <textarea
          id={id}
          className={invalid ? 'in err' : 'in'}
          rows={rows}
          value={value.text}
          disabled={disabled}
          {...aria}
          onChange={(e) => change.current({ text: e.target.value, html: null })}
        />
      )}
    </div>
  );
}
