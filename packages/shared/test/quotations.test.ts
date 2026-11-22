import {
  QUOTE_CURRENCIES, QUOTE_STATUSES, QUOTE_LOCKED, defaultCurrency, defaultTaxRate, quoteTotals, formatMoney, isQuoteLocked,
  COMPANY_SETTINGS_DEFAULTS,
} from '../src/quotations';
import { CompanySettingsUpdate, QuotationCreate, QuotationUpdate } from '../src/schemas/quotation';

const updatedAt = '2026-11-22T10:00:00.000Z';

describe('quotation constants', () => {
  test('currencies, statuses and locked statuses', () => {
    expect(QUOTE_CURRENCIES).toEqual(['USD', 'CAD', 'INR']);
    expect(QUOTE_STATUSES).toEqual(['Draft', 'Sent', 'Negotiating', 'Accepted', 'Rejected', 'Expired']);
    expect(QUOTE_LOCKED).toEqual(['Accepted', 'Rejected', 'Expired']);
    expect(isQuoteLocked('Accepted')).toBe(true);
    expect(isQuoteLocked('Negotiating')).toBe(false);
  });
});

describe('defaultCurrency', () => {
  test('India → INR, Canada → CAD, anything else → USD', () => {
    expect(defaultCurrency('India')).toBe('INR');
    expect(defaultCurrency('Canada')).toBe('CAD');
    expect(defaultCurrency('United States')).toBe('USD');
    expect(defaultCurrency('United Kingdom')).toBe('USD');
    expect(defaultCurrency(null)).toBe('USD');
  });
  test('ignores case and surrounding spaces', () => {
    expect(defaultCurrency(' india ')).toBe('INR');
    expect(defaultCurrency('CANADA')).toBe('CAD');
  });
});

describe('defaultTaxRate', () => {
  test('INR 18, USD 0, CAD 0 without settings', () => {
    expect(defaultTaxRate('INR')).toBe(18);
    expect(defaultTaxRate('USD')).toBe(0);
    expect(defaultTaxRate('CAD')).toBe(0);
  });
  test('Company details override the defaults (Decimal-like values accepted)', () => {
    const settings = { taxInr: '12.5', taxUsd: 0, taxCad: { toString: () => '5' } };
    expect(defaultTaxRate('INR', settings)).toBe(12.5);
    expect(defaultTaxRate('USD', settings)).toBe(0);
    expect(defaultTaxRate('CAD', settings)).toBe(5);
  });
});

describe('quoteTotals', () => {
  test('two discounted lines, overall 5%, GST 18% — to the cent', () => {
    const t = quoteTotals({
      lines: [
        { qty: 2, price: 1234.56, discount: 10 }, // gross 2469.12, discount 246.91
        { qty: 3, price: 999.99, discount: 7.5 }, // gross 2999.97, discount 225.00 (224.99775)
      ],
      overallDiscount: 5,
      taxRate: 18,
    });
    expect(t).toEqual({ sub: 5469.09, disc: 471.91, afterLines: 4997.18, overall: 249.86, net: 4747.32, tax: 854.52, total: 5601.84 });
  });
  test('matches the prototype formula on a plain quotation (no discounts)', () => {
    // prototype Q-2026-040: 1 × 24,000 + 5 × 6,000
    const t = quoteTotals({ lines: [{ qty: 1, price: 24000, discount: 0 }, { qty: 5, price: 6000, discount: 0 }], overallDiscount: 0, taxRate: 0 });
    expect(t.total).toBe(54000);
  });
  test('zero lines → all zero', () => {
    expect(quoteTotals({ lines: [], overallDiscount: 5, taxRate: 18 })).toEqual({ sub: 0, disc: 0, afterLines: 0, overall: 0, net: 0, tax: 0, total: 0 });
  });
  test('Decimal-like strings and missing discounts are read as numbers', () => {
    const t = quoteTotals({ lines: [{ qty: '1.5', price: '100.10', discount: null }], overallDiscount: '0', taxRate: '18' });
    expect(t).toMatchObject({ sub: 150.15, disc: 0, net: 150.15, tax: 27.03, total: 177.18 });
  });
  test('no floating-point residue', () => {
    const t = quoteTotals({ lines: [{ qty: 3, price: 0.1, discount: 0 }, { qty: 1, price: 0.2, discount: 0 }], overallDiscount: 0, taxRate: 0 });
    expect(t.total).toBe(0.5);
  });
});

describe('formatMoney', () => {
  test('USD and CAD western grouping, two decimals', () => {
    expect(formatMoney(12000, 'USD')).toBe('USD 12,000.00');
    expect(formatMoney(1234567.5, 'CAD')).toBe('CAD 1,234,567.50');
    expect(formatMoney(0, 'USD')).toBe('USD 0.00');
  });
  test('INR Indian grouping', () => {
    expect(formatMoney(1234567, 'INR')).toBe('INR 12,34,567.00');
    expect(formatMoney(450000, 'INR')).toBe('INR 4,50,000.00');
    expect(formatMoney(999.5, 'INR')).toBe('INR 999.50');
  });
});

