/**
 * .pdf → the text of each page (pdf.js, Node legacy build). pdf.js 6 has no eval / `new Function` code path left
 * (the `isEvalSupported` option of earlier versions is gone), so there is nothing to switch off. A PDF with almost no
 * text (fewer than 20 non-space characters a page) is a scan: not read, since there is no OCR.
 */
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadResult } from './index.js';
import { ReadFailure } from './failure.js';

/** Text below this many non-space characters per page means the pages are images. */
const MIN_CHARS_PER_PAGE = 20;

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
    });
    try {
      let doc: PDFDocumentProxy;
      try {
        doc = await task.promise;
      } catch (e) {
        throw new ReadFailure(e instanceof Error && e.name === 'PasswordException' ? 'password' : 'invalid');
      }
      const pages: { n: number; text: string }[] = [];
      for (let n = 1; n <= doc.numPages; n += 1) pages.push({ n, text: await pageText(doc, n) });
      const chars = pages.reduce((sum, p) => sum + p.text.replace(/\s/g, '').length, 0);
      const textFound = chars > 0 && chars >= MIN_CHARS_PER_PAGE * doc.numPages;
      const meta = { pages: doc.numPages, textFound };
      if (!textFound) return { status: 'Scan', meta };
      return { status: 'Read', meta, extract: { kind: 'text', unit: 'page', pages } };
    } finally {
      await task.destroy();
    }
  } catch (e) {
    if (e instanceof ReadFailure) return { status: 'Failed', meta: {}, error: e.text('pdf') };
    throw e;
  }
}
