import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMPANY_SETTINGS_DEFAULTS, quoteTotals } from '@dait-crm/shared';
import { prisma } from '../src/db';
import { buildApp } from '../src/app';
import { renderQuotationPdf } from '../src/quotations/pdf';
import type { CompanySettingsValues, QuotationSnapshot } from '../src/quotations/service';
import { resetDb, seedLookups } from './helpers';
import { makeCompany, makeContact, makeLead, makeUser, signIn } from './factory';

/**
 * The text drawn on an uncompressed PDF: every TJ operator's hex strings decoded (WinAnsi ≈ latin1 for the
 * characters used here), one line per operator. Kerning splits a word into several hex strings within one operator.
 */
function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/\[((?:<[0-9a-fA-F]*>|\s|-?[\d.]+)*)\]\s*TJ/g)) {
    const hex = [...m[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]).join('');
    out.push(Buffer.from(hex, 'hex').toString('latin1'));
  }
  return out.join('\n');
}
const pageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

const settings = (over: Partial<CompanySettingsValues> = {}): CompanySettingsValues => ({
  ...COMPANY_SETTINGS_DEFAULTS, addressLines: [...COMPANY_SETTINGS_DEFAULTS.addressLines], ...over,
});

type Line = { item: string; description: string | null; qty: number; unit: string; unitPrice: number; discount: number };
function snapshot(over: Partial<QuotationSnapshot> = {}, lines: Line[] = [
  { item: 'Discovery workshop', description: 'Two days on site', qty: 2, unit: 'day', unitPrice: 75000, discount: 0 },
  { item: 'Website rebuild', description: null, qty: 1, unit: 'project', unitPrice: 850000, discount: 10 },
  { item: 'Support retainer', description: 'Monthly', qty: 1, unit: 'month', unitPrice: 319567, discount: 0 },
]): QuotationSnapshot {
  const base = {
    number: 'Q-2026-007', revision: 2, quotationDate: '2026-11-22', validUntil: '2026-12-22', currency: 'INR' as const,
    subject: 'Advisory services for Acme India', taxRate: 18, overallDiscount: 0, notes: 'Payment: 40% on acceptance.',
    companyId: 1, contactId: 1, leadId: 1,
    company: { name: 'Acme', legalName: 'Acme India Pvt Ltd', street: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', zip: '560001', country: 'India' },
    contact: { name: 'Priya Rao', email: 'priya@acme.test' },
    ...over,
  };
  const withTotals = lines.map((l) => ({ ...l, total: Math.round(l.qty * l.unitPrice * (1 - l.discount / 100) * 100) / 100 }));
  return {
    ...base, lines: withTotals,
    totals: quoteTotals({ lines: lines.map((l) => ({ qty: l.qty, price: l.unitPrice, discount: l.discount })), overallDiscount: base.overallDiscount, taxRate: base.taxRate }),
  };
}

const render = (s: QuotationSnapshot, c: CompanySettingsValues, lang: 'en' | 'es' | 'fr' = 'en') => renderQuotationPdf(s, c, lang, { compress: false });

describe('renderQuotationPdf', () => {
  it('draws issuer, number, lines, GST and amounts in the currency format', async () => {
    // net 150,000 + 765,000 + 319,567 = 12,34,567
    const buf = await render(snapshot(), settings({ gstin: '07AAAFD1234A1Z5' }));
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const text = pdfText(buf);
    expect(text).toContain('DAIT Partners LLP');
    expect(text).toContain('D-303, Sagar Sadan');
    expect(text).toContain('info@daitpartners.com');
    expect(text).toContain('Quotation Q-2026-007');
    expect(text).toMatch(/Revision 2/);
    for (const item of ['Discovery workshop', 'Website rebuild', 'Support retainer', 'Two days on site', '10% discount']) expect(text).toContain(item);
    expect(text).toContain('Acme India Pvt Ltd');
    expect(text).toContain('Priya Rao');
    expect(text).toContain('Advisory services for Acme India');
    expect(text).toContain('GST 18%');
    expect(text).toContain('INR 12,34,567.00');
    expect(text).toContain('INR 1,50,000.00');
    expect(text).toContain('GSTIN 07AAAFD1234A1Z5');
    expect(text).toContain('Payment: 40% on acceptance.');
    expect(text).toContain('Page 1 of 1');
  });

  it('prints GSTIN only on INR quotations with a GSTIN set', async () => {
    const usd = pdfText(await render(snapshot({ currency: 'USD', taxRate: 0 }), settings({ gstin: '07AAAFD1234A1Z5' })));
    expect(usd).not.toContain('GSTIN');
    expect(usd).toContain('USD 150,000.00');
    expect(pdfText(await render(snapshot(), settings({ gstin: null })))).not.toContain('GSTIN');
  });

  it('uses Spanish labels for a Spanish owner, user text as typed', async () => {
    const text = pdfText(await render(snapshot(), settings(), 'es'));
    expect(text).toContain('Presupuesto Q-2026-007');
    expect(text).toContain('Válido hasta');
    expect(text).toContain('Página 1 de 1');
    expect(text).toContain('Discovery workshop');
    expect(text).not.toContain('Valid until');
  });

  it('runs onto more pages with page numbers for 40 lines', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ item: `Item ${i + 1}`, description: 'Line description', qty: 1, unit: 'unit', unitPrice: 1000, discount: 0 }));
    const buf = await render(snapshot({}, lines), settings());
    expect(pageCount(buf)).toBeGreaterThan(1);
    const text = pdfText(buf);
    expect(text).toContain('Item 40');
    expect(text).toContain(`Page 1 of ${pageCount(buf)}`);
    expect(text).toContain(`Page ${pageCount(buf)} of ${pageCount(buf)}`);
  });

  it('totals are always Net / GST / Total (prototype); Net already carries the overall discount', async () => {
    const snap = snapshot({ overallDiscount: 5 });
    snap.totals = quoteTotals({ lines: snap.lines.map((l) => ({ qty: l.qty, price: l.unitPrice, discount: l.discount })), overallDiscount: 5, taxRate: 18 });
    const text = pdfText(await render(snap, settings()));
    expect(text).not.toContain('Subtotal');
    expect(text).not.toMatch(/Discount 5%/);
    // 12,34,567 less 5 % = 11,72,838.65
    expect(snap.totals.net).toBe(1172838.65);
    expect(text).toContain('Net');
    expect(text).toContain('INR 11,72,838.65');
    expect(text).toContain('GST 18%');
  });

  it('cuts a description taller than a page to one page, so the layout and page numbers stay right', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i + 1} of a very long scope description.`).join(' ');
    const lines = [
      { item: 'Huge scope', description: long, qty: 1, unit: 'project', unitPrice: 1000, discount: 0 },
      { item: 'After line', description: null, qty: 1, unit: 'unit', unitPrice: 10, discount: 0 },
    ];
    const buf = await render(snapshot({}, lines), settings());
    // page 1: heading and table header; page 2: the cut row on a page of its own; page 3: the next line and totals
    // (uncut, the description alone ran onto 8 pages with the rows drawn over it)
    expect(pageCount(buf)).toBe(3);
    const text = pdfText(buf);
    expect(text).toContain('Huge scope');
    expect(text).not.toContain('Sentence 400 ');
    expect(text).toContain('After line');
    for (const n of [1, 2, 3]) expect(text).toContain(`Page ${n} of 3`);
  });

  it('shows characters outside the standard fonts as "?" (₹ as INR) instead of failing', async () => {
    const lines = [{ item: 'Café ₹ fee ✓', description: '“Fase 2” – año', qty: 1, unit: 'unit', unitPrice: 10, discount: 0 }];
    const text = pdfText(await render(snapshot({}, lines), settings()));
    expect(text).toContain('Café INR  fee ?');
    expect(text).toContain('Fase 2');
  });

  it('compresses by default (the production output)', async () => {
    const buf = await renderQuotationPdf(snapshot(), settings(), 'en');
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfText(buf)).not.toContain('Q-2026-007');
  });
});

describe('GET /api/quotations/:id/pdf', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.env.TEST_LOGIN = '1';
    app = await buildApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await seedLookups();
  });

  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  async function as(role: 'ADMINISTRATOR' | 'SALES_REPRESENTATIVE'): Promise<{ user: User; cookie: string }> {
    const user = await makeUser({ role });
    return { user, cookie: await signIn(app, user) };
  }

  async function quote(cookie: string, assigneeId: number) {
    const company = await makeCompany({ country: 'India', name: 'Acme India' });
    const contact = await makeContact({ companyId: company.id, businessEmail: 'buyer@acme.test' });
    const lead = await makeLead({ companyId: company.id, contactId: contact.id, assignedToId: assigneeId, status: 'Qualified' });
    const res = await app.inject({ method: 'POST', url: '/api/quotations', payload: { companyId: company.id, leadId: lead.id }, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: number; number: string };
  }

  it('serves the working copy inline as application/pdf', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const q = await quote(rep.cookie, rep.user.id);
    const res = await get(`/api/quotations/${q.id}/pdf`, rep.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`inline; filename="${q.number}-rev1.pdf"`);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // the document title (outside the compressed streams) carries the owner's language
    expect(res.rawPayload.toString('latin1')).toContain(`(Quotation ${q.number})`);
    await prisma.user.update({ where: { id: rep.user.id }, data: { language: 'es' } });
    const es = await get(`/api/quotations/${q.id}/pdf`, rep.cookie);
    expect(es.rawPayload.toString('latin1')).toContain(`(Presupuesto ${q.number})`);
  });

  it('serves a sent revision from its snapshot with ?rev=n, 404 for an unknown revision', async () => {
    const admin = await as('ADMINISTRATOR');
    const q = await quote(admin.cookie, admin.user.id);
    const res0 = await get(`/api/quotations/${q.id}/pdf?rev=1`, admin.cookie);
    expect(res0.statusCode).toBe(404);
    const { quotationSnapshot } = await import('../src/quotations/service');
    const snap = await quotationSnapshot(prisma, q.id);
    await prisma.quotationRevision.create({
      data: {
        quotationId: q.id, revisionNo: 1, sentAt: new Date(), sentTo: 'buyer@acme.test', subtotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0,
        snapshot: snap as object,
      },
    });
    await prisma.quotation.update({ where: { id: q.id }, data: { revision: 2, editingNewRevision: true, status: 'Sent' } });
    const res = await get(`/api/quotations/${q.id}/pdf?rev=1`, admin.cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toBe(`inline; filename="${q.number}-rev1.pdf"`);
    const working = await get(`/api/quotations/${q.id}/pdf`, admin.cookie);
    expect(working.headers['content-disposition']).toBe(`inline; filename="${q.number}-rev2.pdf"`);
    expect((await get(`/api/quotations/${q.id}/pdf?rev=abc`, admin.cookie)).statusCode).toBe(404);
  });

  it('401 signed out, 404 when the quotation is hidden from the user', async () => {
    const rep = await as('SALES_REPRESENTATIVE');
    const other = await as('SALES_REPRESENTATIVE');
    const q = await quote(rep.cookie, rep.user.id);
    expect((await get(`/api/quotations/${q.id}/pdf`)).statusCode).toBe(401);
    expect((await get(`/api/quotations/${q.id}/pdf`, other.cookie)).statusCode).toBe(404);
    expect((await get('/api/quotations/999999/pdf', rep.cookie)).statusCode).toBe(404);
  });
});
