import { Prisma, type PrismaClient, type Quotation } from '@prisma/client';
import {
  COMPANY_SETTINGS_DEFAULTS, QUOTE_CURRENCIES, QUOTE_MAX_AMOUNT, defaultCurrency, defaultTaxRate, formatMoney, isQuoteLocked, quoteTotals, round2,
  type LineInput, type QuoteCurrency, type QuoteTotals, type QuotationCreate, type QuotationUpdate,
} from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { audit } from '../audit.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { StaleError } from '../prismaErrors.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import { assertLeadVisible, leadWhere } from '../leads/visibility.js';
import { RuleError, applyStatusChange } from '../leads/service.js';
import { notifyUser } from '../leads/notify.js';
import { dateOnly, todayIn, ymd } from '../leads/dates.js';
import { nextQuotationNumber } from './number.js';
import { canEditQuotation, quotationWhere } from './visibility.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

const DAY_MS = 86_400_000;
/** Days from the quotation date to "valid until" on a new quotation (prototype). */
const VALID_DAYS = 30;
/** Statuses that answer to a send: editing them opens the next revision. */
const SENT_STATUSES = new Set(['Sent', 'Negotiating']);

/* ------------------------------------------------------------------ Company details */

export interface CompanySettingsValues {
  legalName: string;
  addressLines: string[];
  email: string;
  gstin: string | null;
  taxInr: number;
  taxUsd: number;
  taxCad: number;
  defaultNotes: string;
}

/** Settings → Company details (row id 1), or the seeded defaults when the row is missing (e.g. after a test reset). */
export async function loadCompanySettings(db: Db): Promise<CompanySettingsValues> {
  const row = await db.companySettings.findUnique({ where: { id: 1 } });
  if (!row) return { ...COMPANY_SETTINGS_DEFAULTS, addressLines: [...COMPANY_SETTINGS_DEFAULTS.addressLines] };
  return {
    legalName: row.legalName,
    addressLines: Array.isArray(row.addressLines) ? row.addressLines.map(String) : [],
    email: row.email,
    gstin: row.gstin,
    taxInr: Number(row.taxInr),
    taxUsd: Number(row.taxUsd),
    taxCad: Number(row.taxCad),
    defaultNotes: row.defaultNotes,
  };
}

/* ------------------------------------------------------------------ history */

export type HistoryEntry = { at: string; text: string };

const historyOf = (q: Pick<Quotation, 'history'>): HistoryEntry[] => (Array.isArray(q.history) ? (q.history as HistoryEntry[]) : []);

/** The quotation's history with `texts` appended (oldest first), as stored in the Json column. */
export function appendHistory(q: Pick<Quotation, 'history'>, ...texts: string[]): Prisma.InputJsonValue {
  const at = new Date().toISOString();
  return [...historyOf(q), ...texts.map((text) => ({ at, text }))];
}

/* ------------------------------------------------------------------ snapshot */

export interface SnapshotLine {
  item: string;
  description: string | null;
  qty: number;
  unit: string;
  unitPrice: number;
  discount: number;
  /** qty × price less the line discount, rounded as quoteTotals rounds it. */
  total: number;
}

/**
 * Everything printed on the PDF, as it stood: the header, the lines, the totals and the company / contact display
 * fields. Frozen into `quotation_revisions.snapshot` when a revision is sent (Task 4); a discard restores from it.
 */
export interface QuotationSnapshot {
  number: string;
  revision: number;
  quotationDate: string;
  validUntil: string | null;
  currency: QuoteCurrency;
  subject: string;
  taxRate: number;
  overallDiscount: number;
  notes: string;
  companyId: number;
  contactId: number | null;
  leadId: number | null;
  company: { name: string; legalName: string | null; street: string | null; city: string | null; state: string | null; zip: string | null; country: string };
  contact: { name: string; email: string | null } | null;
  lines: SnapshotLine[];
  totals: QuoteTotals;
  /**
   * The issuer block (Company details) as it stood when the revision was sent; absent on a working copy, whose PDF
   * uses the current Company details.
   */
  issuer?: SnapshotIssuer;
}

export type SnapshotIssuer = Pick<CompanySettingsValues, 'legalName' | 'addressLines' | 'email' | 'gstin'>;

