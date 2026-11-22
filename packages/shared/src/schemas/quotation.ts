import { z } from 'zod';
import { isoDate, optionalText } from './common.js';
import { QUOTE_CURRENCIES, round2 } from '../quotations.js';

/** Largest amount the money columns (Decimal(14,2)) hold. */
export const QUOTE_MAX_AMOUNT = 999_999_999_999.99;
export const QUOTE_MAX_LINES = 100;
const NOTES_MAX = 10_000;

/** Amounts and percentages are rounded to 2 decimals here, as the Decimal(…, 2) columns store them, so the totals the
 * editor shows and the totals computed from the stored row cannot differ by a cent. */
const twoDp = (min: number, max: number) => z.number().min(min).max(max).transform(round2);
const percent = twoDp(0, 100);
const id = z.number().int().positive();

/** "New quotation": the company, and optionally its lead and contact; everything else comes from the defaults. */
export const QuotationCreate = z.object({
  companyId: id,
  leadId: id.optional(),
  contactId: id.optional(),
});
export type QuotationCreate = z.infer<typeof QuotationCreate>;

/** One line of the working copy, in order. Quantities and prices cannot go negative; discount is a percentage. */
export const LineInput = z.object({
  item: z.string().trim().min(1).max(300),
  description: optionalText(NOTES_MAX),
  qty: twoDp(0, 9_999_999_999.99),
  unit: z.string().trim().max(30),
  unitPrice: twoDp(0, QUOTE_MAX_AMOUNT),
  discount: percent,
});
export type LineInput = z.infer<typeof LineInput>;

/**
 * Editing a quotation: the header fields printed on the PDF and, when given, the whole list of lines (replaces the
 * working copy). `updatedAt` is the version the editor loaded (409 when stale). Status changes have their own routes.
 */
export const QuotationUpdate = z.object({
  /** One of the company's leads, or null to clear (the API checks it belongs to the quotation's company). */
  leadId: id.nullable().optional(),
  contactId: id.nullable().optional(),
  quotationDate: isoDate.optional(),
  validUntil: isoDate.nullable().optional(),
  currency: z.enum(QUOTE_CURRENCIES).optional(),
  subject: z.string().trim().min(1).max(300).optional(),
  taxRate: percent.optional(),
  overallDiscount: percent.optional(),
  notes: z.string().max(NOTES_MAX).optional(),
  lines: z.array(LineInput).max(QUOTE_MAX_LINES)
    .refine((ls) => ls.reduce((s, l) => s + l.qty * l.unitPrice, 0) <= QUOTE_MAX_AMOUNT, 'total_too_large')
    .optional(),
  updatedAt: z.string().datetime(),
});
export type QuotationUpdate = z.infer<typeof QuotationUpdate>;

/** Settings → Company details (Administrators): the issuer block on every quotation and the defaults for new ones. */
export const CompanySettingsUpdate = z.object({
  legalName: z.string().trim().min(1).max(200),
  addressLines: z.array(z.string().trim().min(1).max(200)).max(8),
  email: z.string().trim().toLowerCase().max(255).email(),
  /** Printed only on INR quotations, and only when set. */
  gstin: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
    z.string().regex(/^[0-9A-Z]{15}$/, 'invalid_gstin').nullish(),
  ),
  taxInr: percent,
  taxUsd: percent,
  taxCad: percent,
  defaultNotes: z.string().max(NOTES_MAX),
});
export type CompanySettingsUpdate = z.infer<typeof CompanySettingsUpdate>;

/** Quotations list tabs (prototype V.quotes): sent = Sent + Negotiating, closed = Rejected + Expired. */
export const QUOTE_TABS = ['all', 'draft', 'sent', 'accepted', 'closed'] as const;
export type QuoteTab = (typeof QUOTE_TABS)[number];

/** `GET /quotations`: the tab and a search over number, company, lead number and subject. */
export const QuotationListQuery = z.object({
  tab: z.enum(QUOTE_TABS).default('all'),
  s: z.string().trim().max(200).optional(),
});
export type QuotationListQuery = z.infer<typeof QuotationListQuery>;

/**
 * Accept / reject. While revision n+1 has unsent edits the client must confirm they are discarded
 * (`discardUnsent: true`, else 409 `unsent_changes`): the answer is to what the client received.
 */
export const QuotationDecision = z.object({ discardUnsent: z.boolean().optional() });
export type QuotationDecision = z.infer<typeof QuotationDecision>;

/** `POST /quotations/:id/send`: the message the user edited in the send dialog (empty or absent = the default). */
export const QuotationSend = z.object({ body: z.string().trim().max(20000).optional() });
export type QuotationSend = z.infer<typeof QuotationSend>;
