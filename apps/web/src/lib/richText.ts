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

/** Font sizes the mail toolbar offers, in points. */
export type MailFontSize = 11 | 12 | 14;

/**
 * The mail toolbar's Size: the browser's `fontSize` command only knows the HTML sizes 1–7, so the selection is set to
 * 7 and every element that produced (`<font size="7">`, or a span styled `xxx-large` where the browser writes CSS)
 * becomes the chosen size in points, as Outlook writes it.
 */
export function applyFontSize(doc: Document, pt: MailFontSize): void {
  doc.execCommand?.('styleWithCSS', false, 'false');
  doc.execCommand?.('fontSize', false, '7');
  const sized: Element[] = [];
  for (const font of Array.from(doc.body.querySelectorAll('font[size="7"]'))) {
    const span = doc.createElement('span');
    span.setAttribute('style', `font-size:${pt}pt`);
    while (font.firstChild) span.appendChild(font.firstChild);
    font.replaceWith(span);
    sized.push(span);
  }
  for (const span of Array.from(doc.body.querySelectorAll<HTMLElement>('span[style]'))) {
    if (/xxx-large/.test(span.style.fontSize)) {
      span.style.fontSize = `${pt}pt`;
      sized.push(span);
    }
  }
  // The replaced elements took the selection with them: the resized text is selected again, for the next command.
  const sel = doc.getSelection?.();
  if (!sel || sized.length === 0) return;
  sized.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const range = doc.createRange();
  range.setStartBefore(sized[0]);
  range.setEndAfter(sized[sized.length - 1]);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** HTML parsed inert (a template element runs nothing and loads no pictures), changed by `edit`, and written back. */
function rewrite(html: string, edit: (root: DocumentFragment) => void): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  edit(tpl.content);
  return tpl.innerHTML;
}

/**
 * The editor's HTML as it is sent: a picture inserted in the editor shows from its data (`<img data-cid="x"
 * src="data:…">`) and is sent as the draft's inline picture it was uploaded as (`<img src="cid:x">`).
 */
export function toSendHtml(html: string): string {
  if (!html.includes('data-cid')) return html;
  return rewrite(html, (root) => {
    for (const img of Array.from(root.querySelectorAll('img[data-cid]'))) {
      if (!/^data:/i.test(img.getAttribute('src') ?? '')) continue;
      const cid = img.getAttribute('data-cid') ?? '';
      img.removeAttribute('data-cid');
      img.setAttribute('src', `cid:${cid}`);
    }
  });
}

/** A draft's HTML opened in the editor: each `cid:` picture of one of the draft's files shows from that file's data. */
export function toEditorHtml(html: string, files: { contentId: string | null; dataUrl: string | null }[]): string {
  const data = new Map<string, string>();
  for (const f of files) if (f.contentId && f.dataUrl && /^data:image\//i.test(f.dataUrl)) data.set(f.contentId, f.dataUrl);
  if (data.size === 0 || !/cid:/i.test(html)) return html;
  return rewrite(html, (root) => {
    for (const img of Array.from(root.querySelectorAll('img[src]'))) {
      const m = /^cid:(.+)$/i.exec(img.getAttribute('src') ?? '');
      const url = m ? data.get(m[1]) : undefined;
      if (!m || !url) continue;
      img.setAttribute('src', url);
      img.setAttribute('data-cid', m[1]);
    }
  });
}
