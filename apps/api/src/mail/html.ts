import sanitizeHtml from 'sanitize-html';
import { parse, NodeType, type HTMLElement, type Node } from 'node-html-parser';

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
 * reading pane (position fixed / sticky: a fake "sign in again" panel; Outlook strips positioning too). An HTML entity
 * is never CSS, only an attempt to smuggle markup.
 */
const BAD_CSS =
  /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|\\|url\s*\(\s*(?!['"]?\s*(?:https?:|data:image\/))|position\s*:\s*(?:-webkit-)?(?:fixed|sticky)|&(?:lt|gt|#)/i;

/** CSS without comments, @import and any declaration matching BAD_CSS; never a `<` (a <style> stays one element). */
export function safeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/</g, '')
    .replace(/@import[^;]*;?/gi, '')
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
  // as live tags (security review I1, 24 Nov 2026).
  nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'xmp', 'svg', 'math', 'template'],
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

/** Elements open at once, at most: real email stays far below (Outlook tables nest a few dozen deep). */
export const MAX_DEPTH = 256;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
/** Elements whose end tag may be left out: a new one (or, for cells, a new row) closes the open one, as browsers do. */
const IMPLIED: Record<string, string[]> = {
  p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'],
  td: ['td', 'th'], th: ['td', 'th'], tr: ['tr', 'td', 'th'], tbody: ['tbody', 'thead', 'tr', 'td', 'th'],
  thead: ['tbody', 'thead', 'tr', 'td', 'th'], tfoot: ['tbody', 'thead', 'tr', 'td', 'th'],
};
/** How far down the open elements an implied close looks (enough for a cell inside a few inline tags). */
const IMPLIED_REACH = 8;
/** An implied close never reaches past these (a cell of a nested table does not close the outer one). */
const SCOPE = new Set(['table', 'ul', 'ol', 'dl', 'select', 'div', 'blockquote']);

/**
 * The HTML with opening tags past MAX_DEPTH nested elements left out (their text stays). The HTML parsers here slow
 * down with the square of the nesting depth, so a body of 200,000 unclosed <div>s would block for many seconds
 * (security review C1). One forward pass: tags are found by hand (quoted attribute values and comments skipped, raw
 * text such as <style> stepped over), the open elements kept on a bounded stack.
 */
export function limitNesting(html: string, maxDepth = MAX_DEPTH): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  const stack: string[] = [];
  let last = 0;
  let i = 0;
  while ((i = html.indexOf('<', i)) !== -1) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    let j = i + 1;
    const closing = html[j] === '/';
    if (closing) j += 1;
    const nameStart = j;
    while (j < html.length && /[a-zA-Z0-9:-]/.test(html[j]!)) j += 1;
    if (j === nameStart || !/[a-zA-Z]/.test(html[nameStart]!)) {
      i += 1;
      continue;
    }
    const name = lower.slice(nameStart, j);
    let k = j;
    let quote = '';
    for (; k < html.length; k++) {
      const c = html[k];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (k >= html.length) break;
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
    } else if (!VOID.has(name) && html[k - 1] !== '/') {
      const closes = IMPLIED[name];
      if (closes) {
        let cut = -1;
        for (let d = stack.length - 1; d >= Math.max(0, stack.length - IMPLIED_REACH); d--) {
          if (closes.includes(stack[d]!)) cut = d;
          else if (SCOPE.has(stack[d]!)) break;
        }
        if (cut >= 0) stack.length = cut;
      }
      if (stack.length >= maxDepth) {
        parts.push(html.slice(last, i));
        last = k + 1;
      } else stack.push(name);
      if (RAW_TEXT.has(name)) {
        const end = lower.indexOf(`</${name}`, k + 1);
        if (end < 0) break;
        if (stack.at(-1) === name) stack.pop();
        i = end;
        continue;
      }
    }
    i = k + 1;
  }
  parts.push(html.slice(last));
  return parts.join('');
}

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
/** Passes at most: one more than needed in practice, so a parser trick that survives the first pass is caught. */
const MAX_PASSES = 3;

