import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOft } from '../src/lib/oft';

const sample = (): ArrayBuffer => {
  // Tests run from apps/web; jsdom gives import.meta.url an http scheme, so resolve from the working directory.
  const b = readFileSync(resolve(process.cwd(), '../../docs/sample-template.oft'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
};

describe('parseOft (port of prototype/js/oft.js)', () => {
  it('reads subject and plain-text body from an Outlook template', () => {
    const r = parseOft(sample());
    expect(r.subject).toBe('Quotation {quote_no} from DAIT Partners');
    expect(r.body).toBe('Hi {first_name},\n\nPlease find attached quotation {quote_no} for {company}, valid for 30 days.\n\nBest regards,\n{me}');
    expect(r.html.length).toBeGreaterThan(0);
  });

  it('refuses a file that is not an Outlook template', () => {
    const notOle = new TextEncoder().encode('just some text, definitely not OLE2').buffer as ArrayBuffer;
    expect(() => parseOft(notOle)).toThrow('Not an Outlook template (.oft/.msg) file');
  });
});
