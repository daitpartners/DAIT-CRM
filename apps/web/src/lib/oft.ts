/**
 * Minimal reader for Outlook .oft / .msg files: OLE2 compound files holding MAPI property streams.
 * Extracts subject, plain-text body, HTML body and attached files, in the browser, with no dependencies.
 * A TypeScript port of prototype/js/oft.js (release 2A email templates); attachments added 24 Nov 2026 (template
 * pictures and attachments).
 */

/**
 * A file attached to the template: an inline picture (its content-id is referenced from the HTML as `cid:…`) or a
 * regular attachment. The type here is only what the file says; the server checks the bytes.
 */
export type OftAttachment = { name: string; contentType: string; contentId: string | null; inline: boolean; data: Uint8Array };
export type OftContent = { subject: string; body: string; html: string; attachments: OftAttachment[] };

type Entry = { id: number; name: string; type: number; start: number; size: number; left: number; right: number; child: number };
type Cfb = { entries: Entry[]; readStream: (e: Entry) => Uint8Array; children: (e: Entry) => Entry[] };

/** Directory ids at or above this are "no entry". */
const NO_STREAM = 0xfffffffa;

/** Sector numbers at or above this mark the end of a chain (or a free / special sector). */
const END = 0xfffffffa;

function readCfb(buf: ArrayBuffer): Cfb {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (buf.byteLength < 512 || dv.getUint32(0, true) !== 0xe011cfd0 || dv.getUint32(4, true) !== 0xe11ab1a1) {
    throw new Error('Not an Outlook template (.oft/.msg) file');
  }
  // Only the two sector sizes the format defines (512 B / 4 KiB) and 64-byte mini sectors; anything else is not a
  // template, and would make `1 << shift` wrap.
  const shift = dv.getUint16(30, true);
  const miniShift = dv.getUint16(32, true);
  if ((shift !== 9 && shift !== 12) || miniShift !== 6) throw new Error('Not an Outlook template (.oft/.msg) file');
  const S = 1 << shift;
  const miniS = 1 << miniShift;
  // No chain can hold more sectors than the file has; a longer walk means a loop (corrupt or crafted file).
  const maxSectors = Math.ceil(buf.byteLength / S) + 1;
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
  for (let k = 0; k < numDifat && dif < END && fatSectors.length < numFat && k < maxSectors; k++) {
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
    const seen = new Set<number>();
    let s = start;
    // Stop at the end marker, on a sector already visited (a loop) or past what the file can hold.
    while (s < END && !seen.has(s) && out.length < maxSectors) {
      seen.add(s);
      out.push(s);
      s = table[s] ?? END;
    }
    return out;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const sectors = chain(start, fat);
    const out = new Uint8Array(sectors.length * S);
    sectors.forEach((s, i) => out.set(u8.subarray(sec(s), sec(s) + S), i * S));
    return out.subarray(0, Math.min(size, out.length));
  };

  // Directory: 128-byte entries (UTF-16 name, type, start sector, size).
  const dirBytes = readChain(firstDir, chain(firstDir, fat).length * S);
  // Indexed by directory id (sibling and child links are ids); unused slots stay undefined.
  const byId: (Entry | undefined)[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const d = new DataView(dirBytes.buffer, dirBytes.byteOffset + off, 128);
    const nameLen = Math.min(d.getUint16(64, true), 64);
    if (!nameLen) continue;
    let name = '';
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(d.getUint16(i, true));
    byId[off / 128] = {
      id: off / 128, name, type: d.getUint8(66), start: d.getUint32(116, true), size: Number(d.getBigUint64(120, true)),
      left: d.getUint32(68, true), right: d.getUint32(72, true), child: d.getUint32(76, true),
    };
  }
  const entries = byId.filter((e): e is Entry => !!e);
  /** A storage's direct children: its child's sibling tree, walked without recursion and never twice (a loop). */
  const children = (e: Entry): Entry[] => {
    const out: Entry[] = [];
    const seen = new Set<number>();
    const todo = [e.child];
    while (todo.length) {
      const id = todo.pop()!;
      if (id >= NO_STREAM || seen.has(id)) continue;
      seen.add(id);
      const c = byId[id];
      if (!c) continue;
      out.push(c);
      todo.push(c.left, c.right);
    }
    return out;
  };
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
  return { entries, readStream, children };
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

/** The streams directly in a storage (the root: the message itself, not its attachments or recipients). */
function streamsOf(cfb: Cfb, storage: Entry | undefined): Entry[] {
  return storage ? cfb.children(storage).filter((e) => e.type === 2) : [];
}

/** A MAPI property stream of `streams`: Unicode, then ANSI, then binary as UTF-8. */
function prop(cfb: Cfb, tag: string, streams: Entry[] = streamsOf(cfb, cfb.entries.find((e) => e.type === 5))): string | null {
  const top = streams.filter((e) => e.name.startsWith(`__substg1.0_${tag}`));
  const u = top.find((e) => e.name.endsWith('001F'));
  if (u) return utf16(cfb.readStream(u));
  const a = top.find((e) => e.name.endsWith('001E'));
  if (a) return ascii(cfb.readStream(a));
  const bin = top.find((e) => e.name.endsWith('0102'));
  if (bin) return new TextDecoder('utf-8').decode(cfb.readStream(bin));
  return null;
}

/** Attachments read at most (a template has a handful; the server allows fewer). */
const MAX_ATTACHMENTS = 50;

/** The boolean / 32-bit fixed-size properties of an attachment (its `__properties_version1.0` stream, 8-byte header). */
function fixedProps(cfb: Cfb, streams: Entry[]): Map<number, number> {
  const out = new Map<number, number>();
  const s = streams.find((e) => e.name === '__properties_version1.0');
  if (!s) return out;
  const b = cfb.readStream(s);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let off = 8; off + 16 <= b.length; off += 16) {
    const tag = dv.getUint32(off, true);
    const type = tag & 0xffff;
    if (type === 0x000b || type === 0x0003) out.set(tag >>> 16, dv.getUint32(off + 8, true));
  }
  return out;
}

