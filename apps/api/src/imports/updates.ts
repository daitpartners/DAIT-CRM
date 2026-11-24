/**
 * Update rows (owner, 24 Nov 2026: "Download all leads", add what is missing, upload it again through Import leads): a
 * row carrying a Lead ID (LD-n) and / or a Company ID (CO-n) the uploader can see fills that lead's, its company's and
 * its contact's EMPTY fields only. Decided:
 *
 * - CRM empty and the file has a value → filled (same field mapping as a new import), audited like a manual edit with
 *   the source "Import · IMPORT-…";
 * - CRM has a value and the file's is the same (normalised) → nothing; CRM has another value → NOT changed, recorded as
 *   a conflict (rows-to-fix: "CRM has …, file has …");
 * - a verified company field (release-4 golden rule) is never touched: a different value is a conflict too;
 * - an unknown or not-visible Lead ID / Company ID, or a Company ID that is not the lead's company → the row is an error,
 *   never a new lead. The read-only columns of the download (Status, Assigned to, …) are never read.
 *
 * Each field compares against the value the download shows (the first non-empty of its targets: e.g. Website = the
 * lead's, else the company's); when that is empty every empty target is filled.
 */
import type { Company, Contact, Lead, Prisma, PrismaClient } from '@prisma/client';
import {
  IMPORT_FIELDS, domainOf, importSource, normalisePhone,
  type ImportField, type RowChanges, type RowFields, type RowProblem, type UpdateConflict, type UpdateErrorCode, type UpdateFill,
} from '@dait-crm/shared';
import { audit } from '../audit.js';
import { companyWhere } from '../companies/visibility.js';
import { leadWhere } from '../leads/visibility.js';
import type { AuthUser } from '../plugins/auth.js';
import { verificationStatus } from '../research/service.js';
import { matchCountry } from './countries.js';

type Db = Prisma.TransactionClient | PrismaClient;
type Tx = Prisma.TransactionClient;

const has = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const clean = (v: string | null | undefined): string | null => (has(v) ? v.trim() : null);
const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
/** A link the CRM can open: a bare host gets https:// (as the lead form does). */
const withScheme = (v: string): string => (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'sr', 'sra', 'srta', 'm', 'mme', 'mlle', 'prof']);

/** A person's name for comparing: lower case, no accents, no leading title, letters only (commit.ts's rule). */
function personKey(s: string): string {
  const words = stripAccents(s).toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (words.length > 1 && HONORIFICS.has(words[0]!)) words.shift();
  return words.join(' ');
}

/** "LD-1001" from "ld 1001", "LD1001"; null when the cell is not a lead number. */
export function leadNumberOf(v: string | undefined): string | null {
  const m = /^LD[-\s]?0*(\d+)$/i.exec((v ?? '').trim());
  return m ? `LD-${m[1]}` : null;
}

/** "CO-0042" from "co-42", "CO0042"; null when the cell is not a company number. */
export function companyNumberOf(v: string | undefined): string | null {
  const m = /^CO[-\s]?0*(\d+)$/i.exec((v ?? '').trim());
  return m ? `CO-${m[1]!.padStart(4, '0')}` : null;
}

/**
 * A row that carries a CRM Lead ID (LD-n) or Company ID (CO-n): it is an update row, or an error, never a new lead. A
 * cell in another form (another system's "Company ID" such as 4567) is not one of the CRM's ids and is left out.
 */
export const isUpdateRow = (f: RowFields): boolean => leadNumberOf(f.leadId) !== null || companyNumberOf(f.companyId) !== null;

export type UpdateTarget =
  | { kind: 'update'; leadId: number | null; leadNumber: string | null; companyId: number; companyNumber: string }
  | { kind: 'error'; code: UpdateErrorCode; value: string; crm?: string };

/** The id problem of an error target, as a row problem (red, no cell). */
export const targetProblem = (t: Extract<UpdateTarget, { kind: 'error' }>): RowProblem =>
  ({ code: t.code, level: 'missing', value: t.value, ...(t.crm !== undefined ? { crm: t.crm } : {}) });

/**
 * Each row's update target (null for a row with no Lead ID or Company ID), as `user` sees the CRM: a lead counts when
 * the user may see it (archived ones included), a company when the user may see it. Two queries.
 */