describe('quotation schemas', () => {
  test('QuotationCreate', () => {
    expect(QuotationCreate.parse({ companyId: 3 })).toEqual({ companyId: 3 });
    expect(QuotationCreate.parse({ companyId: 3, leadId: 4, contactId: 5 })).toEqual({ companyId: 3, leadId: 4, contactId: 5 });
    expect(QuotationCreate.safeParse({}).success).toBe(false);
    expect(QuotationCreate.safeParse({ companyId: 0 }).success).toBe(false);
  });

  test('QuotationUpdate: header fields, lines and updatedAt', () => {
    const p = QuotationUpdate.parse({
      subject: '  Advisory services for Acme ', currency: 'INR', taxRate: 18, overallDiscount: 5,
      quotationDate: '2026-11-22', validUntil: '2026-12-22', contactId: 7, notes: 'Terms',
      lines: [{ item: 'Consulting services', description: '', qty: 1, unit: 'project', unitPrice: 0, discount: 0 }],
      updatedAt,
    });
    expect(p.subject).toBe('Advisory services for Acme');
    expect(p.lines).toEqual([{ item: 'Consulting services', description: null, qty: 1, unit: 'project', unitPrice: 0, discount: 0 }]);
    expect(QuotationUpdate.parse({ updatedAt })).toEqual({ updatedAt });
    expect(QuotationUpdate.parse({ contactId: null, validUntil: null, updatedAt })).toMatchObject({ contactId: null, validUntil: null });
  });

  test('QuotationUpdate: the lead can be changed or cleared', () => {
    expect(QuotationUpdate.parse({ leadId: 9, updatedAt })).toMatchObject({ leadId: 9 });
    expect(QuotationUpdate.parse({ leadId: null, updatedAt })).toMatchObject({ leadId: null });
    expect(QuotationUpdate.safeParse({ leadId: 0, updatedAt }).success).toBe(false);
  });

  test('QuotationUpdate rounds amounts and percentages to 2 decimals (as stored)', () => {
    const p = QuotationUpdate.parse({
      taxRate: 18.005, overallDiscount: 4.444,
      lines: [{ item: 'X', qty: 1.005, unit: 'h', unitPrice: 99.999, discount: 7.555 }],
      updatedAt,
    });
    expect(p).toMatchObject({ taxRate: 18.01, overallDiscount: 4.44 });
    expect(p.lines![0]).toMatchObject({ qty: 1.01, unitPrice: 100, discount: 7.56 });
    expect(CompanySettingsUpdate.parse({ ...COMPANY_SETTINGS_DEFAULTS, taxInr: 12.345 }).taxInr).toBe(12.35);
  });

  test('QuotationUpdate rejects bad values', () => {
    const bad = (o: object) => QuotationUpdate.safeParse({ ...o, updatedAt }).success;
    expect(QuotationUpdate.safeParse({}).success).toBe(false); // updatedAt required
    expect(bad({ currency: 'GBP' })).toBe(false);
    expect(bad({ taxRate: 101 })).toBe(false);
    expect(bad({ overallDiscount: -1 })).toBe(false);
    expect(bad({ quotationDate: '2026-02-30' })).toBe(false);
    expect(bad({ subject: '' })).toBe(false);
    expect(bad({ lines: [{ item: 'X', qty: -1, unit: 'project', unitPrice: 1, discount: 0 }] })).toBe(false);
    expect(bad({ lines: [{ item: 'X', qty: 1, unit: 'project', unitPrice: -1, discount: 0 }] })).toBe(false);
    expect(bad({ lines: [{ item: 'X', qty: 1, unit: 'project', unitPrice: 1, discount: 100.5 }] })).toBe(false);
    expect(bad({ lines: [{ item: '', qty: 1, unit: 'project', unitPrice: 1, discount: 0 }] })).toBe(false);
    expect(bad({ status: 'Accepted' })).toBe(true); // unknown keys are stripped, never applied
    expect('status' in QuotationUpdate.parse({ status: 'Accepted', updatedAt })).toBe(false);
  });

  test('COMPANY_SETTINGS_DEFAULTS: the issuer seeded by the migration, and valid Company details', () => {
    expect(COMPANY_SETTINGS_DEFAULTS).toEqual({
      legalName: 'DAIT Partners LLP',
      addressLines: ['D-303, Sagar Sadan', 'IP Extension', 'Delhi 110092', 'India'],
      email: 'info@daitpartners.com',
      gstin: null,
      taxInr: 18,
      taxUsd: 0,
      taxCad: 0,
      defaultNotes: 'Payment: 40% on acceptance, 40% at milestone, 20% on completion. Prices exclude GST where applicable.',
    });
    expect(CompanySettingsUpdate.parse(COMPANY_SETTINGS_DEFAULTS)).toEqual(COMPANY_SETTINGS_DEFAULTS);
  });

  test('CompanySettingsUpdate', () => {
    const s = CompanySettingsUpdate.parse({
      legalName: 'DAIT Partners LLP', addressLines: ['D-303, Sagar Sadan', 'IP Extension', 'Delhi 110092', 'India'],
      email: 'Info@DaitPartners.com', gstin: '', taxInr: 18, taxUsd: 0, taxCad: 0, defaultNotes: 'Payment terms',
    });
    expect(s).toMatchObject({ email: 'info@daitpartners.com', gstin: null, taxInr: 18 });
    expect(CompanySettingsUpdate.safeParse({ ...s, legalName: '' }).success).toBe(false);
    expect(CompanySettingsUpdate.safeParse({ ...s, email: 'nope' }).success).toBe(false);
    expect(CompanySettingsUpdate.safeParse({ ...s, taxInr: 120 }).success).toBe(false);
    expect(CompanySettingsUpdate.safeParse({ ...s, gstin: '07AAAAA0000A1Z5' }).success).toBe(true);
  });
});
