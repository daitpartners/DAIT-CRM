import sanitizeHtml from 'sanitize-html';
import { Parser } from 'htmlparser2';

/**
 * Email bodies as HTML (owner, 23 Nov 2026: "it should come proper formatting, as it look in outlook"). Mail is
 * sanitised here before it is stored or served, and the reader shows it in a sandboxed iframe with no scripts.
 */

/** Plain text as simple HTML: escaped, line breaks kept (what the CRM sends, and stores as the message's HTML). */
export function textToHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<div>${escaped.replace(/\r?\n/g, '<br>')}</div>`;
}

/** Normal email formatting: sanitize-html's text, list and table tags, plus images, old-style font / center and <style>. */
const TAGS = [...sanitizeHtml.defaults.allowedTags, 'img', 'font', 'center', 'big', 'strike', 'del', 'ins', 'tt', 'style'];
const LAYOUT = ['align', 'valign', 'width', 'height', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'nowrap'];
const ATTRIBUTES: Record<string, string[]> = {
  '*': ['style', 'class', 'id', 'dir', 'lang', 'title', 'role', ...LAYOUT],
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  font: ['face', 'color', 'size'],
  ol: ['start', 'type'],
  td: ['headers', 'scope'],
  th: ['headers', 'scope'],
};

/**
 * A CSS declaration (or rule text) that could run code, fetch from somewhere other than the web, or pin a box over the
 * reading pane (any position but static / relative, and z-index: a fake "sign in again" panel; Outlook strips
 * positioning too). An HTML entity is never CSS, only an attempt to smuggle markup: its declaration goes whole.
 */
const BAD_CSS =
  /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|\\|url\s*\(\s*(?!['"]?\s*(?:https?:|data:image\/))|position\s*:(?!\s*(?:static|relative)\s*(?:!important\s*)?$)|z-index\s*:|&#?[a-z0-9]/i;

/** CSS without comments, @import and any declaration matching BAD_CSS; never a `<` (a <style> stays one element). */
export function safeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/</g, '')
    .replace(/@import[^;]*;?/gi, '')
    // An entity's own `;` would split its declaration (leaving half of it, e.g. an open quote): take it out first.
    .replace(/&(#?[a-z0-9]{1,32});/gi, '&$1')
    .replace(/[^;{}]+/g, (decl) => (BAD_CSS.test(decl) ? '' : decl))
    .replace(/(^|[{;])(\s*;)+/g, '$1');
}

const OPTIONS: sanitizeHtml.Options = {
  allowedTags: TAGS,
  allowedAttributes: ATTRIBUTES,
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  // <style> is allowed on purpose: it is filtered by safeCss and only ever rendered inside the sandboxed iframe.
  allowVulnerableTags: true,
  // Text of these is dropped with the tag (a <title> must not show up as the first line). svg / math / template are
  // dropped whole: inside them the parser reads a <style> as markup with its entities decoded, which would come out
  // as live tags (security review I1, 24 Nov 2026). iframe / noembed / noframes hold fallback markup no reader shows.
  nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'xmp', 'svg', 'math', 'template', 'iframe', 'noembed', 'noframes'],
  transformTags: {
    '*': (tagName, attribs) => {
      if (attribs.style !== undefined) attribs.style = safeCss(attribs.style);
      return { tagName, attribs };
    },
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
    // A <style> keeps no attributes, so every one is found and filtered by the pass below (review I2).
    style: () => ({ tagName: 'style', attribs: {} }),
    // Only data:image/*; inline cid: images (embedded attachments) are not fetched yet, so they go rather than show broken.
    img: (tagName, attribs) => {
      const src = (attribs.src ?? '').trim();
      const { src: _drop, ...rest } = attribs;
      return { tagName, attribs: /^data:/i.test(src) && !/^data:image\//i.test(src) ? rest : attribs };
    },
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
};

/**
 * A host that HTML the CRM sends must never point a picture at (security review I1, 24 Nov 2026): the CRM's own
 * (PUBLIC_URL) and anything local (localhost, IP literals). The formatted editor's frame shares the CRM's origin, so
 * such a picture would be a signed-in request to the CRM's API from every colleague who opens the template.
 */
function isOwnOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  let own = '';
  try {
    own = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname.toLowerCase() : '';
  } catch {
    own = '';
  }
  return !!own && (host === own || host.endsWith(`.${own}`));
}

/**
 * A picture source outgoing HTML keeps: data:image/*, or an absolute http(s) address on another host. Relative and
 * protocol-relative addresses (which would resolve against the CRM in the editor, and are broken in sent mail) go.
 */
export function outgoingImageUrl(url: string): boolean {
  const v = url.trim();
  if (/^data:image\//i.test(v)) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !isOwnOrLocalHost(u.hostname);
  } catch {
    return false;
  }
}

const CSS_URL = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** CSS for outgoing HTML (after safeCss): a declaration with a url() outgoingImageUrl refuses goes whole. */
function outgoingCss(css: string): string {
  return css
    .replace(/[^;{}]+/g, (decl) => ([...decl.matchAll(CSS_URL)].every((m) => outgoingImageUrl(m[2] ?? '')) ? decl : ''))
    .replace(/(^|[{;])(\s*;)+/g, '$1');
}

/** A link outgoing HTML keeps: absolute http(s) or mailto (a relative link is broken in sent mail). */
const outgoingHref = (href: string) => /^(https?:\/\/[^/\s]|mailto:)/i.test(href.trim());

const base = OPTIONS.transformTags!;
type Transform = NonNullable<sanitizeHtml.Options['transformTags']>[string];
const run = (t: Transform | undefined, tagName: string, attribs: sanitizeHtml.Attributes) => (t ? t(tagName, attribs) : { tagName, attribs });

/**
 * What the CRM sends (formatted templates and messages, owner 24 Nov 2026): the same rules, with links limited to
 * absolute http, https and mailto, and pictures (img src, CSS url()) to outgoingImageUrl.
 */
const OUTGOING_OPTIONS: sanitizeHtml.Options = {
  ...OPTIONS,
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    ...base,
    '*': (tagName, attribs) => {
      const r = run(base['*'], tagName, attribs);
      if (r.attribs.style !== undefined) r.attribs.style = outgoingCss(r.attribs.style);
      return r;
    },
    a: (tagName, attribs) => {
      const r = run(base.a, tagName, attribs);
      if (r.attribs.href !== undefined && !outgoingHref(r.attribs.href)) {
        const { href: _drop, ...rest } = r.attribs;
        return { tagName: r.tagName, attribs: rest };
      }
      return r;
    },
    img: (tagName, attribs) => {
      const r = run(base.img, tagName, attribs);
      if (r.attribs.src !== undefined && !outgoingImageUrl(r.attribs.src)) {
        const { src: _drop, ...rest } = r.attribs;
        return { tagName: r.tagName, attribs: rest };
      }
      return r;
    },
  },
};

/** `outgoing`: HTML the CRM sends (OUTGOING_OPTIONS) rather than mail it received. */
export interface SanitizeOptions {
  outgoing?: boolean;
}

/**
 * emailBodies options: `deadline` a performance.now() time budget; `whole` (formatted templates and messages) sanitises
 * the whole body and never cuts it to `max` (the caller refuses one that is too long rather than send part of it).
 */
export type BodyOptions = { deadline?: number; whole?: boolean } & SanitizeOptions;

/** Elements open at once, at most: real email stays far below (Outlook tables nest a few dozen deep). */
export const MAX_DEPTH = 256;
/** Elements htmlparser2 closes as soon as it opens them: they get no end tag when written back. */
const VOID = new Set(['area', 'base', 'basefont', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img', 'input', 'isindex', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const attr = (v: string) => v.replace(/"/g, '&quot;');

/** A body whose nesting would take longer to read than its time budget (emailBodies' `deadline`). */
export class BodyTooComplexError extends Error {
  constructor() {
    super('body_too_complex');
    this.name = 'BodyTooComplexError';
  }
}

/**
 * The HTML with elements opened past MAX_DEPTH left out (their text stays), as htmlparser2 reads it — the tokenizer
 * and open-element rules sanitize-html and htmlToText use, so all three agree on the depth (security review N1). It is
 * written back from the parser's events with entities left as they were; comments, doctypes and processing
 * instructions go. The parse itself slows down with the square of the nesting depth (htmlparser2 keeps its open
 * elements in an array it shifts), which is why emailBodies runs in a worker with a time limit (mail/bodies.ts).
 */
export function limitNesting(html: string, maxDepth = MAX_DEPTH, deadline = Infinity): string {
  const out: string[] = [];
  let opened = 0;
  /** Per open element (as the parser opens and closes them, implied closes included): written or left out. */
  const kept: boolean[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        // A time budget, looked at every 512 elements: past it the body is given up (the caller falls back to text).
        if (++opened % 512 === 0 && performance.now() > deadline) throw new BodyTooComplexError();
        const keep = kept.length < maxDepth;
        kept.push(keep);
        if (!keep) return;
        let tag = `<${name}`;
        for (const [k, v] of Object.entries(attribs)) tag += ` ${k}="${attr(v)}"`;
        out.push(`${tag}>`);
      },
      ontext(text) {
        out.push(text);
      },
      onclosetag(name) {
        if (kept.pop() && !VOID.has(name)) out.push(`</${name}>`);
      },
    },
    { decodeEntities: false },
  );
  parser.write(html);
  parser.end();
  return out.join('');
}

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
/** Passes at most: one more than needed in practice, so a parser trick that survives the first pass is caught. */
const MAX_PASSES = 3;

const pass = (html: string, options = OPTIONS) => {
  const css = options === OUTGOING_OPTIONS ? (c: string) => outgoingCss(safeCss(c)) : safeCss;
  return sanitizeHtml(html, options).replace(STYLE_BLOCK, (_m, c: string) => `<style>${css(c)}</style>`);
};

/**
 * Sanitised email HTML: formatting kept; scripts, handlers, forms, frames, meta refresh and unsafe URLs / CSS removed.
 * The output is sanitised again until it no longer changes, so what is stored reads the same to any HTML parser.
 */
export function sanitizeEmailHtml(html: string, opts: SanitizeOptions = {}): string {
  const options = opts.outgoing ? OUTGOING_OPTIONS : OPTIONS;
  let out = pass(limitNesting(html), options);
  for (let i = 1; i < MAX_PASSES; i++) {
    const next = pass(out, options);
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'xml', 'iframe', 'noembed', 'noframes', 'xmp', 'textarea', 'option']);
const BLOCK = new Set([
  'div', 'li', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'center', 'address', 'hr', 'pre',
]);
/** Blocks set apart by an empty line, as a reader sees them. */
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote']);

/**
 * Readable text of an HTML body, for previews and search: no <style>/<script>/<head>, blocks on their own lines,
 * paragraphs and tables set apart, table cells side by side, whitespace collapsed. Read from htmlparser2's events (the
 * sanitiser's tokenizer) after the depth limit; line breaks are counted as they are written, never by searching what
 * was written so far (security review C1).
 */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  /** Line breaks at the end of what was written (spaces and tabs after them do not count; lines are trimmed later). */
  let trailing = 0;
  let written = false;
  let skip = 0;
  let pre = 0;
  const write = (text: string) => {
    if (!text) return;
    let i = text.length - 1;
    let breaks = 0;
    for (; i >= 0; i--) {
      const c = text[i];
      if (c === '\n') breaks += 1;
      else if (c !== ' ' && c !== '\t') break;
    }
    if (i >= 0) {
      trailing = breaks;
      written = true;
    } else trailing += breaks;
    parts.push(text);
  };
  /** At least `n` line breaks at the end so far (blocks next to each other share them). */
  const breaks = (n: number) => {
    if (written && trailing < n) write('\n'.repeat(n - trailing));
  };
  const gap = (name: string) => (PARAGRAPH.has(name) ? 2 : BLOCK.has(name) ? 1 : 0);
  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP.has(name)) skip += 1;
        if (skip) return;
        if (name === 'br') write('\n');
        if (name === 'pre') pre += 1;
        const g = gap(name);
        if (g) breaks(g);
      },
      ontext(text) {
        if (skip) return;
        const plain = text.replace(/\u00a0/g, ' ');
        write(pre ? plain : plain.replace(/\s+/g, ' '));
      },
      onclosetag(name) {
        if (SKIP.has(name)) {
          skip = Math.max(0, skip - 1);
          return;
        }
        if (skip) return;
        if (name === 'pre') pre = Math.max(0, pre - 1);
        const g = gap(name);
        if (g) breaks(g);
        else if (name === 'td' || name === 'th') write(' ');
      },
    },
    { decodeEntities: true },
  );
  parser.write(limitNesting(html));
  parser.end();
  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** How far after an "&" its ";" is looked for. */
const ENTITY_REACH = 10;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** Elements whose content is not text a reader sees. */
const HIDDEN = ['script', 'style', 'head', 'title'];

/**
 * Text of an HTML body without any parser, for when the full processing failed or ran out of time (mail/bodies.ts):
 * one forward pass that drops tags (and the content of script / style / head / title), decodes a few common entities
 * and collapses whitespace, at most `max` characters. No regular expressions over the input, so nothing can backtrack,
 * and every search is either bounded or moves the pass forward to where it stopped (linear in the input).
 */
export function fallbackText(html: string, max: number): string {
  const lower = html.toLowerCase();
  let out = '';
  let space = false;
  const add = (c: string) => {
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f') {
      space = out.length > 0;
      return;
    }
    if (space) out += ' ';
    space = false;
    out += c;
  };
  let i = 0;
  while (i < html.length && out.length < max) {
    const c = html[i]!;
    if (c === '<') {
      const close = html.indexOf('>', i + 1);
      if (close < 0) break;
      const hidden = HIDDEN.find((name) => lower.startsWith(name, i + 1) && !/[a-z0-9]/.test(lower[i + 1 + name.length] ?? ''));
      if (hidden) {
        const end = lower.indexOf(`</${hidden}`, close);
        if (end < 0) break;
        i = lower.indexOf('>', end);
        if (i < 0) break;
        i += 1;
      } else i = close + 1;
      space = out.length > 0;
      continue;
    }
    if (c === '&') {
      // Looks at most ENTITY_REACH characters ahead, by hand: a search to the end of the body for every "&" made a
      // megabyte of them take over a second (final review F1).
      let semi = i + 1;
      while (semi < html.length && semi <= i + ENTITY_REACH && html[semi] !== ';') semi += 1;
      const name = html[semi] === ';' ? lower.slice(i + 1, semi) : '';
      if (name && Object.hasOwn(ENTITIES, name)) {
        add(ENTITIES[name]!);
        i = semi + 1;
        continue;
      }
    }
    add(c);
    i += 1;
  }
  return out.slice(0, max);
}

/** Characters of a raw body read at most (about 1 MB): bounds the time any one email can take (security review C1). */
export const RAW_MAX = 1_000_000;

/** How much of the depth-limited HTML is sanitised, in multiples of the HTML kept (see emailBodies). */
const HTML_WINDOW = 3;

/** A message body as Graph returns it. */
export interface GraphBody {
  contentType: 'html' | 'text';
  content: string;
}

/**
 * What is stored for a body: the sanitised HTML (null for a plain-text one) and the text derived from it, each at most
 * `max` characters. Over-long HTML is cut and sanitised again, so the stored part is still well-formed. Past
 * `deadline` (a performance.now() time) while reading deep nesting it throws BodyTooComplexError.
 */
export function emailBodies(body: GraphBody, max: number, opts: BodyOptions = {}): { bodyHtml: string | null; bodyText: string } {
  const how = { outgoing: opts.outgoing };
  if (body.contentType !== 'html') return { bodyHtml: null, bodyText: body.content.slice(0, max) };
  if (opts.whole) {
    const limited = limitNesting(body.content.slice(0, RAW_MAX), MAX_DEPTH, opts.deadline);
    return { bodyHtml: sanitizeEmailHtml(limited, how), bodyText: htmlToText(limited) };
  }
  // An oversized body is cut before anything reads it: the stored HTML and text are then of its first RAW_MAX
  // characters (the cut is sanitised like the rest, so it stays well-formed).
  const raw = body.content.slice(0, RAW_MAX);
  // The one parse that can take long (deep nesting); sanitising and the text read the limited result.
  const limited = limitNesting(raw, MAX_DEPTH, opts.deadline);
  // At most `max` characters of HTML are kept, and sanitising only ever shortens markup that has lost its comments
  // (limitNesting drops them): three times that is plenty, and sanitising a whole megabyte to keep 50,000 is not.
  const full = sanitizeEmailHtml(limited.slice(0, max * HTML_WINDOW), how);
  let bodyHtml = full;
  // Closing the tags left open by the cut adds a little, so cut a little shorter each time until it fits.
  for (let cut = max; bodyHtml.length > max; cut -= Math.max(200, Math.ceil(max / 20))) {
    bodyHtml = cut > 0 ? sanitizeEmailHtml(full.slice(0, cut), how) : '';
  }
  const bodyText = htmlToText(limited).slice(0, max);
  // Markup that swallows everything after it (an unclosed <iframe>) would leave an empty message: show its text plainly.
  if (!bodyHtml && !bodyText && raw.trim()) return { bodyHtml, bodyText: fallbackText(raw, max) };
  return { bodyHtml, bodyText };
}
