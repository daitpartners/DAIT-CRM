import { describe, expect, it } from 'vitest';
import { TEMPLATE_ATTACHMENTS_MAX_BYTES } from '@dait-crm/shared';
import { restoreCids, showInlineImages, sniffType, toBase64, uploadFiles, uploadImages } from '../src/lib/templateFiles';
import { makePng, makePdf } from './oftFixture';

describe('template pictures in the editor (24 Nov 2026)', () => {
  const images = {
    'logo.png': { url: 'data:image/png;base64,AAAA', cid: 'logo.png' },
    'image001.png@01db4f1e.6b7c5a40': { url: 'data:image/png;base64,BBBB', cid: 'image001.png@01DB4F1E.6B7C5A40' },
  };

  it('cid: pictures show as data: URLs and go back to cid: for saving and sending', () => {
    const html = '<style>p{margin:0}</style><p>Hi</p><img src="cid:logo.png" alt="DAIT"><img src="CID:image001.png@01db4f1e.6b7c5a40"><img src="cid:other.png">';
    const shown = showInlineImages(html, images);
    expect(shown).toContain('<style>p{margin:0}</style>');
    expect(shown).toContain('src="data:image/png;base64,AAAA"');
    expect(shown).toContain('src="data:image/png;base64,BBBB"');
    expect(shown).toContain('src="cid:other.png"');
    // Restored in the file's own case (Outlook-style ids have upper-case hex; review I2), whatever case the HTML had.
    expect(restoreCids(shown, images)).toBe('<style>p{margin:0}</style><p>Hi</p><img src="cid:logo.png" alt="DAIT"><img src="cid:image001.png@01DB4F1E.6B7C5A40"><img src="cid:other.png">');
    // A picture pasted again elsewhere (same data: URL, no marker) still goes back to its cid:.
    expect(restoreCids('<p><img src="data:image/png;base64,AAAA"></p>', images)).toBe('<p><img src="cid:logo.png"></p>');
    // Nothing to map: unchanged.
    expect(showInlineImages(html, {})).toBe(html);
    expect(restoreCids('<p>x</p>', images)).toBe('<p>x</p>');
  });

  it('showing does not load or run anything (parsed in an inert template)', () => {
    const shown = showInlineImages('<img src="cid:logo.png" onerror="window.__ran=1">', images);
    expect((window as unknown as { __ran?: number }).__ran).toBeUndefined();
    expect(shown).toContain('data:image/png');
  });

  it('keeps the files a template can carry, inline pictures first, within the size cap', () => {
    const png = makePng(2, 2, [0, 0, 0], [9, 9, 9]);
    const pdf = makePdf('x');
    const r = uploadFiles([
      { name: 'Brochure.pdf', contentType: 'application/pdf', contentId: null, inline: false, data: pdf },
      { name: 'logo.png', contentType: 'image/png', contentId: 'logo.png', inline: true, data: png },
      { name: 'run.exe', contentType: 'application/octet-stream', contentId: null, inline: false, data: new Uint8Array([0x4d, 0x5a]) },
      { name: 'fake.png', contentType: 'image/png', contentId: 'fake', inline: true, data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(r.keep.map((f) => [f.name, f.inline, f.contentType])).toEqual([['logo.png', true, 'image/png'], ['Brochure.pdf', false, 'application/pdf']]);
    expect(r.keep[0]!.data).toBe(toBase64(png));
    expect(r.skipped).toEqual(['fake.png', 'run.exe']);
    expect(r.tooLarge).toBe(false);
    expect(uploadImages(r.keep)).toEqual({ 'logo.png': { url: `data:image/png;base64,${toBase64(png)}`, cid: 'logo.png' } });

    const big = new Uint8Array(TEMPLATE_ATTACHMENTS_MAX_BYTES);
    big.set(pdf);
    const over = uploadFiles([
      { name: 'logo.png', contentType: 'image/png', contentId: 'logo.png', inline: true, data: png },
      { name: 'Huge.pdf', contentType: 'application/pdf', contentId: null, inline: false, data: big },
    ]);
    expect(over.keep.map((f) => f.name)).toEqual(['logo.png']);
    expect(over.skipped).toEqual(['Huge.pdf']);
    expect(over.tooLarge).toBe(true);
  });

  it('the browser sniffs as the server does: a file the server would refuse is left out, not sent to fail (review M5)', () => {
    const at = (bytes: number[] | string) => (typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
    expect(sniffType(at([0x89, 0x50, 0x4e, 0x47]), 'a.png')).toBeNull(); // only 4 of the 8 PNG signature bytes
    expect(sniffType(at('GIF8xa'), 'a.gif')).toBeNull();
    expect(sniffType(at('junk %PDF-1.4'), 'a.pdf')).toBeNull();
    expect(sniffType(at('%PDF-1.4'), 'a.png')?.contentType).toBe('application/pdf');
    expect(sniffType(at([0x50, 0x4b, 0x03, 0x04]), 'a.docx')?.contentType).toContain('wordprocessingml');
    expect(sniffType(at([0x50, 0x4b, 0x03, 0x04]), 'a.zip')).toBeNull();
    expect(sniffType(at('plain text'), 'Report.pdf')).toBeNull();
    const r = uploadFiles([{ name: 'Report.pdf', contentType: 'application/pdf', contentId: null, inline: false, data: at('not a pdf') }]);
    expect(r.keep).toEqual([]);
    expect(r.skipped).toEqual(['Report.pdf']);
  });

  it('base64 of a large file matches Node’s', () => {
    const bytes = new Uint8Array(200_000).map((_v, i) => (i * 7) & 0xff);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
