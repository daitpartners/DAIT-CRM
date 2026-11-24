import { escapeHtml } from '@dait-crm/shared';

/**
 * Helpers for the formatted message editor (components/MessageEditor.tsx). The server is what makes a formatted body
 * safe (it sanitises every template and message with the email reader's sanitiser); these keep the editor itself from
 * taking in anything active: pasted content is rebuilt from a short list of formatting tags, and links are only ever
 * http, https or mailto.
 */

/** Plain text as editor HTML: escaped, blank lines between paragraphs, single line breaks kept. */
export function textToEditorHtml(text: string): string {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>') || '<br>'}</p>`).join('');
}

/**
 * A link address the editor accepts: http(s) or mailto only. "www.x.com" gets https://, a bare email address mailto:;
 * anything else (javascript:, data:, a relative path…) is null.
 */
export function safeLinkUrl(input: string): string | null {
  const v = input.trim();
  if (!v || /\s/.test(v)) return null;
  const withScheme = /^www\./i.test(v) ? `https://${v}` : /^[^@:/]+@[^@:/]+\.[^@:/]+$/.test(v) ? `mailto:${v}` : v;
  try {
    const url = new URL(withScheme);
    if (url.protocol === 'mailto:') return /^mailto:[^@\s]+@[^@\s]+$/i.test(withScheme) ? withScheme : null;
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return url.href;
  } catch {
    return null;
  }
  return null;
}

/** Tags a paste keeps (anything else is unwrapped to its text); no attributes but a checked href. */
const PASTE_TAGS: Record<string, string> = {
  b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', p: 'p', div: 'div', br: 'br', ul: 'ul', ol: 'ol', li: 'li', a: 'a',
  h1: 'p', h2: 'p', h3: 'p', h4: 'p', h5: 'p', h6: 'p', blockquote: 'blockquote',
};
/** Elements whose content is not text a reader sees: dropped whole. */
const PASTE_DROP = new Set([
  'script', 'style', 'head', 'title', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'noscript', 'textarea', 'select', 'button', 'input', 'meta', 'link',
]);

/**
 * Pasted HTML rebuilt from scratch: the clipboard markup is read in an inert document (DOMParser runs no scripts and
 * loads nothing) and only text plus PASTE_TAGS are copied into new elements, with no attributes except a link's
 * safeLinkUrl href. Nothing from the clipboard is ever inserted as written.
 */
export function cleanPastedHtml(html: string): string {
  const src = new DOMParser().parseFromString(html, 'text/html');
  const out = document.implementation.createHTMLDocument('');
  const root = out.createElement('div');
  const copy = (from: Node, to: Node) => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(out.createTextNode(node.textContent ?? ''));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = (node as Element).tagName.toLowerCase();
      if (PASTE_DROP.has(tag)) continue;
      const keep = PASTE_TAGS[tag];
      if (!keep) {
        copy(node, to);
        continue;
      }
      const el = out.createElement(keep);
      if (keep === 'a') {
        const href = safeLinkUrl((node as Element).getAttribute('href') ?? '');
        if (!href) {
          copy(node, to);
          continue;
        }
        el.setAttribute('href', href);
      }
      to.appendChild(el);
      if (keep !== 'br') copy(node, el);
    }
  };
  copy(src.body, root);
  return root.innerHTML;
}

const BLOCKS = new Set(['p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre']);
const HIDDEN = new Set(['style', 'script', 'head', 'title', 'template']);

/**
 * The editor's text (what is checked for "Enter a message" and sent as the message's plain text; the server derives
 * its own from the sanitised HTML too): blocks on their own lines, list items marked, whitespace collapsed.
 */
export function editorText(root: Node): string {
  let out = '';
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child.textContent ?? '').replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = (child as Element).tagName.toLowerCase();
      if (HIDDEN.has(tag)) continue;
      if (tag === 'br') {
        out += '\n';
        continue;
      }
      const block = BLOCKS.has(tag);
      if (block && out && !out.endsWith('\n')) out += '\n';
      if (tag === 'li') out += '- ';
      walk(child);
      if (block && !out.endsWith('\n')) out += '\n';
    }
  };
  walk(root);
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