type LineLike = { qty: Prisma.Decimal | number; unitPrice: Prisma.Decimal | number; discount: Prisma.Decimal | number };

const totalsOf = (q: { lines: LineLike[]; overallDiscount: Prisma.Decimal | number; taxRate: Prisma.Decimal | number }): QuoteTotals =>
  quoteTotals({ lines: q.lines.map((l) => ({ qty: l.qty, price: l.unitPrice, discount: l.discount })), overallDiscount: q.overallDiscount, taxRate: q.taxRate });

/**
 * True when a figure stored on a sent revision (subtotal, discounts, GST, total including GST) would not fit the
 * Decimal(14,2) money columns.
 */
export const exceedsAmountCap = (t: QuoteTotals): boolean =>
  [t.sub, t.disc + t.overall, t.tax, t.total].some((v) => v > QUOTE_MAX_AMOUNT);

function lineTotal(l: LineLike): number {
  const gross = round2(Number(l.qty) * Number(l.unitPrice));
  return round2(gross - round2(gross * Number(l.discount) / 100));
}

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();

/** The working copy of quotation `id` as a snapshot. */
export async function quotationSnapshot(db: Db, id: number): Promise<QuotationSnapshot> {
  const q = await db.quotation.findUniqueOrThrow({
    where: { id },
    include: {
      lines: { orderBy: { sortOrder: 'asc' } },
      company: { select: { name: true, legalName: true, street: true, city: true, state: true, zip: true, country: true } },
      contact: { select: { firstName: true, lastName: true, businessEmail: true } },
    },
  });
  return {
    number: q.number,
    revision: q.revision,
    quotationDate: ymd(q.quotationDate)!,
    validUntil: ymd(q.validUntil),
    currency: q.currency as QuoteCurrency,
    subject: q.subject,
    taxRate: Number(q.taxRate),
    overallDiscount: Number(q.overallDiscount),
    notes: q.notes,
    companyId: q.companyId,
    contactId: q.contactId,
    leadId: q.leadId,
    company: q.company,
    contact: q.contact ? { name: fullName(q.contact), email: q.contact.businessEmail } : null,
    lines: q.lines.map((l) => ({
      item: l.item, description: l.description, qty: Number(l.qty), unit: l.unit, unitPrice: Number(l.unitPrice), discount: Number(l.discount),
      total: lineTotal(l),
    })),
    totals: totalsOf(q),
  };
}

/* ------------------------------------------------------------------ serializers */

const person = { select: { id: true, name: true } } as const;

export const quotationInclude = {
  company: { select: { id: true, number: true, name: true, legalName: true, country: true } },
  contact: { select: { id: true, firstName: true, lastName: true, businessEmail: true } },
  lead: { select: { id: true, number: true, status: true, assignedToId: true } },
  // The owner's language: the PDF and the send dialog's default message are written in it.
  owner: { select: { id: true, name: true, language: true } },
  lines: { orderBy: { sortOrder: 'asc' } },
  revisions: { orderBy: { revisionNo: 'asc' } },
  // Release 3B: the project made from or linked to it (the editor shows it instead of Convert to project).
  project: { select: { id: true, number: true, name: true } },
} satisfies Prisma.QuotationInclude;

type QuotationRow = Prisma.QuotationGetPayload<{ include: typeof quotationInclude }>;
type RevisionRow = QuotationRow['revisions'][number];

/** The figures shown outside the editor: the last sent revision's while revision n+1 is unsent, else the working copy's. */
export type DisplayTotals = QuoteTotals & { currency: QuoteCurrency };

function displayTotals(q: { editingNewRevision: boolean; currency: string; revisions: Pick<RevisionRow, 'revisionNo' | 'snapshot'>[] }, working: QuoteTotals): DisplayTotals {
  const last = q.editingNewRevision ? q.revisions.reduce<typeof q.revisions[number] | null>((a, r) => (!a || r.revisionNo > a.revisionNo ? r : a), null) : null;
  const snap = last?.snapshot as Partial<QuotationSnapshot> | null | undefined;
  if (snap?.totals) return { ...snap.totals, currency: (snap.currency ?? q.currency) as QuoteCurrency };
  return { ...working, currency: q.currency as QuoteCurrency };
}

