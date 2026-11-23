/** .txt → the whole text, one page, split into records line by line later (Task 4). */
import { decodeText, type ReadResult } from './index.js';

export async function readText(data: Buffer): Promise<ReadResult> {
  const text = decodeText(data).replace(/\r\n?/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim() !== '').length;
  const textFound = /\S/.test(text);
  return { status: 'Read', meta: { lines, textFound }, extract: { kind: 'text', unit: 'line', pages: [{ n: 1, text }] } };
}
