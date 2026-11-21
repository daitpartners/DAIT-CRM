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

  /** A minimal OLE2 header (512-byte sectors) plus `sectors` extra sectors, with fields set by `fill`. */
  function crafted(sectors: number, fill: (dv: DataView) => void): ArrayBuffer {
    const buf = new ArrayBuffer(512 * (sectors + 1));
    const dv = new DataView(buf);
    dv.setUint32(0, 0xe011cfd0, true);
    dv.setUint32(4, 0xe11ab1a1, true);
    dv.setUint16(30, 9, true); // 512-byte sectors
    dv.setUint16(32, 6, true); // 64-byte mini sectors
    dv.setUint32(56, 4096, true); // mini stream cutoff
    dv.setUint32(60, 0xfffffffe, true); // no mini FAT
    for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, 0xffffffff, true);
    fill(dv);
    return buf;
  }
  const finishesFast = (buf: ArrayBuffer) => {
    const start = Date.now();
    try {
      parseOft(buf);
    } catch {
      /* refusing the file is fine; hanging is not */
    }
    expect(Date.now() - start).toBeLessThan(200);
  };

  it('a DIFAT sector that points to itself does not hang', () => {
    finishesFast(crafted(3, (dv) => {
      dv.setUint32(44, 1, true); // one FAT sector...
      dv.setUint32(76, 1, true); // ...at sector 1
      dv.setUint32(48, 0, true); // directory at sector 0
      dv.setUint32(68, 2, true); // DIFAT starts at sector 2
      dv.setUint32(72, 0xffffffff, true); // and claims 4 billion DIFAT sectors
      dv.setUint32(512 * 3 + 508, 2, true); // sector 2's "next DIFAT" points back to itself
    }));
  });

  it('a directory chain that loops on itself does not hang or allocate gigabytes', () => {
    finishesFast(crafted(2, (dv) => {
      dv.setUint32(44, 1, true);
      dv.setUint32(76, 1, true); // FAT at sector 1
      dv.setUint32(48, 0, true); // directory at sector 0
      dv.setUint32(68, 0xfffffffe, true);
      dv.setUint32(512 * 2 + 0, 0, true); // FAT[0] = 0: the directory's next sector is itself
    }));
  });

  it('refuses a header with an impossible sector size', () => {
    const bad = crafted(1, (dv) => dv.setUint16(30, 40, true));
    expect(() => parseOft(bad)).toThrow('Not an Outlook template (.oft/.msg) file');
  });
});