const contactRef = (c: QuotationRow['contact']) => (c ? { id: c.id, name: fullName(c), email: c.businessEmail } : null);
const leadRef = (l: QuotationRow['lead']) => (l ? { id: l.id, number: l.number, status: l.status } : null);

/** The editor's view of a quotation. */
export function quotationDetail(q: QuotationRow, user: AuthUser) {
  const totals = totalsOf(q);
  const locked = isQuoteLocked(q.status);
  const sending = q.sendingMessageId !== null;
  return {
    id: q.id,
    number: q.number,
    status: q.status,
    revision: q.revision,
    editingNewRevision: q.editingNewRevision,
    locked,
    sending,
    canEdit: !locked && !sending && canEditQuotation(user, q),
    /** Convert to project: an Accepted quotation with no project, for those who may edit it. */
    canConvert: q.status === 'Accepted' && q.projectId === null && canEditQuotation(user, q),
    company: q.company,
    contact: contactRef(q.contact),
    lead: leadRef(q.lead),
    owner: q.owner,
    quotationDate: ymd(q.quotationDate),
    validUntil: ymd(q.validUntil),
    currency: q.currency,
    subject: q.subject,
    taxRate: Number(q.taxRate),
    overallDiscount: Number(q.overallDiscount),
    notes: q.notes,
    projectId: q.projectId,
    project: q.project,
    lines: q.lines.map((l) => ({
      id: l.id, sortOrder: l.sortOrder, item: l.item, description: l.description, qty: Number(l.qty), unit: l.unit,
      unitPrice: Number(l.unitPrice), discount: Number(l.discount), total: lineTotal(l),
    })),
    totals,
    displayTotals: displayTotals(q, totals),
    revisions: q.revisions.map((r) => ({
      revisionNo: r.revisionNo, sentAt: r.sentAt.toISOString(), sentTo: r.sentTo, subtotal: Number(r.subtotal),
      discountTotal: Number(r.discountTotal), taxTotal: Number(r.taxTotal), grandTotal: Number(r.grandTotal), note: r.note,
      currency: ((r.snapshot as Partial<QuotationSnapshot> | null)?.currency ?? q.currency) as QuoteCurrency,
    })),
    history: historyOf(q),
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

export const quotationListInclude = {
  company: { select: { id: true, number: true, name: true, legalName: true } },
  contact: { select: { id: true, firstName: true, lastName: true, businessEmail: true } },
  lead: { select: { id: true, number: true, status: true, assignedToId: true } },
  owner: person,
  lines: { select: { qty: true, unitPrice: true, discount: true } },
  revisions: { select: { revisionNo: true, snapshot: true }, orderBy: { revisionNo: 'desc' }, take: 1 },
} satisfies Prisma.QuotationInclude;

type ListRow = Prisma.QuotationGetPayload<{ include: typeof quotationListInclude }>;

/** A Quotations list row; `total` / `currency` are the display figures. `today` is the viewer's date. */
export function quotationListItem(q: ListRow, today: string) {
  const shown = displayTotals(q, totalsOf(q));
  const validUntil = ymd(q.validUntil);
  return {
    id: q.id,
    number: q.number,
    status: q.status,
    revision: q.revision,
    editingNewRevision: q.editingNewRevision,
    company: q.company,
    contact: q.contact ? { id: q.contact.id, name: fullName(q.contact) } : null,
    lead: leadRef(q.lead),
    owner: q.owner,
    quotationDate: ymd(q.quotationDate),
    validUntil,
    subject: q.subject,
    currency: shown.currency,
    total: shown.total,
    projectId: q.projectId,
    expiringSoon: SENT_STATUSES.has(q.status) && validUntil !== null && validUntil <= addDays(today, 7),
  };
}

/** `ymd` + `days`. */
export const addDays = (ymdDate: string, days: number): string => new Date(dateOnly(ymdDate).getTime() + days * DAY_MS).toISOString().slice(0, 10);

/** Display totals summed per currency (USD, CAD, INR order), for the list tiles. */
export function sumsByCurrency(items: { currency: QuoteCurrency; total: number }[]): { currency: QuoteCurrency; amount: number }[] {
  return QUOTE_CURRENCIES.flatMap((currency) => {
    const of = items.filter((i) => i.currency === currency);
    return of.length ? [{ currency, amount: round2(of.reduce((s, i) => s + i.total, 0)) }] : [];
  });
}

/* ------------------------------------------------------------------ loading for a write */

/** The visible quotation, locked FOR UPDATE and re-read (NotFoundError → 404 when absent or hidden). */
export async function lockVisibleQuotation(tx: Tx, user: AuthUser, id: number): Promise<QuotationRow> {
  const visible = Number.isInteger(id) ? await tx.quotation.findFirst({ where: { AND: [{ id }, quotationWhere(user)] }, select: { id: true } }) : null;
  if (!visible) throw new NotFoundError();
  await tx.$queryRaw`SELECT id FROM quotations WHERE id = ${id} FOR UPDATE`;
  return tx.quotation.findUniqueOrThrow({ where: { id }, include: quotationInclude });
}

/**
 * The visible quotation the user may change: 403 `forbidden` without edit rights, 409 `locked` once Accepted /
 * Rejected / Expired, 409 `sending` while a send is queued, 409 `stale` when `updatedAt` (if given) has moved on.
 */
export async function editableQuotation(tx: Tx, user: AuthUser, id: number, updatedAt?: string): Promise<QuotationRow> {
  const q = await lockVisibleQuotation(tx, user, id);
  if (!canEditQuotation(user, q)) throw new RuleError('forbidden');
  if (isQuoteLocked(q.status)) throw new RuleError('locked');
  if (q.sendingMessageId !== null) throw new RuleError('sending');
  if (updatedAt !== undefined && new Date(updatedAt).getTime() !== q.updatedAt.getTime()) throw new StaleError();
  return q;
}

/* ------------------------------------------------------------------ create / duplicate */

const lineData = (lines: Omit<SnapshotLine, 'total'>[] | LineInput[]) =>
  lines.map((l, i) => ({
    sortOrder: i, item: l.item, description: l.description ?? null, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, discount: l.discount,
  }));

/** Writes the "Quotation drafted" timeline entry on the lead and audits the new quotation. */
async function recordCreated(tx: Tx, user: AuthUser, q: Quotation): Promise<void> {
  if (q.leadId !== null) {
    await tx.leadActivity.create({
      data: {
        leadId: q.leadId, activityType: 'quote', title: `Quotation drafted · ${q.number}`, body: q.subject,
        relatedType: 'quotation', relatedId: q.id, byUserId: user.id,
      },
    });
  }
  await audit(tx, { entityType: 'quotation', entityId: q.id, action: 'create', userId: user.id, after: q });
}

/** An active contact of the company, else 400 on `field`. */
async function assertCompanyContact(tx: Tx, companyId: number, contactId: number, field = 'contactId'): Promise<void> {
  const ok = (await tx.contact.count({ where: { id: contactId, companyId, isActive: true } })) > 0;
  if (!ok) throw new ValidationError([{ path: [field], message: 'Contact must be an active contact of the company' }]);
}

/**
 * "New quotation" with the spec defaults: contact = given, else the lead's, else the company's primary; currency from
 * the company's country; GST % and notes from Company details; dated today in the user's time zone, valid 30 days;
 * one "Consulting services" line. With a lead it must be visible and the company's; without one the company must be
 * visible. The lead is never picked automatically: the client passes the one the user chose.
 */
export async function createQuotation(tx: Tx, user: AuthUser, body: QuotationCreate): Promise<number> {
  let leadContactId: number | null = null;
  let leadId: number | null = null;
  if (body.leadId !== undefined) {
    const lead = await assertLeadVisible(tx, user, body.leadId);
    if (lead.companyId !== body.companyId) throw new ValidationError([{ path: ['leadId'], message: 'Lead must belong to the company' }]);
    leadId = lead.id;
    leadContactId = lead.contactId;
  } else {
    await assertCompanyVisible(tx, user, body.companyId);
  }
  const company = await tx.company.findUniqueOrThrow({ where: { id: body.companyId } });

  let contactId: number | null = null;
  if (body.contactId !== undefined) {
    await assertCompanyContact(tx, company.id, body.contactId);
    contactId = body.contactId;
  } else {
    const fromLead = leadContactId === null
      ? null
      : await tx.contact.findFirst({ where: { id: leadContactId, companyId: company.id, isActive: true }, select: { id: true } });
    contactId = fromLead?.id
      ?? (await tx.contact.findFirst({ where: { companyId: company.id, isPrimary: true, isActive: true }, select: { id: true } }))?.id
      ?? null;
  }

  const settings = await loadCompanySettings(tx);
  const currency = defaultCurrency(company.country);
  const today = todayIn(user.timezone);
  const quotationDate = dateOnly(today);
  const number = await nextQuotationNumber(tx, quotationDate);
  const q = await tx.quotation.create({
    data: {
      number, companyId: company.id, contactId, leadId, ownerId: user.id, quotationDate, validUntil: dateOnly(addDays(today, VALID_DAYS)),
      currency, subject: `Advisory services for ${company.name}`, taxRate: defaultTaxRate(currency, settings), overallDiscount: 0,
      notes: settings.defaultNotes, history: appendHistory({ history: [] }, `Draft created by ${user.name}`),
      lines: { create: lineData([{ item: 'Consulting services', description: null, qty: 1, unit: 'project', unitPrice: 0, discount: 0 }]) },
    },
  });
  await recordCreated(tx, user, q);
  return q.id;
}

/**
 * Duplicate (allowed in every status): a new Draft owned by the user, numbered and dated today, valid 30 days, with
 * the same company, contact, lead, currency, GST %, overall discount, notes and working-copy lines; subject + " (copy)".
 */
export async function duplicateQuotation(tx: Tx, user: AuthUser, id: number): Promise<number> {
  const src = await lockVisibleQuotation(tx, user, id);
  const today = todayIn(user.timezone);
  const quotationDate = dateOnly(today);
  const number = await nextQuotationNumber(tx, quotationDate);
  const q = await tx.quotation.create({
    data: {
      number, companyId: src.companyId, contactId: src.contactId, leadId: src.leadId, ownerId: user.id, quotationDate,
      validUntil: dateOnly(addDays(today, VALID_DAYS)), currency: src.currency, subject: `${src.subject} (copy)`.slice(0, 300),
      taxRate: src.taxRate, overallDiscount: src.overallDiscount, notes: src.notes,
      history: appendHistory({ history: [] }, `Draft created by ${user.name} · copy of ${src.number}`),
      lines: {
        create: lineData(src.lines.map((l) => ({
          item: l.item, description: l.description, qty: Number(l.qty), unit: l.unit, unitPrice: Number(l.unitPrice), discount: Number(l.discount),
        }))),
      },
    },
  });
  await recordCreated(tx, user, q);
  return q.id;
}

/* ------------------------------------------------------------------ edit */

const sameLines = (a: QuotationRow['lines'], b: LineInput[]): boolean =>
  a.length === b.length && a.every((l, i) => {
    const n = b[i]!;
    return l.item === n.item && (l.description ?? null) === (n.description ?? null) && Number(l.qty) === n.qty && l.unit === n.unit
      && Number(l.unitPrice) === n.unitPrice && Number(l.discount) === n.discount;
  });

/**
 * Applies an editor save. Changing the currency resets GST % to that currency's default unless the same save sets it.
 * A new lead must be the company's and visible to the user; a new contact an active contact of the company (400).
 * On a Sent / Negotiating quotation the first change to anything printed on the PDF opens revision n+1 (once, until
 * it is sent). The number is fixed at creation: moving the date into another year keeps it.
 */
export async function updateQuotation(tx: Tx, user: AuthUser, id: number, input: QuotationUpdate): Promise<void> {
  const { updatedAt, lines, ...body } = input;
  const q = await editableQuotation(tx, user, id, updatedAt);
  const data: Prisma.QuotationUncheckedUpdateInput = {};
  let printed = false;

  if (body.leadId !== undefined && body.leadId !== q.leadId) {
    if (body.leadId !== null) {
      const lead = await tx.lead.findFirst({ where: { AND: [{ id: body.leadId, companyId: q.companyId }, leadWhere(user)] }, select: { id: true } });
      if (!lead) throw new ValidationError([{ path: ['leadId'], message: 'Lead must be a visible lead of the company' }]);
    }
    data.leadId = body.leadId;
  }
  if (body.contactId !== undefined && body.contactId !== q.contactId) {
    if (body.contactId !== null) await assertCompanyContact(tx, q.companyId, body.contactId);
    data.contactId = body.contactId;
    printed = true;
  }
  if (body.quotationDate !== undefined && body.quotationDate !== ymd(q.quotationDate)) {
    data.quotationDate = dateOnly(body.quotationDate);
    printed = true;
  }
  if (body.validUntil !== undefined && body.validUntil !== ymd(q.validUntil)) {
    data.validUntil = body.validUntil === null ? null : dateOnly(body.validUntil);
    printed = true;
  }
  let taxRate = body.taxRate;
  if (body.currency !== undefined && body.currency !== q.currency) {
    data.currency = body.currency;
    taxRate ??= defaultTaxRate(body.currency, await loadCompanySettings(tx));
    printed = true;
  }
  if (taxRate !== undefined && taxRate !== Number(q.taxRate)) {
    data.taxRate = taxRate;
    printed = true;
  }
  if (body.overallDiscount !== undefined && body.overallDiscount !== Number(q.overallDiscount)) {
    data.overallDiscount = body.overallDiscount;
    printed = true;
  }
  if (body.subject !== undefined && body.subject !== q.subject) {
    data.subject = body.subject;
    printed = true;
  }
  if (body.notes !== undefined && body.notes !== q.notes) {
    data.notes = body.notes;
    printed = true;
  }
  const linesChanged = lines !== undefined && !sameLines(q.lines, lines);
  // The totals after this save, GST included, must fit the revision's Decimal(14,2) columns, or a send could leave
  // the client's inbox and then fail to be recorded.
  const next = quoteTotals({
    lines: (linesChanged ? lines : q.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discount: l.discount })))
      .map((l) => ({ qty: l.qty, price: l.unitPrice, discount: l.discount })),
    overallDiscount: body.overallDiscount ?? q.overallDiscount,
    taxRate: taxRate ?? q.taxRate,
  });
  if (exceedsAmountCap(next)) throw new ValidationError([{ path: ['lines'], message: 'total_too_large' }]);
  if (linesChanged) {
    await tx.quotationLine.deleteMany({ where: { quotationId: q.id } });
    await tx.quotationLine.createMany({ data: lineData(lines).map((l) => ({ ...l, quotationId: q.id })) });
    printed = true;
  }
  if (printed && SENT_STATUSES.has(q.status) && !q.editingNewRevision) {
    data.editingNewRevision = true;
    data.revision = q.revision + 1;
    data.history = appendHistory(q, `Revision ${q.revision + 1} opened for editing`);
  }
  // Always written, so a lines-only save moves updatedAt too (the next save's stale check).
  const after = await tx.quotation.update({ where: { id: q.id }, data: { ...data, updatedAt: new Date() } });
  const { lines: _l, revisions: _r, history: _h, ...before } = q;
  await audit(tx, {
    entityType: 'quotation', entityId: q.id, action: 'update', userId: user.id, before: { ...before, lines: linesChanged ? q.lines : undefined },
    after: { ...after, history: undefined, lines: linesChanged ? lines : undefined },
  });
}

