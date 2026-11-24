import { useEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { useT } from '../i18n/useT';
import { cleanPastedHtml, editorText, safeLinkUrl, textToEditorHtml } from '../lib/richText';

/** A message body: plain text (`html` null, sent as today) or formatted (its HTML, and the text derived from it). */
export type MessageValue = { text: string; html: string | null };

type Command = 'bold' | 'italic' | 'insertUnorderedList' | 'insertOrderedList';

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
};

/**
 * The formatted message editor (owner, 24 Nov 2026: an .oft template "comes as text, not in html formatted"): a
 * toolbar (bold, italic, bulleted and numbered lists, link) over the message. A plain message stays the plain textarea
 * it always was; a formatted template, or a toolbar button, turns it into a formatted one, edited in a sandboxed frame
 * (no scripts run there, and a template's styles stay inside it). What it holds came from the server already
 * sanitised, pastes are rebuilt from formatting tags only, links are http, https or mailto, and the server sanitises
 * the HTML again when the message is sent.
 */
export function MessageEditor({ id, label, value, onChange, rows = 7, disabled, invalid, aria }: Props) {
  const t = useT();
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
  const formatted = value.html !== null;

  const doc = () => frame.current?.contentDocument ?? null;

  function emit() {
    const d = doc();
    if (!d?.body) return;
    const html = d.body.innerHTML;
    shown.current = html;
    change.current({ text: editorText(d.body), html });
  }

  /** The frame's head, listeners and editing switched on (again after a browser replaced its first blank document). */
  function setUp(d: Document) {
    if (!d.body) return;
    if (d.body.dataset.editor !== 'on') {
      d.head.innerHTML = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><style>${FRAME_STYLE}</style>`;
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
      shown.current = null;
    }
    d.body.setAttribute('contenteditable', disabled ? 'false' : 'true');
  }

  /** Puts the value's HTML in the frame when it changed from outside (a template, the reset after sending). */
  function sync() {
    const d = doc();
    if (!d || value.html === null) return;
    setUp(d);
    if (value.html !== shown.current) {
      d.body.innerHTML = value.html;
      shown.current = value.html;
    }
    if (pending.current) {
      const cmd = pending.current;
      pending.current = null;
      focusEnd(d);
      run(cmd);
    }
  }

  useEffect(() => {
    if (value.html === null) shown.current = null;
    else sync();
  });

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

  function run(cmd: Command) {
    const d = doc();
    if (!d) return;
    frame.current?.focus();
    exec(d, cmd);
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
    frame.current?.focus();
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

  return (
    <div className="msg-editor">
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
          className={invalid ? 'in msg-frame err' : 'in msg-frame'}
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