export async function resolveTargets(db: Db, user: AuthUser | null, list: readonly RowFields[]): Promise<(UpdateTarget | null)[]> {
  const leadNumbers = [...new Set(list.map((f) => leadNumberOf(f.leadId)).filter((n): n is string => n !== null))];
  const companyNumbers = [...new Set(list.map((f) => companyNumberOf(f.companyId)).filter((n): n is string => n !== null))];
  const leads = user && leadNumbers.length > 0
    ? await db.lead.findMany({
      where: { AND: [{ number: { in: leadNumbers } }, leadWhere(user, { includeArchived: true })] },
      select: { id: true, number: true, companyId: true, company: { select: { id: true, number: true } } },
    })
    : [];
  const companies = user && companyNumbers.length > 0
    ? await db.company.findMany({ where: { number: { in: companyNumbers }, ...companyWhere(user) }, select: { id: true, number: true } })
    : [];
  const leadBy = new Map(leads.map((l) => [l.number, l]));
  const companyBy = new Map(companies.map((c) => [c.number, c]));
  return list.map((f): UpdateTarget | null => {
    if (!isUpdateRow(f)) return null;
    const leadCell = leadNumberOf(f.leadId) ? clean(f.leadId) : null;
    const companyCell = companyNumberOf(f.companyId) ? clean(f.companyId) : null;
    if (leadCell) {
      const lead = leadBy.get(leadNumberOf(leadCell) ?? '');
      if (!lead) return { kind: 'error', code: 'lead_not_found', value: leadCell };
      if (companyCell && companyNumberOf(companyCell) !== lead.company?.number) {
        return { kind: 'error', code: 'company_mismatch', value: companyCell, crm: lead.company?.number ?? '—' };
      }
      if (!lead.company) return { kind: 'error', code: 'company_not_found', value: companyCell ?? leadCell };
      return { kind: 'update', leadId: lead.id, leadNumber: lead.number, companyId: lead.company.id, companyNumber: lead.company.number };
    }
    const company = companyBy.get(companyNumberOf(companyCell!) ?? '');
    if (!company) return { kind: 'error', code: 'company_not_found', value: companyCell! };
    return { kind: 'update', leadId: null, leadNumber: null, companyId: company.id, companyNumber: company.number };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing and planning one row

/** A website for comparing: lower case, no scheme, no www., no trailing slash. */
const siteKey = (v: string) => v.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const textKey = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();

/** Whether the CRM's value and the file's are the same once normalised. */
export function sameValue(field: ImportField, crm: string, file: string, known: readonly string[]): boolean {
  switch (field) {
    case 'website': return siteKey(crm) === siteKey(file);
    case 'email': return crm.trim().toLowerCase() === file.trim().toLowerCase();
    case 'phone': {
      const a = normalisePhone(crm);
      return a !== '' ? a === normalisePhone(file) : textKey(crm) === textKey(file);
    }
    case 'country': {
      const a = matchCountry(crm, known) ?? crm;
      const b = matchCountry(file, known) ?? file;
      return textKey(a) === textKey(b);
    }
    case 'contactName': return personKey(crm) === personKey(file);
    default: return textKey(crm) === textKey(file);
  }
}

export type UpdateRecords = { lead: Lead | null; company: Company; contact: Contact | null };
/** A planned fill: `source` = the file's field it comes from (one field may fill several records). */
export type PlannedFill = { entity: 'lead' | 'company' | 'contact'; field: string; value: string; source: ImportField };
export type NewContact = { firstName: string; lastName: string; designation: string | null; email: string | null; phone: string | null };
export type UpdatePlan = {
  fills: PlannedFill[];
  conflicts: UpdateConflict[];
  /** The lead has no contact and the file names one: link this contact of the company, or create one. */
  contact: { link: Contact } | { create: NewContact } | null;
};

const verifiedOf = (c: Company): Record<string, boolean> =>
  c.verifiedFields && typeof c.verifiedFields === 'object' && !Array.isArray(c.verifiedFields) ? (c.verifiedFields as Record<string, boolean>) : {};

/** First and last name from a full name: the last word is the last name; a leading title is dropped. */
export function splitPersonName(full: string): { firstName: string; lastName: string } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && HONORIFICS.has(stripAccents(words[0]!).toLowerCase().replace(/\.+$/, ''))) words.shift();
  if (words.length === 0) return { firstName: '', lastName: '' };
  if (words.length === 1) return { firstName: words[0]!, lastName: '' };
  return { firstName: words.slice(0, -1).join(' '), lastName: words[words.length - 1]! };
}

type Target = { entity: PlannedFill['entity']; field: string; current: string | null; locked: boolean };

/**
 * What an update row would do to these records (pure): per field of the file, the value the download shows is the first
 * non-empty target; empty → every empty, unlocked target is filled; the same → nothing; another → a conflict. `found` =
 * the company's contact with the row's email / name, when the lead has no contact (linked rather than duplicated).
 */
export function planUpdate(
  f: RowFields, r: UpdateRecords, ctx: { knownCountries: readonly string[]; industries: readonly string[]; found?: Contact | null },
): UpdatePlan {
  const fills: PlannedFill[] = [];
  const conflicts: UpdateConflict[] = [];
  const verified = verifiedOf(r.company);
  const co = (field: keyof Company): Target => ({
    entity: 'company', field, current: (r.company[field] as string | null) ?? null, locked: verified[field] === true,
  });
  const ld = (field: keyof Lead): Target[] => (r.lead ? [{ entity: 'lead', field, current: (r.lead[field] as string | null) ?? null, locked: false }] : []);

  // The contact: the lead's own, else (lead with a company, file naming a person) one found on the company or a new one.
  let contact: UpdatePlan['contact'] = null;
  let person: Contact | null = r.contact;
  const fileName = clean(f.contactName);
  if (r.lead && !r.contact && fileName) {
    if (ctx.found && ctx.found.isActive) {
      contact = { link: ctx.found };
      person = ctx.found;
      fills.push({ entity: 'lead', field: 'contactId', value: String(ctx.found.id), source: 'contactName' });
    } else if (!ctx.found) {
      const { firstName, lastName } = splitPersonName(fileName);
      if (firstName) {
        contact = {
          create: {
            firstName, lastName, designation: clean(f.designation), email: clean(f.email)?.toLowerCase() ?? null, phone: clean(f.phone),
          },
        };
      }
    }
  }
  const ct = (field: keyof Contact): Target[] =>
    (person ? [{ entity: 'contact', field, current: (person[field] as string | null) ?? null, locked: false }] : []);

  const targets: Partial<Record<ImportField, Target[]>> = {
    companyName: r.lead ? ld('companyName') : [co('name')],
    website: [...ld('website'), co('website')],
    country: [...ld('country'), co('country')],
    city: [...ld('city'), co('city')],
    designation: ct('designation'),
    email: [...ld('businessEmail'), ...ct('businessEmail')],
    phone: [...ld('phone'), ...ct('phone')],
    industry: [co('industry')],
    notes: ld('notes'),
  };

  for (const field of IMPORT_FIELDS) {
    const file = clean(f[field]);
    if (!file) continue;
    if (field === 'contactName') {
      // The lead's contact (or the one found and linked): its name is compared; a new contact is created above.
      const current = person ? `${person.firstName} ${person.lastName}`.trim() : '';
      if (current && !sameValue('contactName', current, file, ctx.knownCountries)) conflicts.push({ field, crm: current, file });
      continue;
    }
    const list = targets[field] ?? [];
    if (list.length === 0) continue;
    const shown = list.find((t) => has(t.current));
    if (shown) {
      if (!sameValue(field, shown.current!, file, ctx.knownCountries)) conflicts.push({ field, crm: shown.current!.trim(), file });
      continue;
    }
    if (field === 'industry') {
      const value = ctx.industries.find((v) => v.toLowerCase() === file.toLowerCase());
      if (!value) {
        conflicts.push({ field, crm: '', file, unknown: true });
        continue;
      }
      if (!list[0]!.locked) fills.push({ entity: 'company', field: 'industry', value, source: field });
      continue;
    }
    const value = field === 'website' ? withScheme(file) : field === 'email' ? file.toLowerCase() : file;
    for (const t of list) {
      if (t.locked) continue;
      // A company's email is its business mailbox: a person's address from a lead row never goes there.
      fills.push({ entity: t.entity, field: t.field, value, source: field });
    }
  }
  // A new contact never takes an email or phone the lead's differs from (that value is a conflict, not applied).
  if (contact && 'create' in contact) {
    const differs = (field: ImportField) => conflicts.some((c) => c.field === field);
    contact = {
      create: { ...contact.create, email: differs('email') ? null : contact.create.email, phone: differs('phone') ? null : contact.create.phone },
    };
  }
  return { fills, conflicts, contact };
}

/** The number of the row's fields an update fills (a field written on the lead and its company counts once). */
export function filledFieldCount(plan: UpdatePlan): number {
  const fields = new Set(plan.fills.map((p) => p.source));
  if (plan.contact && 'create' in plan.contact) {
    fields.add('contactName');
    if (plan.contact.create.designation) fields.add('designation');
  }
  return fields.size;
}

/** The conflicts of an update as rows-to-fix problems (amber cells, "CRM has …, file has …"). */
export function conflictProblems(conflicts: readonly UpdateConflict[]): RowProblem[] {
  return conflicts.map((c): RowProblem => (c.unknown
    ? { code: 'industry_unknown', field: c.field, level: 'questionable', value: c.file }
    : { code: 'update_conflict', field: c.field, level: 'questionable', crm: c.crm, value: c.file }));
}

/** The active `industry` lookup values. */
export async function industryValues(db: Db): Promise<string[]> {
  const rows = await db.lookupValue.findMany({ where: { group: 'industry', isActive: true }, select: { value: true } });
  return rows.map((r) => r.value);
}

/** The contact of `companyId` with this email (ignoring case), else with this full name; null when none. */
async function contactOnCompany(db: Db, companyId: number, email: string | null, name: string | null): Promise<Contact | null> {
  const contacts = await db.contact.findMany({ where: { companyId }, orderBy: { id: 'asc' } });
  const e = email?.trim().toLowerCase();
  if (e) {
    const byEmail = contacts.find((c) => c.businessEmail?.trim().toLowerCase() === e);
    if (byEmail) return byEmail;
  }
  const key = name ? personKey(name) : '';
  return key ? contacts.find((c) => personKey(`${c.firstName} ${c.lastName}`) === key) ?? null : null;
}

/** The records an update target points at (null when one went away meanwhile). */
async function recordsOf(db: Db, t: Extract<UpdateTarget, { kind: 'update' }>): Promise<UpdateRecords | null> {
  const company = await db.company.findUnique({ where: { id: t.companyId } });
  if (!company) return null;
  if (t.leadId === null) return { lead: null, company, contact: null };
  const lead = await db.lead.findUnique({ where: { id: t.leadId }, include: { contact: true } });
  if (!lead) return null;
  const { contact, ...plain } = lead;
  return { lead: plain, company, contact };
}

/** The contact an update row would link when its lead has none (or null). */
async function foundFor(db: Db, f: RowFields, r: UpdateRecords): Promise<Contact | null> {
  if (!r.lead || r.contact || !has(f.contactName)) return null;
  return contactOnCompany(db, r.company.id, clean(f.email), clean(f.contactName));
}

export type UpdatePreview = { fields: number; conflicts: UpdateConflict[]; leadId: number | null };

/**
 * What each update row would do now (step 4 totals, rows to fix before the import): the number of fields it fills and
 * its conflicts; null for a row that is not an update (or whose records went away).
 */
export async function previewUpdates(
  db: Db, user: AuthUser | null, rows: readonly RowFields[], known: readonly string[],
): Promise<(UpdatePreview | null)[]> {
  const targets = await resolveTargets(db, user, rows);
  if (!targets.some((t) => t?.kind === 'update')) return targets.map(() => null);
  const industries = await industryValues(db);
  const out: (UpdatePreview | null)[] = [];
  for (const [i, t] of targets.entries()) {
    if (t?.kind !== 'update') {
      out.push(null);
      continue;
    }
    const r = await recordsOf(db, t);
    if (!r) {
      out.push(null);
      continue;
    }
    const plan = planUpdate(rows[i]!, r, { knownCountries: known, industries, found: await foundFor(db, rows[i]!, r) });
    out.push({ fields: filledFieldCount(plan), conflicts: plan.conflicts, leadId: t.leadId });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Applying one row (inside the import job's per-row transaction)

export type UpdateResult =
  | { ok: true; leadId: number | null; companyId: number; contactId: number | null; changes: RowChanges }
  | { ok: false; code: UpdateErrorCode };

const pick = (rec: object, fields: string[]) =>
  Object.fromEntries(fields.map((k) => [k, (rec as Record<string, unknown>)[k] ?? null]));

/**
 * Applies an update row as `user` (the importer): the target is resolved again (visibility at import time), its records
 * are locked, then the planned blanks are filled (each record audited, source "Import · <batch>") and the row's changes
 * returned. Nothing is ever overwritten: the plan only fills empty, unverified fields.
 */
export async function applyUpdate(
  tx: Tx, fields: RowFields, batchNumber: string, ctx: { user: AuthUser; knownCountries: readonly string[] },
): Promise<UpdateResult> {
  const [target] = await resolveTargets(tx, ctx.user, [fields]);
  if (!target) return { ok: false, code: 'lead_not_found' };
  if (target.kind === 'error') return { ok: false, code: target.code };
  await tx.$queryRaw`SELECT id FROM companies WHERE id = ${target.companyId} FOR UPDATE`;
  if (target.leadId !== null) await tx.$queryRaw`SELECT id FROM leads WHERE id = ${target.leadId} FOR UPDATE`;
  const r = await recordsOf(tx, target);
  if (!r) return { ok: false, code: target.leadId !== null ? 'lead_not_found' : 'company_not_found' };
  if (r.contact) await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${r.contact.id} FOR UPDATE`;
  const found = await foundFor(tx, fields, r);
  const plan = planUpdate(fields, r, { knownCountries: ctx.knownCountries, industries: await industryValues(tx), found });
  const source = importSource(batchNumber);
  const filled: UpdateFill[] = [];
  let createdContact: RowChanges['createdContact'] = null;
  const by = (entity: PlannedFill['entity']) => plan.fills.filter((p) => p.entity === entity);

  // The contact first: a new one (on the lead's company) is linked to the lead below.
  let contactId: number | null = r.contact?.id ?? null;
  const leadData: Record<string, unknown> = {};
  if (plan.contact && 'link' in plan.contact) {
    contactId = plan.contact.link.id;
    await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${contactId} FOR UPDATE`;
  } else if (plan.contact && 'create' in plan.contact && r.lead) {
    const c = plan.contact.create;
    const created = await tx.contact.create({
      data: {
        companyId: r.company.id, firstName: c.firstName, lastName: c.lastName, designation: c.designation, businessEmail: c.email,
        phone: c.phone, phoneNormalised: normalisePhone(c.phone) || null,
      },
    });
    await audit(tx, { entityType: 'contact', entityId: created.id, action: 'create', userId: ctx.user.id, after: { ...created, source } });
    contactId = created.id;
    createdContact = { id: created.id, stamp: created.updatedAt.toISOString() };
    leadData.contactId = created.id;
    filled.push({ entity: 'lead', id: r.lead.id, field: 'contactId', value: created.id });
  }

  // The lead.
  if (r.lead) {
    for (const p of by('lead')) {
      const value = p.field === 'contactId' ? Number(p.value) : p.value;
      leadData[p.field] = value;
      filled.push({ entity: 'lead', id: r.lead.id, field: p.field, value });
    }
    if (Object.keys(leadData).length > 0) {
      const after = await tx.lead.update({ where: { id: r.lead.id }, data: leadData });
      const keys = Object.keys(leadData);
      await audit(tx, { entityType: 'lead', entityId: r.lead.id, action: 'update', userId: ctx.user.id, before: pick(r.lead, keys), after: { ...pick(after, keys), source } });
    }
  }

  // The company (website: also its domain, when no other company holds it; else the company's website stays empty).
  const companyData: Record<string, unknown> = {};
  for (const p of by('company')) {
    if (p.field === 'website' && r.company.domain === null) {
      const domain = domainOf(p.value);
      if (domain) {
        const holder = await tx.company.findFirst({ where: { domain, id: { not: r.company.id } }, select: { id: true } });
        if (holder) continue;
        companyData.domain = domain;
        filled.push({ entity: 'company', id: r.company.id, field: 'domain', value: domain });
      }
    }
    companyData[p.field] = p.value;
    filled.push({ entity: 'company', id: r.company.id, field: p.field, value: p.value });
  }
  if (Object.keys(companyData).length > 0) {
    const written = { ...r.company, ...companyData } as Company;
    const after = await tx.company.update({
      where: { id: r.company.id },
      data: { ...companyData, verificationStatus: verificationStatus(written, verifiedOf(r.company)) },
    });
    const keys = Object.keys(companyData);
    await audit(tx, { entityType: 'company', entityId: r.company.id, action: 'update', userId: ctx.user.id, before: pick(r.company, keys), after: { ...pick(after, keys), source } });
  }

  // The lead's existing (or linked) contact.
  const person = r.contact ?? (plan.contact && 'link' in plan.contact ? plan.contact.link : null);
  const contactData: Record<string, unknown> = {};
  for (const p of by('contact')) {
    if (!person) continue;
    contactData[p.field] = p.value;
    filled.push({ entity: 'contact', id: person.id, field: p.field, value: p.value });
    if (p.field === 'phone') {
      const normalised = normalisePhone(p.value);
      if (normalised) {
        contactData.phoneNormalised = normalised;
        filled.push({ entity: 'contact', id: person.id, field: 'phoneNormalised', value: normalised });
      }
    }
  }
  if (person && Object.keys(contactData).length > 0) {
    const after = await tx.contact.update({ where: { id: person.id }, data: contactData });
    const keys = Object.keys(contactData);
    await audit(tx, { entityType: 'contact', entityId: person.id, action: 'update', userId: ctx.user.id, before: pick(person, keys), after: { ...pick(after, keys), source } });
  }

  return {
    ok: true, leadId: r.lead?.id ?? null, companyId: r.company.id, contactId,
    changes: { filled, conflicts: plan.conflicts, createdContact },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Undo

/** Bookkeeping columns written with a fill (not counted as a field in the Undo preview). */
const HIDDEN_FILLS = new Set(['domain', 'phoneNormalised']);

type FilledRow = { changes: RowChanges };

/** The update rows of a batch, with what they filled. */
export async function updatedRows(db: Db, batchId: number): Promise<FilledRow[]> {
  const rows = await db.importRow.findMany({ where: { batchId, outcome: 'Updated' }, select: { changes: true }, orderBy: { id: 'asc' } });
  return rows
    .filter((r) => r.changes && typeof r.changes === 'object')
    .map((r) => ({ changes: r.changes as unknown as RowChanges }));
}

const currentOf = (rec: object | undefined, field: string) => (rec as Record<string, unknown> | undefined)?.[field];
const sameStored = (current: unknown, value: string | number) => current !== null && current !== undefined && String(current) === String(value);

export type FilledUndo = {
  /** Fills still holding the batch's value (and, on a company, not verified since): they go back to empty. */
  revert: UpdateFill[];
  keep: number;
  /** Contacts the batch created that nobody has worked on: removed once their lead no longer links them. */
  contacts: number[];
  preview: { revert: number; keep: number };
};

/** What Undo does with the blanks the batch's update rows filled (read under Undo's locks for the real thing). */
export async function planFilledUndo(db: Db, batchId: number): Promise<FilledUndo> {
  const rows = await updatedRows(db, batchId);
  const fills = rows.flatMap((r) => r.changes.filled ?? []);
  const created = rows.map((r) => r.changes.createdContact).filter((c): c is { id: number; stamp: string } => !!c);
  const ids = (entity: UpdateFill['entity']) => [...new Set(fills.filter((f) => f.entity === entity).map((f) => f.id))];
  const [leads, companies, contacts] = await Promise.all([
    db.lead.findMany({ where: { id: { in: ids('lead') } } }),
    db.company.findMany({ where: { id: { in: ids('company') } } }),
    db.contact.findMany({ where: { id: { in: [...new Set([...ids('contact'), ...created.map((c) => c.id)])] } } }),
  ]);
  const rec = { lead: new Map(leads.map((l) => [l.id, l])), company: new Map(companies.map((c) => [c.id, c])), contact: new Map(contacts.map((c) => [c.id, c])) };
  const revert: UpdateFill[] = [];
  let keep = 0;
  let shownRevert = 0;
  let shownKeep = 0;
  for (const f of fills) {
    const record = rec[f.entity].get(f.id);
    const verified = f.entity === 'company' && record ? verifiedOf(record as Company)[f.field] === true : false;
    const ok = !!record && !verified && sameStored(currentOf(record, f.field), f.value);
    if (ok) revert.push(f);
    else keep += 1;
    if (!HIDDEN_FILLS.has(f.field)) {
      if (ok) shownRevert += 1;
      else shownKeep += 1;
    }
  }
  // A created contact goes when nobody has edited it, nothing hangs on it and no lead but the ones Undo unlinks keeps it.
  const unlinking = new Set(revert.filter((f) => f.entity === 'lead' && f.field === 'contactId').map((f) => Number(f.value)));
  const removable: number[] = [];
  for (const c of created) {
    const contact = rec.contact.get(c.id);
    if (!contact || contact.updatedAt.toISOString() !== c.stamp || !unlinking.has(c.id)) continue;
    const [linked, mail, quotes, stakeholders, recipients] = await Promise.all([
      db.lead.count({ where: { contactId: c.id } }),
      db.emailMessage.count({ where: { contactId: c.id } }),
      db.quotation.count({ where: { contactId: c.id } }),
      db.projectStakeholder.count({ where: { contactId: c.id } }),
      db.emailCampaignRecipient.count({ where: { contactId: c.id } }),
    ]);
    const unlinked = revert.filter((f) => f.entity === 'lead' && f.field === 'contactId' && Number(f.value) === c.id).length;
    if (linked - unlinked === 0 && mail + quotes + stakeholders + recipients === 0) removable.push(c.id);
  }
  return { revert, keep, contacts: removable, preview: { revert: shownRevert, keep: shownKeep } };
}

/** Puts the filled blanks back to empty (each record audited) and removes the contacts the batch created, untouched. */
export async function revertFilled(tx: Tx, user: AuthUser, batchNumber: string, plan: FilledUndo): Promise<void> {
  const groups = new Map<string, UpdateFill[]>();
  for (const f of plan.revert) {
    const key = `${f.entity}:${f.id}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const [key, list] of groups) {
    const [entity, rawId] = key.split(':') as [UpdateFill['entity'], string];
    const id = Number(rawId);
    const data = Object.fromEntries(list.map((f) => [f.field, null]));
    const before = Object.fromEntries(list.map((f) => [f.field, f.value]));
    if (entity === 'lead') {
      await tx.lead.update({ where: { id }, data });
    } else if (entity === 'contact') {
      await tx.contact.update({ where: { id }, data });
    } else {
      const company = await tx.company.findUniqueOrThrow({ where: { id } });
      const written = { ...company, ...data } as Company;
      await tx.company.update({ where: { id }, data: { ...data, verificationStatus: verificationStatus(written, verifiedOf(company)) } });
    }
    await audit(tx, { entityType: entity, entityId: id, action: 'update', userId: user.id, before, after: { ...data, undoneImport: batchNumber } });
  }
  if (plan.contacts.length > 0) {
    const contacts = await tx.contact.findMany({ where: { id: { in: plan.contacts } } });
    await tx.contact.deleteMany({ where: { id: { in: plan.contacts } } });
    for (const c of contacts) {
      await audit(tx, { entityType: 'contact', entityId: c.id, action: 'delete', userId: user.id, before: c, after: { undoneImport: batchNumber } });
    }
  }
}

/** The records the batch's update rows filled (Undo locks them before checking). */
export async function filledRecordIds(db: Db, batchId: number): Promise<{ leads: number[]; companies: number[]; contacts: number[] }> {
  const rows = await updatedRows(db, batchId);
  const fills = rows.flatMap((r) => r.changes.filled ?? []);
  const ids = (entity: UpdateFill['entity']) => [...new Set(fills.filter((f) => f.entity === entity).map((f) => f.id))].sort((a, b) => a - b);
  const created = rows.map((r) => r.changes.createdContact?.id).filter((id): id is number => typeof id === 'number');
  return { leads: ids('lead'), companies: ids('company'), contacts: [...new Set([...ids('contact'), ...created])].sort((a, b) => a - b) };
}
