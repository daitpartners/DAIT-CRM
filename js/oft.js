/* Minimal reader for Outlook .oft / .msg files (OLE2 compound files holding MAPI property streams).
   Extracts subject, plain-text body and HTML body. Pure browser JS, no dependencies.
   The real build does the same on the server (e.g. a msg/oft parser package) and stores the result in email_templates. */
window.OFT = (function () {
  function readCFB(buf) {
    const dv = new DataView(buf); const u8 = new Uint8Array(buf);
    if (dv.getUint32(0, true) !== 0xE011CFD0 || dv.getUint32(4, true) !== 0xE11AB1A1) throw new Error('Not an Outlook template (.oft/.msg) file');
    const sectorShift = dv.getUint16(30, true); const S = 1 << sectorShift; const miniS = 1 << dv.getUint16(32, true);
    const numFat = dv.getUint32(44, true); const firstDir = dv.getUint32(48, true); const miniCutoff = dv.getUint32(56, true);
    const firstMiniFat = dv.getUint32(60, true); const numMiniFat = dv.getUint32(64, true); const firstDifat = dv.getUint32(68, true); const numDifat = dv.getUint32(72, true);
    const sec = (n) => (n + 1) * S;
    // DIFAT → FAT sector list
    const fatSectors = []; for (let i = 0; i < 109 && fatSectors.length < numFat; i++) { const v = dv.getUint32(76 + i * 4, true); if (v < 0xFFFFFFFA) fatSectors.push(v); }
    let dif = firstDifat; for (let k = 0; k < numDifat && dif < 0xFFFFFFFA; k++) { const base = sec(dif); for (let i = 0; i < S / 4 - 1; i++) { const v = dv.getUint32(base + i * 4, true); if (v < 0xFFFFFFFA) fatSectors.push(v); } dif = dv.getUint32(base + S - 4, true); }
    const fat = new Uint32Array(fatSectors.length * (S / 4)); fatSectors.forEach((fs, i) => { for (let j = 0; j < S / 4; j++) fat[i * (S / 4) + j] = dv.getUint32(sec(fs) + j * 4, true); });
    const chain = (start, table) => { const out = []; let s = start; let guard = 0; while (s < 0xFFFFFFFA && guard++ < 1e6) { out.push(s); s = table[s]; } return out; };
    const readChain = (start, size) => { const sectors = chain(start, fat); const out = new Uint8Array(sectors.length * S); sectors.forEach((s, i) => out.set(u8.subarray(sec(s), sec(s) + S), i * S)); return out.subarray(0, size); };
    // directory
    const dirBytes = readChain(firstDir, chain(firstDir, fat).length * S); const entries = [];
    for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
      const d = new DataView(dirBytes.buffer, dirBytes.byteOffset + off, 128); const nameLen = d.getUint16(64, true); if (!nameLen) continue;
      let name = ''; for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(d.getUint16(i, true));
      entries.push({ name, type: d.getUint8(66), start: d.getUint32(116, true), size: Number(d.getBigUint64(120, true)) });
    }
    const root = entries.find((e) => e.type === 5); const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
    const miniFatSectors = chain(firstMiniFat, fat); const miniFat = new Uint32Array(miniFatSectors.length * (S / 4)); miniFatSectors.forEach((fs, i) => { for (let j = 0; j < S / 4; j++) miniFat[i * (S / 4) + j] = dv.getUint32(sec(fs) + j * 4, true); });
    const readStream = (e) => { if (e.size >= miniCutoff) return readChain(e.start, e.size); const sectors = chain(e.start, miniFat); const out = new Uint8Array(sectors.length * miniS); sectors.forEach((s, i) => out.set(miniStream.subarray(s * miniS, s * miniS + miniS), i * miniS)); return out.subarray(0, e.size); };
    return { entries, readStream };
  }
  const utf16 = (b) => { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8)); return s.replace(/\0+$/, ''); };
  const ascii = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s.replace(/\0+$/, ''); };
  function prop(cfb, tag) { // top-level (not inside attachments/recipients) property stream, unicode then ansi
    const top = cfb.entries.filter((e) => e.type === 2 && e.name.startsWith('__substg1.0_' + tag));
    const u = top.find((e) => e.name.endsWith('001F')); if (u) return utf16(cfb.readStream(u));
    const a = top.find((e) => e.name.endsWith('001E')); if (a) return ascii(cfb.readStream(a));
    const bin = top.find((e) => e.name.endsWith('0102')); if (bin) return new TextDecoder('utf-8').decode(cfb.readStream(bin));
    return null;
  }
  function parse(buf) {
    const cfb = readCFB(buf);
    const subject = prop(cfb, '0037') || prop(cfb, '0E1D') || '';
    const body = prop(cfb, '1000') || '';
    let html = prop(cfb, '1013') || '';
    if (!body && html) { const tmp = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); return { subject, body: tmp.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(), html }; }
    return { subject, body: body.replace(/\r\n/g, '\n').trim(), html };
  }
  return { parse };
})();
