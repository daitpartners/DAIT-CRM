/** .docx → its raw text as one page (Task 4 splits it into cards); the page count comes from docProps/app.xml. */
import mammoth from 'mammoth';
import type { ReadResult } from './index.js';
import { ReadFailure, isEncryptedPackage, isOle } from './failure.js';
import { assertZipSize, docxPageCount, isZip } from './zip.js';

export async function readDocx(data: Buffer): Promise<ReadResult> {
  try {
    if (isEncryptedPackage(data)) throw new ReadFailure('password');
    if (isOle(data)) throw new ReadFailure('old_doc');
    if (!isZip(data)) throw new ReadFailure('invalid');
    await assertZipSize(data);
    let text: string;
    let pages: number | undefined;
    try {
      pages = await docxPageCount(data);
      text = (await mammoth.extractRawText({ buffer: data })).value;
    } catch {
      throw new ReadFailure('invalid');
    }
    text = text.replace(/\r\n?/g, '\n');
    return {
      status: 'Read',
      meta: { ...(pages !== undefined ? { pages } : {}), textFound: /\S/.test(text) },
      extract: { kind: 'text', unit: 'card', pages: [{ n: 1, text }] },
    };
  } catch (e) {
    if (e instanceof ReadFailure) return { status: 'Failed', meta: {}, error: e.text('docx') };
    throw e;
  }
}
