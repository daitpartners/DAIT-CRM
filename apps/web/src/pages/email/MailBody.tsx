import { useEffect, useRef } from 'react';
import { useT } from '../../i18n/useT';

/** Nothing loads in the frame but images and its own inline styles: no scripts, fonts, frames or form targets. */
const CSP = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'";
/** The Email screen's frame (same-origin, to size it to its content): the same policy with scripts refused in so many words (F34). */
const CSP_AUTO = "default-src 'none'; script-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'";

/** Every link opens in a new tab without telling the page who opened it (an inert parse: nothing in it runs or loads). */
function linksOutward(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const a of doc.querySelectorAll('a[href], area[href]')) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  return doc.body.innerHTML;
}

/**
 * The document shown in the frame: the sanitised body (the API's mail/html.ts) with a base look close to Outlook's
 * reading pane. Images narrow to the reader, and so do fixed-width newsletter tables in a narrow reader. Links open in a
 * new tab; the email's own styles win over these. `autoHeight` (the Email screen): scripts refused explicitly, links
 * `rel="noopener noreferrer"`, and the document does not scroll (the frame takes its height).
 */
export function mailFrameDoc(html: string, { autoHeight = false }: { autoHeight?: boolean } = {}): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${autoHeight ? CSP_AUTO : CSP}">`,
    '<base target="_blank">',
    // Pictures and links do not tell senders (or their tracking hosts) the CRM's address (security review M1).
    '<meta name="referrer" content="no-referrer">',
    '<style>html{color-scheme:light}body{margin:0;padding:20px 24px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
    'color:#1F1533;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}',
    'a{color:#6811CF}',
    autoHeight ? 'html{overflow:hidden}body{padding:16px 18px}' : '',
    // A frame narrower than a fixed-width newsletter (600 px tables are the norm): those tables take the width there is,
    // as on a phone, instead of running off the side. Percentage widths stay as they are.
    '@media (max-width:700px){table[width]:not([width$="%"]),td[width]:not([width$="%"]),th[width]:not([width$="%"]){width:auto!important}}',
    'blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #E3DCF2}</style>',
    `</head><body>${autoHeight ? linksOutward(html) : html}</body></html>`,
  ].join('');
}

/**
 * A message body (owner, 23 Nov 2026: "proper formatting, as it look in outlook"). HTML goes in a sandboxed frame with
 * no scripts, so nothing in an email can run. Without `autoHeight` (Mailer, lead page) the frame also has no same-origin
 * access: it fills the reader's column and scrolls on its own. With `autoHeight` (the Email screen's conversation,
 * web-mail release 2) the frame is same-origin but still script-free, so the CRM can read its content height: the
 * frame takes that height on load and whenever the email's body changes size (a wider or narrower pane), and the
 * conversation scrolls instead of the frame. The body is measured (not the root, whose scroll height never drops below
 * the frame's own height, so the frame could grow but never shrink). Plain text shows as text.
 */
export function MailBody({ html, text, autoHeight = false }: { html: string | null; text: string; autoHeight?: boolean }) {
  const t = useT();
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = ref.current;
    if (!autoHeight || !frame) return;
    let watch: ResizeObserver | undefined;
    const fit = () => {
      const body = frame.contentDocument?.body;
      if (body) frame.style.height = `${Math.ceil(body.scrollHeight)}px`;
    };
    const loaded = () => {
      fit();
      watch?.disconnect();
      const body = frame.contentDocument?.body;
      if (body && typeof ResizeObserver !== 'undefined') {
        watch = new ResizeObserver(fit);
        watch.observe(body);
      }
    };
    frame.addEventListener('load', loaded);
    return () => {
      frame.removeEventListener('load', loaded);
      watch?.disconnect();
    };
  }, [autoHeight, html]);

  if (!html) return <div className={autoHeight ? 'plain' : 'body'}>{text}</div>;
  if (autoHeight) {
    return (
      <div className="canvas-wrap">
        <iframe
          ref={ref}
          className="canvas"
          title={t('Message body')}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={mailFrameDoc(html, { autoHeight: true })}
        />
      </div>
    );
  }
  return <iframe className="body-frame" title={t('Message body')} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={mailFrameDoc(html)} />;
}
