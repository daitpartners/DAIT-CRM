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

/** A CSS declaration (or rule text) that could run code or fetch from somewhere other than the web. */
const BAD_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|\\|url\s*\(\s*(?!['"]?\s*(?:https?:|data:image\/))/i;

/** CSS without comments, @import and any declaration matching BAD_CSS; never a `<` (a <style> stays one element). */
export function safeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/</g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/[^;{}]+/g, (decl) => (BAD_CSS.test(decl) ? '' : decl));
}

const OPTIONS: sanitizeHtml.Options = {
  allowedTags: TAGS,
  allowedAttributes: ATTRIBUTES,
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  // <style> is allowed on purpose: it is filtered by safeCss and only ever rendered inside the sandboxed iframe.
  allowVulnerableTags: true,
  // Text of these is dropped with the tag (a <title> must not show up as the first line).
  nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'xmp'],
  transformTags: {
    '*': (tagName, attribs) => {
      if (attribs.style !== undefined) attribs.style = safeCss(attribs.style);
      return { tagName, attribs };
    },
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
    // Only data:image/*; inline cid: images (embedded attachments) are not fetched yet, so they go rather than show broken.
    img: (tagName, attribs) => {
      const src = (attribs.src ?? '').trim();
      const { src: _drop, ...rest } = attribs;
      return { tagName, attribs: /^data:/i.test(src) && !/^data:image\//i.test(src) ? rest : attribs };
    },
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
};

/** Sanitised email HTML: formatting kept; scripts, handlers, forms, frames, meta refresh and unsafe URLs / CSS removed. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS)
    .replace(/<style>([\s\S]*?)<\/style>/gi, (_m, css: string) => `<style>${safeCss(css)}</style>`)
    .trim();
}

const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'xml']);
const BLOCK = new Set([
  'div', 'li', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'center', 'address', 'hr', 'pre',
]);
/** Blocks set apart by an empty line, as a reader sees them. */
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote']);

/**
 * Readable text of an HTML body, for previews and search: no <style>/<script>/<head>, blocks on their own lines,
 * paragraphs and tables set apart, table cells side by side, whitespace collapsed.
 */
export function htmlToText(html: string): string {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true }, comment: false });
  let out = '';
  /** At least `n` line breaks at the end so far (blocks next to each other share them). */
  const breaks = (n: number) => {
    out = out.replace(/[ \t]+$/, '');
    const have = /\n*$/.exec(out)![0].length;
    if (out && have < n) out += '\n'.repeat(n - have);
  };
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = node.text.replace(/ /g, ' ');
      out += pre ? text : text.replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const tag = (node as HTMLElement).rawTagName?.toLowerCase() ?? '';
    if (SKIP.has(tag)) return;
    if (tag === 'br') {
      out += '\n';
      return;
    }
    const gap = PARAGRAPH.has(tag) ? 2 : BLOCK.has(tag) ? 1 : 0;
    if (gap) breaks(gap);
    for (const child of node.childNodes) walk(child, pre || tag === 'pre');
    if (gap) breaks(gap);
    else if (tag === 'td' || tag === 'th') out += ' ';
  };
  walk(root, false);
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
  const full = sanitizeEmailHtml(body.content);
  let bodyHtml = full;
  // Closing the tags left open by the cut adds a little, so cut a little shorter each time until it fits.
  for (let cut = max; bodyHtml.length > max; cut -= Math.max(200, Math.ceil(max / 20))) {
    bodyHtml = cut > 0 ? sanitizeEmailHtml(full.slice(0, cut)) : '';
  }
  return { bodyHtml, bodyText: htmlToText(body.content).slice(0, max) };
}