const pass = (html: string) => sanitizeHtml(html, OPTIONS).replace(STYLE_BLOCK, (_m, css: string) => `<style>${safeCss(css)}</style>`);

/**
 * Sanitised email HTML: formatting kept; scripts, handlers, forms, frames, meta refresh and unsafe URLs / CSS removed.
 * The output is sanitised again until it no longer changes, so what is stored reads the same to any HTML parser.
 */
export function sanitizeEmailHtml(html: string): string {
  let out = pass(limitNesting(html));
  for (let i = 1; i < MAX_PASSES; i++) {
    const next = pass(out);
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'xml']);
const BLOCK = new Set([
  'div', 'li', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'center', 'address', 'hr', 'pre',
]);
/** Blocks set apart by an empty line, as a reader sees them. */
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote']);

/**
 * Readable text of an HTML body, for previews and search: no <style>/<script>/<head>, blocks on their own lines,
 * paragraphs and tables set apart, table cells side by side, whitespace collapsed. Linear in the input: the tree is
 * walked with an explicit stack (no recursion depth limit) and line breaks are counted as they are written, never by
 * searching what was written so far (security review C1).
 */
export function htmlToText(html: string): string {
  const root = parse(limitNesting(html), { blockTextElements: { script: false, style: false, noscript: false, pre: true }, comment: false });
  const parts: string[] = [];
  /** Line breaks at the end of what was written (spaces and tabs after them do not count; lines are trimmed later). */
  let trailing = 0;
  let written = false;
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
  type Step = { node: Node; pre: boolean } | { close: number; cell: boolean };
  const stack: Step[] = [{ node: root, pre: false }];
  while (stack.length) {
    const step = stack.pop()!;
    if ('close' in step) {
      if (step.close) breaks(step.close);
      else if (step.cell) write(' ');
      continue;
    }
    const { node, pre } = step;
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = node.text.replace(/\u00a0/g, ' ');
      write(pre ? text : text.replace(/\s+/g, ' '));
      continue;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) continue;
    const tag = (node as HTMLElement).rawTagName?.toLowerCase() ?? '';
    if (SKIP.has(tag)) continue;
    if (tag === 'br') {
      write('\n');
      continue;
    }
    const gap = PARAGRAPH.has(tag) ? 2 : BLOCK.has(tag) ? 1 : 0;
    if (gap) breaks(gap);
    stack.push({ close: gap, cell: tag === 'td' || tag === 'th' });
    const inPre = pre || tag === 'pre';
    for (let c = node.childNodes.length - 1; c >= 0; c--) stack.push({ node: node.childNodes[c]!, pre: inPre });
  }
  return parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Characters of a raw body read at most (about 1 MB): bounds the time any one email can take (security review C1). */
export const RAW_MAX = 1_000_000;

/** A message body as Graph returns it. */
export interface GraphBody {
  contentType: 'html' | 'text';
  content: string;
}

/**
 * What is stored for a body: the sanitised HTML (null for a plain-text one) and the text derived from it, each at most
 * `max` characters. Over-long HTML is cut and sanitised again, so the stored part is still well-formed.
 */
export function emailBodies(body: GraphBody, max: number): { bodyHtml: string | null; bodyText: string } {
  if (body.contentType !== 'html') return { bodyHtml: null, bodyText: body.content.slice(0, max) };
  // An oversized body is cut before anything reads it: the stored HTML and text are then of its first RAW_MAX
  // characters (the cut is sanitised like the rest, so it stays well-formed).
  const raw = body.content.slice(0, RAW_MAX);
  const full = sanitizeEmailHtml(raw);
  let bodyHtml = full;
  // Closing the tags left open by the cut adds a little, so cut a little shorter each time until it fits.
  for (let cut = max; bodyHtml.length > max; cut -= Math.max(200, Math.ceil(max / 20))) {
    bodyHtml = cut > 0 ? sanitizeEmailHtml(full.slice(0, cut)) : '';
  }
  return { bodyHtml, bodyText: htmlToText(raw).slice(0, max) };
}
