/* Quotations (release 3A): currencies, statuses, defaults, the one totals function and money formatting. */

import { formatDate, type Lang } from './i18n.js';

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

/**
 * Half-up to 2 decimals, as Postgres rounds into a Decimal(…, 2) column, without the binary surprise
 * (1.005 → 1.01, not 1.00): the ×100 product is trimmed to 15 significant digits before rounding.
 */
export const round2 = (n: number): number => Math.sign(n) * Math.round(Number((Math.abs(n) * 100).toPrecision(15))) / 100;

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

/**
 * Settings → Company details as seeded by migration 20261202100000_quotations (the owner's issuer values; default
 * terms = the prototype's with VAT → GST). The migration's INSERT must match; the API falls back to these when the
 * row is missing (e.g. after a test reset).
 */
export const COMPANY_SETTINGS_DEFAULTS = {
  legalName: 'DAIT Partners LLP',
  addressLines: ['D-303, Sagar Sadan', 'IP Extension', 'Delhi 110092', 'India'],
  email: 'info@daitpartners.com',
  gstin: null,
  taxInr: 18,
  taxUsd: 0,
  taxCad: 0,
  defaultNotes: 'Payment: 40% on acceptance, 40% at milestone, 20% on completion. Prices exclude GST where applicable.',
} as const satisfies {
  legalName: string; addressLines: readonly string[]; email: string; gstin: string | null;
  taxInr: number; taxUsd: number; taxCad: number; defaultNotes: string;
};

const SEND_BODY: Record<Lang, { dated: string; undated: string }> = {
  en: {
    dated: 'Please find attached quotation {number} (revision {revision}), valid until {date}.',
    undated: 'Please find attached quotation {number} (revision {revision}).',
  },
  es: {
    dated: 'Adjuntamos el presupuesto {number} (revisión {revision}), válido hasta el {date}.',
    undated: 'Adjuntamos el presupuesto {number} (revisión {revision}).',
  },
  fr: {
    dated: "Veuillez trouver ci-joint le devis {number} (révision {revision}), valable jusqu'au {date}.",
    undated: 'Veuillez trouver ci-joint le devis {number} (révision {revision}).',
  },
};

/**
 * The default message of "Send by email" (prototype sendQuote), in `lang` (the quotation owner's, like the PDF); the
 * user may edit it in the send dialog. `validUntil` is YYYY-MM-DD, printed as on the PDF.
 */
export function defaultQuotationEmailBody(q: { number: string; revision: number; validUntil: string | null }, lang: Lang): string {
  const t = SEND_BODY[lang] ?? SEND_BODY.en;
  const date = q.validUntil ? formatDate(`${q.validUntil}T00:00:00Z`, { locale: lang, timezone: 'UTC', dateFormat: 'DD MMM YYYY' }) : '';
  return (q.validUntil ? t.dated : t.undated).replace('{number}', q.number).replace('{revision}', String(q.revision)).replace('{date}', date);
}
