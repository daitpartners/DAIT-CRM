import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { formatDate, formatMoney, t, type Lang } from '@dait-crm/shared';
import type { CompanySettingsValues, QuotationSnapshot } from './service.js';

/*
 * The quotation PDF, drawn on the server from a snapshot (working copy or a sent revision), laid out like the
 * prototype's preview (V.quoteEditor, data-act=pdf): logo and issuer block, "Quotation <number>", date · valid until ·
 * revision, To / Subject, the lines table, totals, notes, page numbers. Labels in the owner's language; user-entered
 * text as typed. The same bytes serve Preview, Download and the email attachment.
 */

/** PDF labels (en is the key text). */
const LABELS: Record<Exclude<Lang, 'en'>, Record<string, string>> = {
  es: {
    'Quotation {number}': 'Presupuesto {number}',
    Date: 'Fecha',
    'Valid until': 'Válido hasta',
    Revision: 'Revisión',
    To: 'Para',
    Subject: 'Asunto',
    Item: 'Concepto',
    Qty: 'Cant.',
    'Unit price': 'Precio unitario',
    Total: 'Total',
    '{n}% discount': '{n}% de descuento',
    Net: 'Neto',
    'GST {n}%': 'GST {n}%',
    'Page {n} of {total}': 'Página {n} de {total}',
  },
  fr: {
    'Quotation {number}': 'Devis {number}',
    Date: 'Date',
    'Valid until': "Valable jusqu'au",
    Revision: 'Révision',
    To: 'À',
    Subject: 'Objet',
    Item: 'Article',
    Qty: 'Qté',
    'Unit price': 'Prix unitaire',
    Total: 'Total',
    '{n}% discount': 'Remise de {n} %',
    Net: 'Net',
    'GST {n}%': 'GST {n} %',
    'Page {n} of {total}': 'Page {n} sur {total}',
  },
};

/** The logo next to the code (src/ in dev and tests, dist/ when built — both two levels below apps/api). */
const LOGO = fileURLToPath(new URL('../../assets/logo-full.png', import.meta.url));

// Prototype preview colours (app.css / inline styles).
const INK = '#1F1533';
const HEADING = '#1F0249';
const MUTED = '#6A5E86';
const NOTES = '#4A3F66';
const RULE = '#E4DEF0';
const HEAD_BG = '#F6F3FB';

/** Height of the lines table's header row. */
const HEADER_H = 22;

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';

/**
 * The standard PDF fonts only carry WinAnsi (Latin-1 plus a few typographic marks): anything else in user text is
 * shown as "?" rather than a wrong glyph. The rupee sign becomes the code the amounts use.
 */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
function printable(s: string): string {
  return s.replace(/₹/g, 'INR ').replace(/[^\n\t\x20-\x7e\xa0-\xff]/gu, (ch) => (WIN_ANSI_EXTRA.has(ch) ? ch : '?'));
}

const num = (n: number) => String(Number(n.toFixed(4)));

/**
 * The PDF for `snap`. The issuer block comes from the snapshot when it carries one (a sent revision, frozen at send
 * time so its PDF never changes), else from the current Company details `settings` (working copy).
 */
