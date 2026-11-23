/**
 * .pdf → the text of each page (pdf.js, Node legacy build). pdf.js 6 has no eval / `new Function` code path left
 * (the `isEvalSupported` option of earlier versions is gone), so there is nothing to switch off. A PDF with almost no
 * text (fewer than 20 non-space characters a page) is a scan: not read, since there is no OCR. More than 2,000 pages is
 * refused before any page is read. CMaps and standard fonts come from the installed package (local files, no network),
 * so CJK / CID-font text is extracted instead of looking like a scan.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadResult } from './index.js';
import { MAX_TEXT_CHARS, ReadFailure, assertTextSize } from './failure.js';

/** Text below this many non-space characters per page means the pages are images. */
const MIN_CHARS_PER_PAGE = 20;
/** Pages a PDF may have (an exhibitor list is far shorter; a page tree can be made to repeat one page endlessly). */
export const PDF_MAX_PAGES = 2000;

const PDFJS_DIR = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
/** pdf.js wants folder URLs with a trailing slash; in Node it reads them with fs. */
const CMAP_DIR = `${path.join(PDFJS_DIR, 'cmaps')}${path.sep}`;
const STANDARD_FONT_DIR = `${path.join(PDFJS_DIR, 'standard_fonts')}${path.sep}`;

/** "%PDF" within the first KB (the format allows a little junk before it). */
const isPdf = (data: Buffer) => data.subarray(0, 1024).includes('%PDF');

async function pageText(doc: PDFDocumentProxy, n: number): Promise<string> {
  const page = await doc.getPage(n);
  try {
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      if (item.hasEOL) text += '\n';
    }
    return text.replace(/[ \t]+\n/g, '\n').trimEnd();
  } finally {
    page.cleanup();
  }
}

export async function readPdf(data: Buffer): Promise<ReadResult> {
  try {
    if (!isPdf(data)) throw new ReadFailure('invalid');
    const task = getDocument({
      data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0,
      cMapUrl: CMAP_DIR, cMapPacked: true, standardFontDataUrl: STANDARD_FONT_DIR,
    });
    try {
      let doc: PDFDocumentProxy;
      try {
        doc = await task.promise;
      } catch (e) {
        throw new ReadFailure(e instanceof Error && e.name === 'PasswordException' ? 'password' : 'invalid');
      }
      if (doc.numPages > PDF_MAX_PAGES) throw new ReadFailure('too_large');
      const pages: { n: number; text: string }[] = [];
      let length = 0;
      for (let n = 1; n <= doc.numPages; n += 1) {
        const text = await pageText(doc, n);
        length += text.length;
        assertTextSize(length, MAX_TEXT_CHARS);
        pages.push({ n, text });
      }
      const chars = pages.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0);
      const textFound = chars > 0 && chars >= MIN_CHARS_PER_PAGE * doc.numPages;
      const meta = { pages: doc.numPages, textFound };
      if (!textFound) return { status: 'Scan', meta };
      return { status: 'Read', meta, extract: { kind: 'text', unit: 'page', pages } };
    } finally {
      await task.destroy();
    }
  } catch (e) {
    if (e instanceof ReadFailure) return { status: 'Failed', meta: {}, error: e.code };
    throw e;
  }
}