/* ------------------------------------------------------------------ status */

/**
 * Throws away unsent revision n+1: header and lines go back to the last sent snapshot and the revision number back to
 * it. Without a sent revision row (none can exist before sending is built) only the flag and number go back. The
 * snapshot's contact comes back only while it is still an active contact of the company; otherwise none.
 */
async function discardUnsent(tx: Tx, q: QuotationRow): Promise<Prisma.QuotationUncheckedUpdateInput> {
  const last = q.revisions.at(-1);
  const discarded = `Revision ${q.revision} discarded (unsent changes)`;
  if (!last) return { editingNewRevision: false, revision: Math.max(1, q.revision - 1), history: appendHistory(q, discarded) };
  const snap = last.snapshot as unknown as QuotationSnapshot;
  await tx.quotationLine.deleteMany({ where: { quotationId: q.id } });
  await tx.quotationLine.createMany({ data: lineData(snap.lines).map((l) => ({ ...l, quotationId: q.id })) });
  const contactOk = snap.contactId !== null && (await tx.contact.count({ where: { id: snap.contactId, companyId: q.companyId, isActive: true } })) > 0;
  return {
    editingNewRevision: false,
    revision: last.revisionNo,
    quotationDate: dateOnly(snap.quotationDate),
    validUntil: snap.validUntil ? dateOnly(snap.validUntil) : null,
    currency: snap.currency,
    subject: snap.subject,
    taxRate: snap.taxRate,
    overallDiscount: snap.overallDiscount,
    notes: snap.notes,
    contactId: contactOk ? snap.contactId : null,
    history: appendHistory(q, discarded),
  };
}