export async function renderQuotationPdf(
  snap: QuotationSnapshot, settings: CompanySettingsValues, lang: Lang,
  opts: { compress?: boolean } = {},
): Promise<Buffer> {
  const from = snap.issuer ?? settings;
  const L = (phrase: string, vars?: Record<string, string | number>) => t(lang === 'en' ? {} : LABELS[lang], phrase, vars);
  const date = (ymdDate: string | null) => (ymdDate ? formatDate(`${ymdDate}T00:00:00Z`, { locale: lang, timezone: 'UTC', dateFormat: 'DD MMM YYYY' }) : '—');
  // Amounts without the currency code; the code is printed once, on the Total line (prototype "Total INR").
  const money = (amount: number) => formatMoney(amount, snap.currency).slice(snap.currency.length + 1);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 48, left: 48, right: 48, bottom: 64 },
    bufferPages: true,
    compress: opts.compress ?? true,
    info: { Title: L('Quotation {number}', { number: snap.number }), Author: printable(from.legalName) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const right = left + width;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  /* ---- header: logo left, issuer block right */
  const top = doc.page.margins.top;
  const logoH = 48;
  if (existsSync(LOGO)) doc.image(LOGO, left, top, { height: logoH });
  const issuer = [
    ...from.addressLines.filter((l) => l.trim()),
    from.email,
    ...(snap.currency === 'INR' && from.gstin ? [`GSTIN ${from.gstin}`] : []),
  ].map(printable);
  const issuerW = 220;
  doc.font(BOLD).fontSize(10).fillColor(INK).text(printable(from.legalName), right - issuerW, top, { width: issuerW, align: 'right' });
  doc.font(REGULAR).fontSize(9).fillColor(MUTED);
  for (const l of issuer) doc.text(l, right - issuerW, doc.y + 1, { width: issuerW, align: 'right' });
  let y = Math.max(top + logoH, doc.y) + 18;

  /* ---- title and dates */
  doc.font(BOLD).fontSize(20).fillColor(HEADING).text(L('Quotation {number}', { number: snap.number }), left, y, { width });
  doc.font(REGULAR).fontSize(10).fillColor(MUTED)
    .text(`${L('Date')} ${date(snap.quotationDate)} · ${L('Valid until')} ${date(snap.validUntil)} · ${L('Revision')} ${snap.revision}`, left, doc.y + 3, { width });
  y = doc.y + 16;

  /* ---- To / Subject */
  const c = snap.company;
  const to = [
    c.legalName || c.name,
    snap.contact?.name ?? '',
    c.street ?? '',
    [c.city, c.state, c.zip].filter(Boolean).join(', '),
    c.country,
  ].filter((s) => s && s.trim()).map(printable);
  const colW = (width - 24) / 2;
  doc.font(BOLD).fontSize(10).fillColor(INK).text(L('To'), left, y, { width: colW });
  doc.font(REGULAR).fontSize(10);
  for (const l of to) doc.text(l, left, doc.y + 1, { width: colW });
  const toEnd = doc.y;
  doc.font(BOLD).fontSize(10).text(L('Subject'), left + colW + 24, y, { width: colW });
  doc.font(REGULAR).fontSize(10).text(printable(snap.subject), left + colW + 24, doc.y + 1, { width: colW });
  y = Math.max(toEnd, doc.y) + 18;

  /* ---- lines table */
  const cols = { qty: 80, price: 100, total: 105 };
  const itemW = width - cols.qty - cols.price - cols.total;
  const x = { item: left, qty: left + itemW, price: left + itemW + cols.qty, total: left + itemW + cols.qty + cols.price };
  const pad = 6;

  const header = () => {
    const h = HEADER_H;
    doc.rect(left, y, width, h).fill(HEAD_BG);
    doc.font(BOLD).fontSize(9).fillColor(MUTED);
    doc.text(L('Item'), x.item + pad, y + 7, { width: itemW - 2 * pad, lineBreak: false });
    doc.text(L('Qty'), x.qty, y + 7, { width: cols.qty - pad, align: 'right', lineBreak: false });
    doc.text(L('Unit price'), x.price, y + 7, { width: cols.price - pad, align: 'right', lineBreak: false });
    doc.text(L('Total'), x.total, y + 7, { width: cols.total - pad, align: 'right', lineBreak: false });
    y += h;
  };
  const newPage = () => {
    doc.addPage();
    y = doc.page.margins.top;
  };

  header();
  const cellW = itemW - 2 * pad;
  /** The most a row may take: a fresh page below the table header. */
  const maxCell = bottom() - doc.page.margins.top - HEADER_H - 2 * pad;
  for (const l of snap.lines) {
    const item = printable(l.item);
    const discount = l.discount ? L('{n}% discount', { n: num(l.discount) }) : '';
    let desc = l.description ? printable(l.description) : '';
    doc.font(BOLD).fontSize(9.5);
    const itemH = Math.min(doc.heightOfString(item || ' ', { width: cellW }), maxCell);
    doc.font(REGULAR).fontSize(9);
    const discountH = discount ? 2 + doc.heightOfString(discount, { width: cellW }) : 0;
    // A description taller than a page is cut (with an ellipsis) to what fits on one, so the row never runs on.
    const descRoom = Math.max(0, maxCell - itemH - discountH - 2);
    let descH = desc ? doc.heightOfString(desc, { width: cellW }) : 0;
    if (descH > descRoom) {
      const lineH = doc.currentLineHeight(true);
      descH = Math.floor(descRoom / lineH) * lineH;
      if (descH <= 0) desc = '';
    }
    const h = itemH + (desc ? 2 + descH : 0) + discountH;
    const rowH = h + 2 * pad;
    if (y + rowH > bottom()) {
      newPage();
      header();
    }
    doc.font(BOLD).fontSize(9.5).fillColor(INK).text(item, x.item + pad, y + pad, { width: cellW, height: itemH, ellipsis: true });
    doc.font(REGULAR).fontSize(9).fillColor(MUTED);
    if (desc) doc.text(desc, x.item + pad, y + pad + itemH + 2, { width: cellW, height: descH, ellipsis: true });
    if (discount) doc.text(discount, x.item + pad, y + pad + itemH + (desc ? 2 + descH : 0) + 2, { width: cellW });
    doc.fillColor(INK).fontSize(9.5);
    doc.text(`${num(l.qty)} ${printable(l.unit)}`, x.qty, y + pad, { width: cols.qty - pad, align: 'right', lineBreak: false });
    doc.text(money(l.unitPrice), x.price, y + pad, { width: cols.price - pad, align: 'right', lineBreak: false });
    doc.text(money(l.total), x.total, y + pad, { width: cols.total - pad, align: 'right', lineBreak: false });
    y += rowH;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(RULE).stroke();
  }

  /* ---- totals, exactly as the prototype: Net (already less any overall discount), GST r%, Total */
  const tt = snap.totals;
  const rows: [string, string][] = [[L('Net'), money(tt.net)], [L('GST {n}%', { n: num(snap.taxRate) }), money(tt.tax)]];
  const totW = 260;
  const totX = right - totW;
  const rowH = 16;
  const blockH = rows.length * rowH + 26;
  y += 12;
  if (y + blockH > bottom()) newPage();
  doc.fontSize(10);
  for (const [label, value] of rows) {
    doc.font(REGULAR).fillColor(MUTED).text(label, totX, y, { width: totW / 2, lineBreak: false });
    doc.fillColor(INK).text(value, totX + totW / 2, y, { width: totW / 2 - pad, align: 'right', lineBreak: false });
    y += rowH;
  }
  doc.moveTo(totX, y).lineTo(right, y).lineWidth(0.8).strokeColor(RULE).stroke();
  y += 6;
  doc.font(BOLD).fontSize(12).fillColor(HEADING).text(`${L('Total')} ${snap.currency}`, totX, y, { width: totW / 2, lineBreak: false });
  doc.text(money(tt.total), totX + totW / 2 - 40, y, { width: totW / 2 + 40 - pad, align: 'right', lineBreak: false });
  y += 30;

  /* ---- notes & terms (flows onto the next page when long) */
  if (snap.notes.trim()) {
    if (y + 24 > bottom()) newPage();
    doc.font(REGULAR).fontSize(9.5).fillColor(NOTES).text(printable(snap.notes), left, y, { width });
  }

  /* ---- page numbers (drawn in the bottom margin, so lift it while writing) */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(REGULAR).fontSize(8.5).fillColor(MUTED)
      .text(L('Page {n} of {total}', { n: i - range.start + 1, total: range.count }), left, doc.page.height - 40, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = margin;
  }

  doc.end();
  return done;
}
