import { useT } from '../../i18n/useT';

/** Nothing loads in the frame but images and its own inline styles: no scripts, fonts, frames or form targets. */
const CSP = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'";

/**
 * The document shown in the frame: the sanitised body (the API's mail/html.ts) with a base look close to Outlook's
 * reading pane. Images narrow to the reader, and so do fixed-width newsletter tables in a narrow reader. Links open in a
 * new tab; the email's own styles win over these.
 */
export function mailFrameDoc(html: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<base target="_blank">',
    '<style>html{color-scheme:light}body{margin:0;padding:20px 24px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
    'color:#1F1533;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}',
    'a{color:#6811CF}',
    // A frame narrower than a fixed-width newsletter (600 px tables are the norm): those tables take the width there is,
    // as on a phone, instead of running off the side. Percentage widths stay as they are.
    '@media (max-width:700px){table[width]:not([width$="%"]),td[width]:not([width$="%"]),th[width]:not([width$="%"]){width:auto!important}}',
    'blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #E3DCF2}</style>',
    `</head><body>${html}</body></html>`,
  ].join('');
}

/**
 * A message body (owner, 23 Nov 2026: "proper formatting, as it look in outlook"). HTML goes in a sandboxed frame with
 * no scripts and no same-origin access, so nothing in an email can reach the CRM; it fills the reader's column and
 * scrolls on its own (with neither, the CRM cannot measure the content to size the frame to it). Plain text shows as
 * before.
 */
export function MailBody({ html, text }: { html: string | null; text: string }) {
  const t = useT();
  if (!html) return <div className="body">{text}</div>;
  return <iframe className="body-frame" title={t('Message body')} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={mailFrameDoc(html)} />;
}
