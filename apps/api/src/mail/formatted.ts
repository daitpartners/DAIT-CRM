import { processEmailBody } from './bodies.js';
import { textToHtml } from './html.js';

/**
 * Formatted (HTML) templates and messages (owner, 24 Nov 2026: an .oft template "comes as text, not in html formatted").
 * The HTML comes from the browser (an uploaded .oft, the formatted message editor), so it is never trusted: it goes
 * through the email reader's sanitiser on the same time-bounded worker thread as incoming mail (mail/bodies.ts), with
 * links limited to http, https and mailto, when a template is saved and again when a message is sent.
 */

/** Characters of sanitised HTML kept for a formatted template or message. */
export const FORMATTED_HTML_MAX = 200_000;

export interface Formatted {
  /** The sanitised HTML. */
  html: string;
  /** Its plain text (the message's text alternative, previews and search). */
  text: string;
}

/**
 * A formatted body made safe to store and send, with its plain text; null when nothing usable is left (empty, or too
 * complex to read in time): the caller then keeps the message, or the template, plain text.
 */
export async function sanitizeFormatted(html: string | null | undefined): Promise<Formatted | null> {
  if (!html?.trim()) return null;
  const r = await processEmailBody({ contentType: 'html', content: html }, FORMATTED_HTML_MAX, { outgoing: true });
  if (r.fellBack || !r.bodyHtml) return null;
  return { html: r.bodyHtml, text: r.bodyText };
}

/** A plain-text line (the Mailer's opt-out line, which starts with blank lines) added at the end of an HTML body. */
export function appendTextToHtml(html: string, text: string): string {
  const line = text.replace(/^\s*\n/, '');
  return line ? `${html}<div><br></div>${textToHtml(line)}` : html;
}

/** Request size for routes that take a formatted body (up to MESSAGE_HTML_MAX_CHARS of HTML, JSON-escaped). */
export const FORMATTED_BODY_LIMIT = 4 * 1024 * 1024;