/** Sent → Negotiating ("Mark negotiating"; there is no way back). 409 `invalid_transition` from any other status. */
export async function markNegotiating(tx: Tx, user: AuthUser, id: number): Promise<void> {
  const q = await editableQuotation(tx, user, id);
  if (q.status !== 'Sent') throw new RuleError('invalid_transition');
  await tx.quotation.update({ where: { id }, data: { status: 'Negotiating', history: appendHistory(q, `Negotiating · by ${user.name}`) } });
  await audit(tx, { entityType: 'quotation', entityId: id, action: 'update', userId: user.id, before: { status: q.status }, after: { status: 'Negotiating' } });
}

/**
 * Accept or reject a Draft / Sent / Negotiating quotation. With unsent revision n+1 the caller must pass
 * `discard: true` (else 409 `unsent_changes`): the answer is to what the client received. Accept moves the lead to
 * Won (existing rules), flags the company as a client (with or without a lead), notifies the owner and writes the
 * timeline entry. Reject writes the timeline entry only: the lead's status is never changed.
 */
export async function decideQuotation(tx: Tx, user: AuthUser, id: number, to: 'Accepted' | 'Rejected', discard: boolean): Promise<void> {
  const q = await editableQuotation(tx, user, id);
  let data: Prisma.QuotationUncheckedUpdateInput = {};
  let current: Pick<Quotation, 'history'> = q;
  if (q.editingNewRevision) {
    if (!discard) throw new RuleError('unsent_changes');
    data = await discardUnsent(tx, q);
    current = { history: data.history as Prisma.JsonValue };
  }
  const verb = to === 'Accepted' ? 'accepted' : 'rejected';
  const updated = await tx.quotation.update({
    where: { id }, data: { ...data, status: to, history: appendHistory(current, `${to} · by ${user.name}`) },
    include: { lines: true },
  });
  const total = formatMoney(totalsOf(updated).total, updated.currency as QuoteCurrency);

  if (updated.leadId !== null) {
    await tx.leadActivity.create({
      data: {
        leadId: updated.leadId, activityType: 'quote', title: `Quotation ${verb} · ${q.number}`, body: total,
        relatedType: 'quotation', relatedId: id, byUserId: user.id,
      },
    });
  }
  if (to === 'Accepted') {
    if (updated.leadId !== null) {
      // Lock order everywhere: quotation, then lead.
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${updated.leadId} FOR UPDATE`;
      const lead = await tx.lead.findUniqueOrThrow({ where: { id: updated.leadId } });
      // No source text: the "Quotation accepted" line just above already says why (one line, not two alike).
      const won = await applyStatusChange(tx, lead, 'Won', { userId: user.id });
      if (won.status !== lead.status) {
        await audit(tx, { entityType: 'lead', entityId: lead.id, action: 'update', userId: user.id, before: { status: lead.status }, after: { status: won.status } });
      }
    }
    await tx.company.update({ where: { id: q.companyId }, data: { isClient: true } });
    await notifyUser(tx, q.ownerId, `Quotation accepted · ${q.number} · ${total}`, 'Convert to project?', `/quotations/${id}`);
  }
  await audit(tx, { entityType: 'quotation', entityId: id, action: 'update', userId: user.id, before: { status: q.status }, after: { status: to } });
}