/** The content-id as the HTML refers to it: no angle brackets, no surrounding space. */
const cleanCid = (v: string | null) => (v ?? '').trim().replace(/^<|>$/g, '').trim() || null;

/**
 * The template's attached files (storages `__attach_version1.0_#NNNNNNNN`): file data (0x3701, binary), name (long
 * 0x3707, else 0x3704, else the display name 0x3001), MIME type (0x370E) and content-id (0x3712). A file whose
 * content-id the HTML uses as `cid:` is an inline picture; one Outlook hides (0x7FFE) that the HTML does not use is
 * left out, as Outlook does not show it either. Embedded messages (no binary data) are skipped.
 */
function attachmentsOf(cfb: Cfb, html: string): OftAttachment[] {
  const root = cfb.entries.find((e) => e.type === 5);
  if (!root) return [];
  const storages = cfb.children(root)
    .filter((e) => e.type === 1 && /^__attach_version1\.0_#[0-9A-Fa-f]{8}$/.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ATTACHMENTS);
  const used = new Set([...html.matchAll(/cid:([^"'\s)>]+)/gi)].map((m) => m[1]!.toLowerCase()));
  const out: OftAttachment[] = [];
  for (const storage of storages) {
    const streams = streamsOf(cfb, storage);
    const data = streams.find((e) => e.name === '__substg1.0_37010102');
    if (!data) continue;
    const name = (prop(cfb, '3707', streams) || prop(cfb, '3704', streams) || prop(cfb, '3001', streams) || '').trim();
    const contentId = cleanCid(prop(cfb, '3712', streams));
    const inline = !!contentId && used.has(contentId.toLowerCase());
    const hidden = fixedProps(cfb, streams).get(0x7ffe) === 1;
    if (hidden && !inline) continue;
    out.push({ name: name || contentId || 'attachment', contentType: (prop(cfb, '370E', streams) || '').trim().toLowerCase(), contentId, inline, data: cfb.readStream(data) });
  }
  return out;
}

/**
 * Subject (0x0037, else 0x0E1D), plain body (0x1000), HTML body (0x1013) and attachments; plain text from the HTML
 * when no body.
 */
export function parseOft(buf: ArrayBuffer): OftContent {
  const cfb = readCfb(buf);
  const subject = prop(cfb, '0037') || prop(cfb, '0E1D') || '';
  const body = prop(cfb, '1000') || '';
  const html = prop(cfb, '1013') || '';
  const attachments = attachmentsOf(cfb, html);
  if (!body && html) {
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    return { subject, body: text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), html, attachments };
  }
  return { subject, body: body.replace(/\r\n/g, '\n').trim(), html, attachments };
}
