/**
 * Zip guard for .xlsx / .docx (both are zip packages): the central directory's uncompressed sizes are added up before
 * any parser sees the file, so a small file that would inflate to gigabytes is refused without inflating anything.
 * JSZip is only used afterwards, to read the small `docProps/app.xml` of a file that passed.
 */
import JSZip from 'jszip';
import { ReadFailure } from './failure.js';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_HEADER = 0x02014b50;
const MAX32 = 0xffffffff;

/** The file starts like a zip ("PK"). */
export const isZip = (data: Buffer) => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;

function u64(data: Buffer, at: number): number {
  return Number(data.readBigUInt64LE(at));
}

/** Where the central directory starts and how many entries it has; throws `invalid` when the zip is damaged. */
function centralDirectory(data: Buffer): { offset: number; entries: number } {
  const last = data.length - 22;
  const first = Math.max(0, last - 0xffff);
  for (let at = last; at >= first; at -= 1) {
    if (data.readUInt32LE(at) !== EOCD) continue;
    let entries = data.readUInt16LE(at + 10);
    let offset = data.readUInt32LE(at + 16);
    if (entries === 0xffff || offset === MAX32) {
      const loc = at - 20;
      if (loc < 0 || data.readUInt32LE(loc) !== ZIP64_LOCATOR) throw new ReadFailure('invalid');
      const z = u64(data, loc + 8);
      if (z + 56 > data.length || data.readUInt32LE(z) !== ZIP64_EOCD) throw new ReadFailure('invalid');
      entries = u64(data, z + 32);
      offset = u64(data, z + 48);
    }
    return { offset, entries };
  }
  throw new ReadFailure('invalid');
}

/** One central-directory entry's uncompressed size (ZIP64 extra field when the 32-bit value is saturated). */
function entrySize(data: Buffer, at: number, extraStart: number, extraLength: number): number {
  const size = data.readUInt32LE(at + 24);
  if (size !== MAX32) return size;
  for (let p = extraStart; p + 4 <= extraStart + extraLength;) {
    const id = data.readUInt16LE(p);
    const len = data.readUInt16LE(p + 2);
    if (id === 0x0001 && len >= 8) return u64(data, p + 4);
    p += 4 + len;
  }
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Refuses a zip whose entries add up to more than `maxBytes` uncompressed (`This file is too large to read`), read
 * from the central directory only. A damaged zip is refused as not valid.
 */
export async function assertZipSize(data: Buffer, maxBytes = 200 * 1024 * 1024): Promise<void> {
  if (!isZip(data) || data.length < 22) throw new ReadFailure('invalid');
  const { offset, entries } = centralDirectory(data);
  let at = offset;
  let total = 0;
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL_HEADER) throw new ReadFailure('invalid');
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    total += entrySize(data, at, at + 46 + nameLength, extraLength);
    if (total > maxBytes) throw new ReadFailure('too_large');
    at += 46 + nameLength + extraLength + commentLength;
  }
}

/** `<Pages>` from a .docx's `docProps/app.xml`, when the file has it. */
export async function docxPageCount(data: Buffer): Promise<number | undefined> {
  const zip = await JSZip.loadAsync(data);
  const app = zip.file('docProps/app.xml');
  if (!app) return undefined;
  const match = /<(?:\w+:)?Pages>\s*(\d+)\s*</.exec(await app.async('string'));
  return match ? Number(match[1]) : undefined;
}
