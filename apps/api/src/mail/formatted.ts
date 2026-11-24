import type { FastifyRequest } from 'fastify';
import { processEmailBody } from './bodies.js';
import { RAW_MAX, textToHtml } from './html.js';
import { ValidationError } from '../validate.js';

/**
 * Formatted (HTML) templates and messages (owner, 24 Nov 2026: an .oft template "comes as text, not in html formatted").
 * The HTML comes from the browser (an uploaded .oft, the formatted message editor), so it is never trusted: it goes
 * through the email reader's sanitiser on the same time-bounded worker thread as incoming mail (mail/bodies.ts), in
 * its outgoing mode (links absolute http, https or mailto; pictures absolute http(s) on another host, or data:image),
 * when a template is saved and again when a message is sent. A body is never cut short: one over its cap is refused.
 */

/** Characters of sanitised HTML a message may send. */
export const FORMATTED_HTML_MAX = 200_000;
/**
 * Characters of sanitised HTML a template may keep: well below FORMATTED_HTML_MAX, so filled merge fields and the
 * Mailer's opt-out line always fit when it is sent.
 */
export const TEMPLATE_HTML_MAX = 150_000;

/** Request size for routes that take a formatted body (up to MESSAGE_HTML_MAX_CHARS of HTML, JSON-escaped). */
export const FORMATTED_BODY_LIMIT = 4 * 1024 * 1024;

/**
 * Route config: at most `max` requests a minute per signed-in user (route hooks run after the session hook), so one
 * user cannot fill the shared sanitiser worker's queue (security review M2).
 */
export const perUser = (max: number) => ({
  rateLimit: { max, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => (req.user ? `user:${req.user.id}` : req.ip) },
});

export interface Formatted {
  /** The sanitised HTML. */
  html: string;
  /** Its plain text (the message's text alternative, previews and search). */
  text: string;
}

/**
 * What sanitising gave: `html` usable formatted HTML; `empty` nothing left (only markup that was removed); `fallback`
 * the worker gave up (`retry`: a timeout or crash, likely a busy machine; otherwise too complex to read), with the
 * plain fallback text of the body.
 */
export type FormattedResult = ({ kind: 'html' } & Formatted) | { kind: 'empty' } | { kind: 'fallback'; text: string; retry: boolean };

/** A formatted body refused, answered as `{ error: code }` with `status` (app.ts error handler). */
export class FormattedBodyError extends Error {
  constructor(readonly code: 'message_too_long' | 'try_again' | 'html_too_complex', readonly status: number) {
    super(code);
    this.name = 'FormattedBodyError';
  }
}

/** A formatted body longer than its cap (sanitised): refused as `message_too_long` (413), never cut. */
export class MessageTooLongError extends FormattedBodyError {
  constructor() {
    super('message_too_long', 413);
  }
}

/**
 * A template's HTML to store: sanitised (TEMPLATE_HTML_MAX), with the text derived from it; null for none. Never a
 * silent plain-text template: a worker timeout is 409 `try_again`, HTML too complex to read 422 `html_too_complex`.
 */
export async function templateHtml(html: string | null | undefined): Promise<Formatted | null> {
  if (!html?.trim()) return null;
  const r = await sanitizeFormatted(html, TEMPLATE_HTML_MAX);
  if (r.kind === 'fallback') throw r.retry ? new FormattedBodyError('try_again', 409) : new FormattedBodyError('html_too_complex', 422);
  return r.kind === 'html' ? { html: r.html, text: r.text } : null;
}

/** Sanitises a formatted body (see the file comment); throws MessageTooLongError past `max` characters. */
export async function sanitizeFormatted(html: string, max: number): Promise<FormattedResult> {
  if (!html.trim()) return { kind: 'empty' };
  if (html.length > RAW_MAX) throw new MessageTooLongError();
  const r = await processEmailBody({ contentType: 'html', content: html }, RAW_MAX, { outgoing: true, whole: true });
  if (r.fellBack) return { kind: 'fallback', text: r.bodyText, retry: r.reason === 'timeout' || r.reason === 'crash' };
  if (!r.bodyHtml) return { kind: 'empty' };
  if (r.bodyHtml.length > max) throw new MessageTooLongError();
  return { kind: 'html', html: r.bodyHtml, text: r.bodyText };
}

/**
 * The message to queue from what the browser sent: a formatted one (sanitised HTML and the text derived from it on
 * the server), or plain text. HTML that sanitising empties, or that the worker could not read, is sent as plain text
 * (its readable text, else the plain `body` sent along). No message at all is a 400 on `body`.
 */
export async function outgoingBody(body: string | undefined, bodyHtml: string | null | undefined): Promise<{ body: string; formatted: Formatted | null }> {
  const plain = (body ?? '').trim();
  let text = plain;
  if (bodyHtml?.trim()) {
    const r = await sanitizeFormatted(bodyHtml, FORMATTED_HTML_MAX);
    if (r.kind === 'html') return { body: r.text || plain, formatted: { html: r.html, text: r.text || plain } };
    text = (r.kind === 'fallback' ? r.text.trim() : '') || plain;
  }
  // Nothing to send: Message is marked, as an empty plain message is.
  if (!text) throw new ValidationError([{ path: ['body'], message: 'Enter a message' }]);
  return { body: text, formatted: null };
}

/**
 * The Mailer's opt-out line as HTML, added after the body is sanitised: fixed markup with the line escaped, so it is
 * always the last thing in the email.
 */
export function optOutHtml(line: string): string {
  const text = line.replace(/^\s*\n/, '');
  return text ? `<div><br></div>${textToHtml(text)}` : '';
}

/**
 * A Mailer email's HTML: the filled template sanitised (FORMATTED_HTML_MAX), then the opt-out line (optOutHtml) after
 * it, so sanitising or a cap can never drop it. null: send the plain text instead (nothing usable, the worker gave up,
 * or the HTML is too long), which carries the opt-out line too.
 */
export async function formattedMailerHtml(filled: string, optOut: string): Promise<string | null> {
  try {
    const r = await sanitizeFormatted(filled, FORMATTED_HTML_MAX);
    return r.kind === 'html' ? r.html + optOutHtml(optOut) : null;
  } catch (err) {
    if (err instanceof MessageTooLongError) return null;
    throw err;
  }
}

