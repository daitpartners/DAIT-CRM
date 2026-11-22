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
    Subtotal: 'Subtotal',
    'Discount {n}%': 'Descuento {n}%',
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
    Subtotal: 'Sous-total',
    'Discount {n}%': 'Remise {n} %',
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

export async function renderQuotationPdf(
  snap: QuotationSnapshot, settings: CompanySettingsValues, lang: Lang,
  opts: { compress?: boolean } = {},
): Promise<Buffer> {
  const L = (phrase: string, vars?: Record<string, string | number>) => t(lang === 'en' ? {} : LABELS[lang], phrase, vars);
  const date = (ymdDate: string | null) => (ymdDate ? formatDate(`${ymdDate}T00:00:00Z`, { locale: lang, timezone: 'UTC', dateFormat: 'DD MMM YYYY' }) : '—');
  const money = (amount: number) => formatMoney(amount, snap.currency);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 48, left: 48, right: 48, bottom: 64 },
    bufferPages: true,
    compress: opts.compress ?? true,
    info: { Title: L('Quotation {number}', { number: snap.number }), Author: printable(settings.legalName) },
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
    ...settings.addressLines.filter((l) => l.trim()),
    settings.email,
    ...(snap.currency === 'INR' && settings.gstin ? [`GSTIN ${settings.gstin}`] : []),
  ].map(printable);
  const issuerW = 220;
  doc.font(BOLD).fontSize(10).fillColor(INK).text(printable(settings.legalName), right - issuerW, top, { width: issuerW, align: 'right' });
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
    const h = 22;
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
  for (const l of snap.lines) {
    const cellW = itemW - 2 * pad;
    const item = printable(l.item);
    const extra = [l.description ? printable(l.description) : '', l.discount ? L('{n}% discount', { n: num(l.discount) }) : ''].filter(Boolean);
    doc.font(BOLD).fontSize(9.5);
    let h = doc.heightOfString(item || ' ', { width: cellW });
    doc.font(REGULAR).fontSize(9);
    for (const e of extra) h += 2 + doc.heightOfString(e, { width: cellW });
    const rowH = h + 2 * pad;
    if (y + rowH > bottom()) {
      newPage();
      header();
    }
    doc.font(BOLD).fontSize(9.5).fillColor(INK).text(item, x.item + pad, y + pad, { width: cellW });
    doc.font(REGULAR).fontSize(9).fillColor(MUTED);
    for (const e of extra) doc.text(e, x.item + pad, doc.y + 2, { width: cellW });
    doc.fillColor(INK).fontSize(9.5);
    doc.text(`${num(l.qty)} ${printable(l.unit)}`, x.qty, y + pad, { width: cols.qty - pad, align: 'right', lineBreak: false });
    doc.text(money(l.unitPrice), x.price, y + pad, { width: cols.price - pad, align: 'right', lineBreak: false });
    doc.text(money(l.total), x.total, y + pad, { width: cols.total - pad, align: 'right', lineBreak: false });
    y += rowH;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(RULE).stroke();
  }

  /* ---- totals (prototype: Net, Tax, Total; the overall discount shown when there is one) */
  const tt = snap.totals;
  const rows: [string, string][] = [];
  if (tt.overall) rows.push([L('Subtotal'), money(tt.afterLines)], [L('Discount {n}%', { n: num(snap.overallDiscount) }), `– ${money(tt.overall)}`]);
  rows.push([L('Net'), money(tt.net)], [L('GST {n}%', { n: num(snap.taxRate) }), money(tt.tax)]);
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
  doc.font(BOLD).fontSize(12).fillColor(HEADING).text(L('Total'), totX, y, { width: totW / 2, lineBreak: false });
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
