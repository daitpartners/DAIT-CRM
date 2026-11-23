/**
 * Zip guard for .xlsx / .docx (both are zip packages), run before any parser sees the file:
 * 1. The central directory must be exactly what the end record says: walking the counted entries has to end where the
 *    directory ends (and the end record begins), so a lying entry count cannot hide an entry that JSZip would still read.
 * 2. Every entry is inflated here, capped at its declared size + 1 byte, and the declared sizes must add up to at most
 *    the budget, so a lying size is caught after at most one byte too many instead of after gigabytes.
 * Only then do SheetJS / mammoth parse the file; they read the same (now verified) entries.
 */
import { inflateRawSync } from 'node:zlib';
import { ReadFailure } from './failure.js';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

/** Uncompressed bytes a whole .xlsx / .docx may hold. */
export const ZIP_MAX_BYTES = 200 * 1024 * 1024;

/** The file starts like a zip ("PK"). */
export const isZip = (data: Buffer) => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;

const invalid = () => new ReadFailure('invalid');

function u16(data: Buffer, at: number): number {
  if (at < 0 || at + 2 > data.length) throw invalid();
  return data.readUInt16LE(at);
}

function u32(data: Buffer, at: number): number {
  if (at < 0 || at + 4 > data.length) throw invalid();
  return data.readUInt32LE(at);
}

function u64(data: Buffer, at: number): number {
  if (at < 0 || at + 8 > data.length) throw invalid();
  const v = data.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(v);
}

type Directory = { offset: number; size: number; entries: number; end: number };

/** The central directory as the end record describes it; `end` is where the directory must stop. */
function centralDirectory(data: Buffer): Directory {
  const last = data.length - 22;
  const first = Math.max(0, last - MAX16);
  for (let at = last; at >= first; at -= 1) {
    if (data.readUInt32LE(at) !== EOCD) continue;
    let entries = u16(data, at + 10);
    let size = u32(data, at + 12);
    let offset = u32(data, at + 16);
    let end = at;
    if (entries === MAX16 || size === MAX32 || offset === MAX32) {
      const loc = at - 20;
      if (u32(data, loc) !== ZIP64_LOCATOR) throw invalid();
      const z = u64(data, loc + 8);
      if (u32(data, z) !== ZIP64_EOCD) throw invalid();
      entries = u64(data, z + 32);
      size = u64(data, z + 40);
      offset = u64(data, z + 48);
      end = z;
    }
    if (offset + size !== end) throw invalid();
    return { offset, size, entries, end };
  }
  throw invalid();
}

type Entry = { name: string; method: number; flags: number; compressed: number; size: number; localOffset: number };

/** The ZIP64 extra field's values for whichever 32-bit fields are saturated (in the spec's order). */
function zip64Values(data: Buffer, start: number, length: number, need: { size: boolean; compressed: boolean; offset: boolean }) {
  const end = start + length;
  for (let p = start; p + 4 <= end;) {
    const id = u16(data, p);
    const len = u16(data, p + 2);
    if (p + 4 + len > end) throw invalid();
    if (id === 0x0001) {
      let q = p + 4;
      const take = () => {
        if (q + 8 > p + 4 + len) throw invalid();
        const v = u64(data, q);
        q += 8;
        return v;
      };
      return {
        size: need.size ? take() : undefined,
        compressed: need.compressed ? take() : undefined,
        offset: need.offset ? take() : undefined,
      };
    }
    p += 4 + len;
  }
  throw invalid();
}

/** Every entry of the central directory; refuses a directory whose counted entries do not end exactly at its end. */
function readEntries(data: Buffer): Entry[] {
  const dir = centralDirectory(data);
  const entries: Entry[] = [];
  let at = dir.offset;
  for (let i = 0; i < dir.entries; i += 1) {
    if (u32(data, at) !== CENTRAL_HEADER) throw invalid();
    const flags = u16(data, at + 8);
    const method = u16(data, at + 10);
    let compressed = u32(data, at + 20);
    let size = u32(data, at + 24);
    const nameLength = u16(data, at + 28);
    const extraLength = u16(data, at + 30);
    const commentLength = u16(data, at + 32);
    let localOffset = u32(data, at + 42);
    const nameStart = at + 46;
    if (nameStart + nameLength + extraLength + commentLength > dir.end) throw invalid();
    const need = { size: size === MAX32, compressed: compressed === MAX32, offset: localOffset === MAX32 };
    if (need.size || need.compressed || need.offset) {
      const z = zip64Values(data, nameStart + nameLength, extraLength, need);
      size = z.size ?? size;
      compressed = z.compressed ?? compressed;
      localOffset = z.offset ?? localOffset;
    }
    entries.push({ name: data.toString('utf8', nameStart, nameStart + nameLength), method, flags, compressed, size, localOffset });
    at = nameStart + nameLength + extraLength + commentLength;
  }
  // A lying count (fewer than the directory holds) or junk after the last entry: refused.
  if (at !== dir.end) throw invalid();
  return entries;
}

/** An entry's bytes, inflated with a cap one byte above its declared size; more than declared = too large. */
function inflateEntry(data: Buffer, e: Entry): Buffer {
  if (e.flags & 0x1) throw new ReadFailure('password');
  const at = e.localOffset;
  if (u32(data, at) !== LOCAL_HEADER) throw invalid();
  const start = at + 30 + u16(data, at + 26) + u16(data, at + 28);
  if (start + e.compressed > data.length) throw invalid();
  const raw = data.subarray(start, start + e.compressed);
  let out: Buffer;
  if (e.method === 0) {
    out = raw;
  } else if (e.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: e.size + 1 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ReadFailure('too_large');
      throw invalid();
    }
  } else {
    throw invalid();
  }
  if (out.length > e.size) throw new ReadFailure('too_large');
  if (out.length !== e.size) throw invalid();
  return out;
}

/**
 * Refuses a zip that is damaged or lies about itself (`invalid`), or holds more than `maxBytes` uncompressed or more in
 * any entry than it declares (`too_large`). Every entry is inflated with a cap, one at a time, and discarded.
 */
export async function assertZipSize(data: Buffer, maxBytes = ZIP_MAX_BYTES): Promise<void> {
  if (!isZip(data) || data.length < 22) throw invalid();
  const entries = readEntries(data);
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (total > maxBytes) throw new ReadFailure('too_large');
  }
  for (const e of entries) inflateEntry(data, e);
}

/** One entry's bytes through the same capped path, or undefined when the zip has no such entry. */
export function zipEntry(data: Buffer, name: string, maxBytes = ZIP_MAX_BYTES): Buffer | undefined {
  const entry = readEntries(data).find((e) => e.name === name);
  if (!entry) return undefined;
  if (entry.size > maxBytes) throw new ReadFailure('too_large');
  return inflateEntry(data, entry);
}

/** `<Pages>` from a .docx's `docProps/app.xml`, when the file has it. */
export function docxPageCount(data: Buffer): number | undefined {
  const app = zipEntry(data, 'docProps/app.xml', 1024 * 1024);
  if (!app) return undefined;
  const match = /<(?:\w+:)?Pages>\s*(\d+)\s*</.exec(app.toString('utf8'));
  return match ? Number(match[1]) : undefined;
}
