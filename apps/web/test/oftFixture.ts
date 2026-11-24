import { crc32, deflateSync } from 'node:zlib';

/**
 * A synthetic Outlook template for tests (template pictures and attachments, 24 Nov 2026): a real OLE2 compound file
 * (512-byte sectors, small streams in the mini stream, large ones in their own sectors) holding the MAPI streams
 * parseOft reads — subject, plain and HTML body, and attachment storages with name, content-id, MIME type, data and
 * the hidden flag. Its pictures are generated PNGs and its attachment a small generated PDF: no real content.
 */

type Node = { name: string; type: 1 | 2 | 5; data?: Uint8Array; children?: Node[] };

const utf16 = (s: string) => {
  const b = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i) & 0xff;
    b[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return b;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const stream = (name: string, data: Uint8Array): Node => ({ name, type: 2, data });

const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;
const NONE = 0xffffffff;
const MINI_CUTOFF = 4096;

/** Writes the tree as a compound file (version 3). */
export function writeCfb(root: Node): Uint8Array {
  // Directory ids in depth-first order; each storage's children chained through their right-sibling links.
  const flat: { node: Node; child: number; right: number; start: number; size: number }[] = [];
  const add = (node: Node): number => {
    const id = flat.length;
    flat.push({ node, child: NONE, right: NONE, start: END, size: 0 });
    const ids = (node.children ?? []).map(add);
    if (ids.length) flat[id]!.child = ids[0]!;
    ids.forEach((c, i) => (flat[c]!.right = ids[i + 1] ?? NONE));
    return id;
  };
  add(root);

  // Small streams in the mini stream (64-byte mini sectors), large ones in regular sectors.
  const mini: number[] = [];
  const miniParts: Uint8Array[] = [];
  const big: { id: number; data: Uint8Array }[] = [];
  flat.forEach((e, id) => {
    const data = e.node.data;
    if (e.node.type !== 2 || !data) return;
    e.size = data.length;
    if (!data.length) return;
    if (data.length < MINI_CUTOFF) {
      const n = Math.ceil(data.length / 64);
      e.start = mini.length;
      for (let i = 0; i < n; i++) mini.push(i === n - 1 ? END : mini.length + 1);
      const padded = new Uint8Array(n * 64);
      padded.set(data);
      miniParts.push(padded);
    } else big.push({ id, data });
  });
  const miniStream = new Uint8Array(miniParts.reduce((n, p) => n + p.length, 0));
  miniParts.reduce((off, p) => (miniStream.set(p, off), off + p.length), 0);
  const sectors = (bytes: number) => Math.ceil(bytes / 512);

  const blocks: { bytes: Uint8Array; set: (start: number) => void }[] = [];
  const miniFat = new Uint8Array(sectors(mini.length * 4) * 512).fill(0xff);
  mini.forEach((v, i) => new DataView(miniFat.buffer).setUint32(i * 4, v, true));
  let firstMiniFat = END;
  let firstDir = END;
  if (mini.length) {
    blocks.push({ bytes: miniStream, set: (s) => { flat[0]!.start = s; flat[0]!.size = miniStream.length; } });
    blocks.push({ bytes: miniFat, set: (s) => (firstMiniFat = s) });
  }
  const dir = new Uint8Array(sectors(flat.length * 128) * 512);
  blocks.push({ bytes: dir, set: (s) => (firstDir = s) });
  for (const b of big) blocks.push({ bytes: b.data, set: (s) => (flat[b.id]!.start = s) });

  const dataSectors = blocks.reduce((n, b) => n + sectors(b.bytes.length), 0);
  let fatSectors = 1;
  while (fatSectors * 128 < dataSectors + fatSectors) fatSectors++;
  const total = fatSectors + dataSectors;
  const fat = new Uint32Array(fatSectors * 128).fill(FREE);
  for (let i = 0; i < fatSectors; i++) fat[i] = FATSECT;
  let next = fatSectors;
  const placed: { start: number; bytes: Uint8Array }[] = [];
  for (const b of blocks) {
    const n = sectors(b.bytes.length);
    b.set(next);
    for (let i = 0; i < n; i++) fat[next + i] = i === n - 1 ? END : next + i + 1;
    placed.push({ start: next, bytes: b.bytes });
    next += n;
  }

  // Directory entries (written after every start is known).
  const dv = new DataView(dir.buffer);
  flat.forEach((e, id) => {
    const off = id * 128;
    const name = utf16(e.node.name.slice(0, 31));
    dir.set(name, off);
    dv.setUint16(off + 64, name.length, true);
    dv.setUint8(off + 66, e.node.type);
    dv.setUint8(off + 67, 1);
    dv.setUint32(off + 68, NONE, true);
    dv.setUint32(off + 72, e.right, true);
    dv.setUint32(off + 76, e.child, true);
    dv.setUint32(off + 116, e.start, true);
    dv.setBigUint64(off + 120, BigInt(e.size), true);
  });

  const out = new Uint8Array((total + 1) * 512);
  const h = new DataView(out.buffer);
  h.setUint32(0, 0xe011cfd0, true);
  h.setUint32(4, 0xe11ab1a1, true);
  h.setUint16(24, 0x3e, true);
  h.setUint16(26, 3, true);
  h.setUint16(28, 0xfffe, true);
  h.setUint16(30, 9, true);
  h.setUint16(32, 6, true);
  h.setUint32(44, fatSectors, true);
  h.setUint32(48, firstDir, true);
  h.setUint32(56, MINI_CUTOFF, true);
  h.setUint32(60, firstMiniFat, true);
  h.setUint32(64, sectors(mini.length * 4), true);
  h.setUint32(68, END, true);
  h.setUint32(72, 0, true);
  for (let i = 0; i < 109; i++) h.setUint32(76 + i * 4, i < fatSectors ? i : FREE, true);
  for (let i = 0; i < fatSectors; i++) out.set(new Uint8Array(fat.buffer, i * 512, 512), (i + 1) * 512);
  for (const p of placed) out.set(p.bytes, (p.start + 1) * 512);
  return out;
}

/** A solid-colour PNG with a lighter band (a stand-in logo), width × height, RGB. */
export function makePng(width: number, height: number, rgb: [number, number, number], band: [number, number, number]): Uint8Array {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBand = y > height * 0.35 && y < height * 0.65 && x > width * 0.12 && x < width * 0.88;
      const [r, g, b] = inBand ? band : rgb;
      raw.set([r, g, b], y * row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** A one-page PDF with a line of text, padded past the mini-stream cutoff so it is stored in regular sectors. */
export function makePdf(text: string): Uint8Array {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  pdf += `% ${'synthetic test padding '.repeat(220)}\n`;
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return utf8(pdf);
}

export type FixtureFile = { name: string; mime: string; data: Uint8Array; contentId?: string; hidden?: boolean };

/** The fixed-size properties stream of an attachment: an 8-byte header, then the hidden flag (0x7FFE) when set. */
function attachProps(hidden: boolean): Uint8Array {
  const b = new Uint8Array(8 + 16 * 2);
  const dv = new DataView(b.buffer);
  dv.setUint32(8, (0x3705 << 16) | 0x0003, true); // attach method: by value
  dv.setUint32(8 + 8, 1, true);
  dv.setUint32(24, (0x7ffe << 16) | 0x000b, true); // hidden
  dv.setUint32(24 + 8, hidden ? 1 : 0, true);
  return b;
}

/** An .oft-like file: subject, plain body, HTML body and attachments. */
export function buildOft(opts: { subject: string; body: string; html: string; files: FixtureFile[] }): Uint8Array {
  const attachments: Node[] = opts.files.map((f, i) => ({
    name: `__attach_version1.0_#${String(i).padStart(8, '0')}`,
    type: 1,
    children: [
      stream('__properties_version1.0', attachProps(!!f.hidden)),
      stream('__substg1.0_3707001F', utf16(f.name)),
      stream('__substg1.0_3704001F', utf16(f.name.slice(0, 8))),
      stream('__substg1.0_370E001F', utf16(f.mime)),
      ...(f.contentId ? [stream('__substg1.0_3712001F', utf16(f.contentId))] : []),
      stream('__substg1.0_37010102', f.data),
    ],
  }));
  return writeCfb({
    name: 'Root Entry',
    type: 5,
    children: [
      stream('__substg1.0_0037001F', utf16(opts.subject)),
      stream('__substg1.0_1000001F', utf16(opts.body)),
      stream('__substg1.0_10130102', utf8(opts.html)),
      ...attachments,
    ],
  });
}

/** The synthetic "holiday" template used by the unit and e2e tests: two inline logos and a PDF. */
export function syntheticTemplate() {
  const logo = makePng(180, 48, [104, 17, 207], [255, 255, 255]);
  const signature = makePng(120, 36, [31, 21, 51], [104, 17, 207]);
  const pdf = makePdf('Synthetic brochure for tests');
  const hidden = makePng(4, 4, [200, 200, 200], [200, 200, 200]);
  const html = '<html><head><style>p.MsoNormal{margin:0 0 8px;font-family:Calibri,sans-serif}</style></head><body>'
    + '<p class="MsoNormal"><img src="cid:test-logo.png" alt="Test logo" width="180" height="48"></p>'
    + '<p class="MsoNormal">Hi <b>{first_name}</b>,</p>'
    + '<p class="MsoNormal">Warm wishes to everyone at {company} for the season.</p>'
    + '<p class="MsoNormal">Best regards,<br>{me}</p>'
    + '<p class="MsoNormal"><img src="cid:test-signature.png" alt="Signature" width="120" height="36"></p></body></html>';
  const oft = buildOft({
    subject: 'Season’s greetings, {first_name}',
    body: 'Hi {first_name},\r\n\r\nWarm wishes to everyone at {company} for the season.\r\n\r\nBest regards,\r\n{me}',
    html,
    files: [
      { name: 'test-logo.png', mime: 'image/png', data: logo, contentId: 'test-logo.png' },
      { name: 'test-signature.png', mime: 'image/png', data: signature, contentId: 'test-signature.png' },
      { name: 'Season-brochure.pdf', mime: 'application/pdf', data: pdf },
      // Hidden by Outlook and not used by the HTML: left out, as Outlook does.
      { name: 'image009.png', mime: 'image/png', data: hidden, contentId: 'unused@01DB', hidden: true },
    ],
  });
  return { oft, logo, signature, pdf, html };
}
