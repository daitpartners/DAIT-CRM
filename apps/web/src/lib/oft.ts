/**
 * Minimal reader for Outlook .oft / .msg files: OLE2 compound files holding MAPI property streams.
 * Extracts subject, plain-text body and HTML body, in the browser, with no dependencies.
 * A TypeScript port of prototype/js/oft.js (release 2A email templates).
 */
export type OftContent = { subject: string; body: string; html: string };

type Entry = { name: string; type: number; start: number; size: number };
type Cfb = { entries: Entry[]; readStream: (e: Entry) => Uint8Array };

/** Sector numbers at or above this mark the end of a chain (or a free / special sector). */
const END = 0xfffffffa;

function readCfb(buf: ArrayBuffer): Cfb {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (buf.byteLength < 512 || dv.getUint32(0, true) !== 0xe011cfd0 || dv.getUint32(4, true) !== 0xe11ab1a1) {
    throw new Error('Not an Outlook template (.oft/.msg) file');
  }
  const S = 1 << dv.getUint16(30, true);
  const miniS = 1 << dv.getUint16(32, true);
  const numFat = dv.getUint32(44, true);
  const firstDir = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const firstMiniFat = dv.getUint32(60, true);
  const firstDifat = dv.getUint32(68, true);
  const numDifat = dv.getUint32(72, true);
  const sec = (n: number) => (n + 1) * S;

  // DIFAT → the list of FAT sectors (109 in the header, the rest chained).
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const v = dv.getUint32(76 + i * 4, true);
    if (v < END) fatSectors.push(v);
  }
  let dif = firstDifat;
  for (let k = 0; k < numDifat && dif < END; k++) {
    const base = sec(dif);
    for (let i = 0; i < S / 4 - 1; i++) {
      const v = dv.getUint32(base + i * 4, true);
      if (v < END) fatSectors.push(v);
    }
    dif = dv.getUint32(base + S - 4, true);
  }
  const perSector = S / 4;
  const fat = new Uint32Array(fatSectors.length * perSector);
  fatSectors.forEach((fs, i) => {
    for (let j = 0; j < perSector; j++) fat[i * perSector + j] = dv.getUint32(sec(fs) + j * 4, true);
  });
  const chain = (start: number, table: Uint32Array): number[] => {
    const out: number[] = [];
    let s = start;
    let guard = 0;
    while (s < END && guard++ < 1e6) {
      out.push(s);
      s = table[s] ?? END;
    }
    return out;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const sectors = chain(start, fat);
    const out = new Uint8Array(sectors.length * S);
    sectors.forEach((s, i) => out.set(u8.subarray(sec(s), sec(s) + S), i * S));
    return out.subarray(0, size);
  };

  // Directory: 128-byte entries (UTF-16 name, type, start sector, size).
  const dirBytes = readChain(firstDir, chain(firstDir, fat).length * S);
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const d = new DataView(dirBytes.buffer, dirBytes.byteOffset + off, 128);
    const nameLen = d.getUint16(64, true);
    if (!nameLen) continue;
    let name = '';
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(d.getUint16(i, true));
    entries.push({ name, type: d.getUint8(66), start: d.getUint32(116, true), size: Number(d.getBigUint64(120, true)) });
  }
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFatSectors = chain(firstMiniFat, fat);
  const miniFat = new Uint32Array(miniFatSectors.length * perSector);
  miniFatSectors.forEach((fs, i) => {
    for (let j = 0; j < perSector; j++) miniFat[i * perSector + j] = dv.getUint32(sec(fs) + j * 4, true);
  });
  // Small streams live in the mini stream, in mini sectors.
  const readStream = (e: Entry): Uint8Array => {
    if (e.size >= miniCutoff) return readChain(e.start, e.size);
    const sectors = chain(e.start, miniFat);
    const out = new Uint8Array(sectors.length * miniS);
    sectors.forEach((s, i) => out.set(miniStream.subarray(s * miniS, s * miniS + miniS), i * miniS));
    return out.subarray(0, e.size);
  };
  return { entries, readStream };
}

const utf16 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i]! | (b[i + 1]! << 8));
  return s.replace(/\0+$/, '');
};
const ascii = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s.replace(/\0+$/, '');
};

/** A top-level (not attachment / recipient) MAPI property stream: Unicode, then ANSI, then binary as UTF-8. */
function prop(cfb: Cfb, tag: string): string | null {
  const top = cfb.entries.filter((e) => e.type === 2 && e.name.startsWith(`__substg1.0_${tag}`));
  const u = top.find((e) => e.name.endsWith('001F'));
  if (u) return utf16(cfb.readStream(u));
  const a = top.find((e) => e.name.endsWith('001E'));
  if (a) return ascii(cfb.readStream(a));
  const bin = top.find((e) => e.name.endsWith('0102'));
  if (bin) return new TextDecoder('utf-8').decode(cfb.readStream(bin));
  return null;
}

/** Subject (0x0037, else 0x0E1D), plain body (0x1000) and HTML body (0x1013); plain text from the HTML when no body. */
export function parseOft(buf: ArrayBuffer): OftContent {
  const cfb = readCfb(buf);
  const subject = prop(cfb, '0037') || prop(cfb, '0E1D') || '';
  const body = prop(cfb, '1000') || '';
  const html = prop(cfb, '1013') || '';
  if (!body && html) {
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    return { subject, body: text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), html };
  }
  return { subject, body: body.replace(/\r\n/g, '\n').trim(), html };
}
