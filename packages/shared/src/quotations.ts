/* Quotations (release 3A): currencies, statuses, defaults, the one totals function and money formatting. */

export const QUOTE_CURRENCIES = ['USD', 'CAD', 'INR'] as const;
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number];

export const QUOTE_STATUSES = ['Draft', 'Sent', 'Negotiating', 'Accepted', 'Rejected', 'Expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** No edits and no send once a quotation reaches one of these (Duplicate still allowed). */
export const QUOTE_LOCKED: readonly QuoteStatus[] = ['Accepted', 'Rejected', 'Expired'];

export function isQuoteLocked(status: string): boolean {
  return (QUOTE_LOCKED as readonly string[]).includes(status);
}

/** Currency from the company's country: India → INR, Canada → CAD, anything else (or unknown) → USD. */
export function defaultCurrency(country: string | null): QuoteCurrency {
  const c = (country ?? '').trim().toLowerCase();
  if (c === 'india') return 'INR';
  if (c === 'canada') return 'CAD';
  return 'USD';
}

/** A number, a numeric string or a Prisma Decimal (anything whose toString() is numeric); null/blank → 0. */
type Numeric = number | string | { toString(): string } | null | undefined;
const num = (v: Numeric): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : 0;
};

/** Built-in defaults (INR 18, USD 0, CAD 0) when Company details are not at hand. */
const TAX_DEFAULTS: Record<QuoteCurrency, number> = { INR: 18, USD: 0, CAD: 0 };

/** Default GST % for a currency: from Settings → Company details when given, else INR 18, USD 0, CAD 0. */
export function defaultTaxRate(currency: QuoteCurrency, settings?: { taxInr: Numeric; taxUsd: Numeric; taxCad: Numeric } | null): number {
  if (!settings) return TAX_DEFAULTS[currency];
  return num(currency === 'INR' ? settings.taxInr : currency === 'CAD' ? settings.taxCad : settings.taxUsd);
}

/** Half-up to 2 decimals, without the 1.005 → 1.00 binary surprise. */
const round2 = (n: number): number => Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;

export interface QuoteTotals {
  /** Σ qty × price */
  sub: number;
  /** Σ line discounts */
  disc: number;
  /** sub − disc */
  afterLines: number;
  /** overall discount % on afterLines */
  overall: number;
  /** afterLines − overall */
  net: number;
  /** GST % on net */
  tax: number;
  total: number;
}

/**
 * The prototype's quoteTotals (store.js), rounded to 2 decimals per line (gross and line discount) and on each
 * result. Accepts numbers or Decimal-like values so the API can pass Prisma rows straight in.
 */
export function quoteTotals(q: {
  lines: { qty: Numeric; price: Numeric; discount?: Numeric }[];
  overallDiscount?: Numeric;
  taxRate?: Numeric;
}): QuoteTotals {
  let sub = 0;
  let disc = 0;
  for (const l of q.lines) {
    const gross = round2(num(l.qty) * num(l.price));
    sub += gross;
    disc += round2(gross * num(l.discount) / 100);
  }
  sub = round2(sub);
  disc = round2(disc);
  const afterLines = round2(sub - disc);
  const overall = round2(afterLines * num(q.overallDiscount) / 100);
  const net = round2(afterLines - overall);
  const tax = round2(net * num(q.taxRate) / 100);
  return { sub, disc, afterLines, overall, net, tax, total: round2(net + tax) };
}

const MONEY_FORMATS: Record<QuoteCurrency, Intl.NumberFormat> = {
  USD: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  CAD: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  // Indian grouping: 12,34,567.00
  INR: new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
};

/** `USD 12,000.00`, `CAD 1,234,567.50`, `INR 12,34,567.00`. */
export function formatMoney(amount: number, currency: QuoteCurrency): string {
  return `${currency} ${MONEY_FORMATS[currency].format(amount)}`;
}
