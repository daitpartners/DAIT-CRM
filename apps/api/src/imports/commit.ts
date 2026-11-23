/**
 * Import leads, step 4: starting the import and the `import_commit` job that creates the companies, contacts and leads,
 * one transaction per row (a stopped job resumes with the rows not yet imported).
 *
 * - A row's company is the CRM company it matches (or one an earlier row of the batch created), never overwritten; else
 *   a new company from the row's own values.
 * - The contact (owner rule): on that company, matched by email, else by normalised full name; reused untouched, or
 *   added as a new contact (primary only on a company this row created).
 * - The lead: lead source "Import" with the batch number, the batch's outreach language and lead type, assigned by the
 *   allocation rules, quietly (no "Review new lead" task or notification); with "notify", one notification per assignee.
 * - Research values (release-4 golden rule): company values go to empty, unverified fields only, as suggestions, or
 *   accepted at 80% or higher when ticked; contact values not used are listed on the lead as "Research found (not
 *   verified)"; nothing a person filled or verified is ever overwritten.
 */
import type { Company, Contact, ImportBatch, ImportRow, Prisma, User } from '@prisma/client';
import {
  IMPORT_LEAD_SOURCE, importColumnLabel, importEngineText, normalisePhone, researchFieldLabel, roleLabel,
  type ImportCommit, type ImportField, type LeadType, type ResearchEngine, type ResearchValue, type ReviewSummary, type RowFields,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { enqueue } from '../jobs/queue.js';
import { rowMessage } from '../leads/csv.js';
import { auditCreatedLead, companyDataFromLead, createLeadWithCompany } from '../leads/service.js';
import { notifyUser } from '../leads/notify.js';
import { applySuggestion, isLocked as isFieldLocked } from '../research/service.js';
import type { AuthUser } from '../plugins/auth.js';
import { NotFoundError } from '../validate.js';
import { ImportError } from './batches.js';
import { companyKeyOf, findExistingCompanies } from './companies.js';
import { matchCountry } from './countries.js';
import { acceptable, effectiveFields, planBatch, researchOf, summarisePlan } from './plan.js';
import { knownCountries } from './stage.js';

type Tx = Prisma.TransactionClient;

/** The batch statuses an import can start from. */
const STARTS_FROM = new Set(['Sorting', 'Researching', 'Waiting for review']);
const UNEXPECTED = 'Unexpected error importing this row';
const ERROR_MAX = 300;
/** Local parts of a company mailbox (not a person's): such an email is also the company's business email. */
const GENERIC_LOCAL_PARTS = new Set([
  'info', 'contact', 'contacto', 'hello', 'hola', 'office', 'sales', 'ventas', 'admin', 'enquiries', 'inquiries', 'mail', 'bonjour',
]);
/** Leading titles dropped from a person's name. */
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'sr', 'sra', 'srta', 'm', 'mme', 'mlle', 'prof']);

const planSelect = { id: true, fields: true, research: true, status: true, include: true, matchedCompanyId: true } as const;

const has = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';
const clean = (v: string | null | undefined): string | null => (has(v) ? v.trim() : null);
const stripAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');
/** A link the CRM can open: a bare host gets https:// (as the lead form does). */
const withScheme = (v: string | null): string | null => (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? `https://${v}` : v);

export const isGenericEmail = (email: string | null | undefined): boolean => {
  const at = (email ?? '').lastIndexOf('@');
  return at > 0 && GENERIC_LOCAL_PARTS.has(email!.slice(0, at).trim().toLowerCase());
};

const isHonorific = (word: string) => HONORIFICS.has(stripAccents(word).toLowerCase().replace(/\.+$/, ''));

/** A person's name for matching: lower case, no accents, no leading title, letters only, single spaces. */
export function normalisePersonName(s: string): string {
  const words = stripAccents(s).toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (words.length > 1 && HONORIFICS.has(words[0]!)) words.shift();
  return words.join(' ');
}

/** First and last name from a full name: the last word is the last name; a leading title is dropped. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && isHonorific(words[0]!)) words.shift();
  if (words.length === 0) return { firstName: '', lastName: '' };
  if (words.length === 1) return /\.$/.test(words[0]!) && isHonorific(words[0]!) ? { firstName: '', lastName: '' } : { firstName: words[0]!, lastName: '' };
  return { firstName: words.slice(0, -1).join(' '), lastName: words[words.length - 1]! };
}

/** The contact of `companyId` with this email (ignoring case), else with this normalised full name; null when none. */
export async function findContactOnCompany(
  tx: Tx, companyId: number, who: { email: string | null; name: string | null },
): Promise<Contact | null> {
  const contacts = await tx.contact.findMany({ where: { companyId }, orderBy: { id: 'asc' } });
  const email = clean(who.email)?.toLowerCase();
  if (email) {
    const byEmail = contacts.find((c) => c.businessEmail?.trim().toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  const name = who.name ? normalisePersonName(who.name) : '';
  if (!name) return null;
  return contacts.find((c) => normalisePersonName(`${c.firstName} ${c.lastName}`) === name) ?? null;
}

const authUserOf = (u: User): AuthUser => ({
  id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone, dateFormat: u.dateFormat,
});

/** The step-4 totals for these choices (the review screen). */
export async function reviewBatch(
  batchId: number, opts: { acceptHigh: boolean; noContactRows: 'import' | 'leave' | null },
): Promise<{ batch: ImportBatch; summary: ReviewSummary }> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError();
  const rows = await prisma.importRow.findMany({ where: { batchId }, select: planSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  const summary = summarisePlan(planBatch(rows, { ...opts, knownCountries: await knownCountries() }));
  return { batch, summary };
}

/**
 * Starts the import with the step-4 choices. Under the batch row lock (the lock every staged-row change takes, so no edit,
 * tick or re-match lands once it has started), the rows are planned: 400 `choice_required` when rows have no email or
 * phone and no choice was made, 400 `nothing_to_import` when no row would be imported, 409 `batch_locked` unless the batch
 * is Sorting, Researching or Waiting for review. The batch becomes Importing (research paused), the choices are kept,
 * and one `import_commit` job is queued.
 */
export async function startImport(user: AuthUser, batchId: number, body: ImportCommit): Promise<void> {
  const known = await knownCountries();
  await prisma.$transaction(async (tx) => {
    const [batch] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM import_batches WHERE id = ${batchId} FOR UPDATE`;
    if (!batch) throw new NotFoundError();
    if (!STARTS_FROM.has(batch.status)) throw new ImportError('batch_locked', 409);
    const rows = await tx.importRow.findMany({ where: { batchId }, select: planSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
    const summary = summarisePlan(planBatch(rows, { acceptHigh: body.acceptHigh, noContactRows: body.noContactRows, knownCountries: known }));
    if (body.noContactRows === null && summary.noContactRows > 0) throw new ImportError('choice_required', 400);
    if (summary.willImport === 0) throw new ImportError('nothing_to_import', 400);
    const options: ImportCommit = { acceptHigh: body.acceptHigh, noContactRows: body.noContactRows, notify: body.notify };
    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: 'Importing', researchPaused: true, options, importedById: user.id },
    });
    await enqueue(tx, 'import_commit', { batchId }, { maxAttempts: 3 });
  });
}

/** Test seam: `afterRow(n)` runs after each row the run attempts (n = rows attempted so far in this run). */
export type CommitDeps = { afterRow?: (n: number) => void | Promise<void> };

/**
 * The `import_commit` job: plans the batch once with its saved choices; rows left out become Skipped (with the reason),
 * each row to import that has no lead yet is imported in its own transaction (an error is recorded on the row and the
 * batch carries on); then the counts, Imported (Failed when every row to import failed) and, with "notify", one
 * notification per assignee. Nothing happens unless the batch is Importing, so a rerun after the end is harmless.
 */
export async function commitBatch(batchId: number, deps: CommitDeps = {}): Promise<void> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.status !== 'Importing') return;
  const options = batch.options as ImportCommit;
  const userId = batch.importedById ?? batch.createdById;
  const importer = userId === null ? null : await prisma.user.findUnique({ where: { id: userId } });
  if (!importer) throw new Error('import_user_missing');
  const ctx = { user: authUserOf(importer), acceptHigh: options.acceptHigh === true, knownCountries: await knownCountries() };

  const rows = await prisma.importRow.findMany({ where: { batchId }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  const plans = planBatch(rows, { acceptHigh: ctx.acceptHigh, noContactRows: options.noContactRows ?? null, knownCountries: ctx.knownCountries });

  const skipped = new Map<string, number[]>();
  for (const p of plans) {
    if (p.action !== 'skip') continue;
    skipped.set(p.reason!, [...(skipped.get(p.reason!) ?? []), p.rowId]);
  }
  for (const [code, ids] of skipped) {
    await prisma.importRow.updateMany({ where: { id: { in: ids }, outcome: null }, data: { outcome: 'Skipped', outcomeCode: code } });
  }

  let attempted = 0;
  for (const [i, plan] of plans.entries()) {
    const row = rows[i]!;
    if (plan.action !== 'import' || row.leadId !== null || row.outcome !== null) continue;
    try {
      await prisma.$transaction((tx) => importRow(tx, row, batch, ctx), { timeout: 60_000, maxWait: 30_000 });
    } catch (e) {
      const message = rowMessage(e);
      if (message === null) console.error(`import ${batch.number}: row ${row.id} failed`, e);
      await prisma.importRow.update({
        where: { id: row.id },
        data: { outcome: 'Error', outcomeCode: 'import_error', error: (message ?? UNEXPECTED).slice(0, ERROR_MAX) },
      });
    }
    attempted += 1;
    await deps.afterRow?.(attempted);
  }
  await finishBatch(batchId, options.notify === true);
}

/** Counts, final status and the notifications, once (under the batch lock, only while still Importing). */
async function finishBatch(batchId: number, notify: boolean): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM import_batches WHERE id = ${batchId} FOR UPDATE`;
    if (!locked || locked.status !== 'Importing') return;
    const batch = await tx.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    const imported = await tx.importRow.findMany({
      where: { batchId, outcome: 'Imported' }, select: { leadId: true, companyId: true, companyCreated: true },
    });
    const errorCount = await tx.importRow.count({ where: { batchId, outcome: 'Error' } });
    const skippedCount = await tx.importRow.count({ where: { batchId, outcome: 'Skipped' } });
    const created = new Set(imported.filter((r) => r.companyCreated && r.companyId !== null).map((r) => r.companyId!));
    const existingCompanyCount = imported.filter((r) => !r.companyCreated && r.companyId !== null && !created.has(r.companyId)).length;
    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status: imported.length === 0 && errorCount > 0 ? 'Failed' : 'Imported',
        importedCount: imported.length, newCompanyCount: created.size, existingCompanyCount, skippedCount, errorCount,
        importedAt: new Date(),
      },
    });
    if (!notify) return;
    const leadIds = imported.map((r) => r.leadId).filter((id): id is number => id !== null);
    const perAssignee = await tx.lead.groupBy({
      by: ['assignedToId'], where: { id: { in: leadIds }, assignedToId: { not: null } }, _count: { _all: true },
    });
    const noun = batch.leadType === 'Prospect' ? ['prospect', 'prospects'] : ['lead', 'leads'];
    for (const g of perAssignee.sort((a, b) => a.assignedToId! - b.assignedToId!)) {
      const n = g._count._all;
      await notifyUser(tx, g.assignedToId!, `Import ${batch.number} · ${n} ${n === 1 ? noun[0] : noun[1]} assigned to you`, null, `/leads?q=${batch.number}`);
    }
  });
}

export type RowResult = { leadId: number; companyId: number; contactId: number | null; companyCreated: boolean; contactCreated: boolean };

/** The active `industry` lookup value equal to `value` (ignoring case), in its own spelling; null when none. */
async function industryValue(tx: Tx, value: string | null): Promise<string | null> {
  if (!value) return null;
  const hit = await tx.lookupValue.findFirst({
    where: { group: 'industry', isActive: true, value: { equals: value, mode: 'insensitive' } }, select: { value: true },
  });
  return hit?.value ?? null;
}

/** One `import`-made research run per company per batch (no daily limit, no Claude cap: sources ["import"]). */
async function importRun(tx: Tx, company: Company, batch: ImportBatch, leadId: number, userId: number): Promise<number> {
  const trigger = `Import ${batch.number}`;
  const existing = await tx.enrichmentRun.findFirst({ where: { companyId: company.id, trigger }, select: { id: true } });
  if (existing) return existing.id;
  const now = new Date();
  const run = await tx.enrichmentRun.create({
    data: {
      companyId: company.id, leadId, trigger, engine: importEngineText(batch.researchEngine as ResearchEngine | null, 'en').slice(0, 120),
      sources: ['import'], status: 'Completed', startedAt: now, finishedAt: now, createdById: userId, result: '0 suggestions',
    },
  });
  return run.id;
}

/** The research values of a row that are company fields, by company column. */
function companyResearch(own: RowFields, research: Partial<Record<ImportField, ResearchValue>>): [string, ResearchValue][] {
  const out: [string, ResearchValue][] = [];
  const add = (field: ImportField, column: string, ok = true) => {
    const v = research[field];
    if (ok && v && has(v.value) && !has(own[field])) out.push([column, v]);
  };
  add('website', 'website');
  add('city', 'city');
  add('email', 'businessEmail', isGenericEmail(research.email?.value));
  return out;
}

/**
 * Imports one planned row inside `tx`: company (matched, or created by an earlier row, or new), contact (owner rule),
 * lead, research values (golden rule), then the row's links and stamps; the company stamp is refreshed on every row of
 * the batch with that company, so Undo never mistakes the batch's own later writes for a person's edit.
 */
export async function importRow(
  tx: Tx, row: ImportRow, batch: ImportBatch, ctx: { user: AuthUser; acceptHigh: boolean; knownCountries: readonly string[] },
): Promise<RowResult> {
  const own = (row.fields ?? {}) as RowFields;
  const { fields, fromResearch } = effectiveFields(row, ctx.acceptHigh);
  const country = matchCountry(fields.country ?? '', ctx.knownCountries) ?? clean(fields.country) ?? '';
  const f: RowFields = { ...fields, country };
  const companyName = clean(f.companyName) ?? '';

  // 1. Company: the one it matches (still there), else one the matcher finds now (an earlier row may have created it).
  let company: Company | null = row.matchedCompanyId === null
    ? null
    : await tx.company.findUnique({ where: { id: row.matchedCompanyId } });
  if (!company) {
    const [hit] = await findExistingCompanies(tx, [f]);
    if (hit) company = await tx.company.findUnique({ where: { id: hit.id } });
  }
  let companyCreated = false;
  if (!company) {
    const ownEmail = clean(own.email)?.toLowerCase() ?? null;
    const key = companyKeyOf(f);
    const industry = await industryValue(tx, clean(own.industry));
    // The company's own columns come from the row's own values; research values reach it only through step 4.
    const data = companyDataFromLead({
      companyName, website: withScheme(clean(own.website)), businessEmail: isGenericEmail(ownEmail) ? ownEmail : null, country,
      city: clean(own.city),
    }, ctx.user.id);
    company = await tx.company.create({
      data: { ...data, domain: key?.startsWith('d:') ? key.slice(2) : null, industry },
    });
    companyCreated = true;
  }

  // 2. Contact: matched on the company (reused untouched), else a new one when the row names a person.
  const email = clean(f.email)?.toLowerCase() ?? null;
  const contactName = clean(f.contactName);
  let contact = await findContactOnCompany(tx, company.id, { email, name: contactName });
  let contactCreated = false;
  if (!contact && contactName) {
    const { firstName, lastName } = splitName(contactName);
    if (firstName) {
      const phone = clean(f.phone);
      const primary = companyCreated && (await tx.contact.count({ where: { companyId: company.id, isPrimary: true } })) === 0;
      contact = await tx.contact.create({
        data: {
          companyId: company.id, firstName, lastName, designation: clean(f.designation), businessEmail: email,
          phone, phoneNormalised: normalisePhone(phone) || null, isPrimary: primary,
        },
      });
      contactCreated = true;
    }
  }
  // An inactive contact is never linked to a new lead (and not duplicated either).
  const linkedContact = contact && contact.isActive ? contact : null;

  // 3. Lead.
  const ownIndustry = clean(own.industry);
  const industryNote = ownIndustry && !(await industryValue(tx, ownIndustry)) ? `Industry: ${ownIndustry}` : null;
  const notes = [clean(own.notes), industryNote].filter(Boolean).join('\n') || null;
  const created = await createLeadWithCompany(tx, {
    leadType: batch.leadType as LeadType, companyName, website: withScheme(clean(f.website)), businessEmail: email, phone: clean(f.phone),
    country, city: clean(f.city), leadSource: IMPORT_LEAD_SOURCE, importBatch: batch.number,
    outreachLanguage: batch.language as 'en' | 'es', priority: 'Medium', status: 'New', nextFollowUp: null, notes,
    linkCompanyId: company.id, contactId: linkedContact?.id, createCompany: false,
  }, ctx.user, { quiet: true, trustedLink: true, noDefaultContact: true });
  await auditCreatedLead(tx, ctx.user.id, {
    lead: created.lead, createdCompanyId: companyCreated ? company.id : null, createdContactId: contactCreated ? contact!.id : null,
  });
  const lead = created.lead;

  // 4. Research values.
  const research = researchOf(row);
  const forCompany = companyResearch(own, research);
  if (forCompany.length > 0 || has(research.industry?.value)) {
    await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${company.id} FOR UPDATE`;
    company = await tx.company.findUniqueOrThrow({ where: { id: company.id } });
  }
  let runId: number | null = null;
  for (const [column, v] of forCompany) {
    if (isFieldLocked(company!, column)) continue;
    runId ??= await importRun(tx, company!, batch, lead.id, ctx.user.id);
    const value = column === 'website' ? withScheme(v.value.trim())! : column === 'businessEmail' ? v.value.trim().toLowerCase() : v.value.trim();
    await tx.enrichmentSuggestion.updateMany({ where: { companyId: company!.id, decision: 'pending', field: column }, data: { decision: 'superseded' } });
    const s = await tx.enrichmentSuggestion.create({
      data: {
        runId, companyId: company!.id, field: column, label: researchFieldLabel(column), value, confidence: v.confidence,
        sourceUrl: v.sourceUrl, sourceLabel: v.sourceLabel.slice(0, 200),
      },
    });
    if (acceptable(v, ctx.acceptHigh)) company = await applySuggestion(tx, ctx.user, s, company!);
  }
  if (runId !== null) {
    const n = await tx.enrichmentSuggestion.count({ where: { runId } });
    await tx.enrichmentRun.update({ where: { id: runId }, data: { result: `${n} suggestion${n === 1 ? '' : 's'}` } });
  }
  const foundIndustry = clean(research.industry?.value);
  if (foundIndustry && !has(company!.aiIndustry)) {
    company = await tx.company.update({ where: { id: company!.id }, data: { aiIndustry: foundIndustry.slice(0, 200) } });
  }
  // Contact values (and a country) research found that were not used: listed on the lead, never written.
  const used = new Set(fromResearch.filter((k) => contactCreated || (k !== 'contactName' && k !== 'designation')));
  const lines: string[] = [];
  for (const field of ['contactName', 'designation', 'email', 'phone', 'country'] as const) {
    const v = research[field];
    if (!v || !has(v.value) || has(own[field]) || used.has(field)) continue;
    if (field === 'email' && isGenericEmail(v.value)) continue; // a company mailbox: a suggestion above
    lines.push(`${importColumnLabel(field, 'en')}: ${v.value.trim()} · ${v.sourceUrl} · ${v.confidence}%`);
  }
  if (lines.length > 0) {
    await tx.leadActivity.create({
      data: { leadId: lead.id, activityType: 'ai', title: 'Research found (not verified)', body: lines.join('\n'), byUserId: null },
    });
  }

  // 5. The row: links, outcome and the records' stamps as they are now.
  const [leadNow, companyNow, contactNow] = await Promise.all([
    tx.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { updatedAt: true } }),
    tx.company.findUniqueOrThrow({ where: { id: company!.id }, select: { updatedAt: true } }),
    linkedContact ? tx.contact.findUniqueOrThrow({ where: { id: linkedContact.id }, select: { updatedAt: true } }) : null,
  ]);
  const companyStamp = companyNow.updatedAt.toISOString();
  await tx.importRow.update({
    where: { id: row.id },
    data: {
      leadId: lead.id, companyId: company!.id, contactId: linkedContact?.id ?? null, companyCreated, contactCreated,
      stamps: { lead: leadNow.updatedAt.toISOString(), company: companyStamp, contact: contactNow?.updatedAt.toISOString() ?? null },
      outcome: 'Imported', outcomeCode: null, error: null, importedAt: new Date(),
    },
  });
  await tx.$executeRaw`
    UPDATE import_rows SET stamps = jsonb_set(stamps, '{company}', to_jsonb(${companyStamp}::text))
    WHERE batch_id = ${batch.id} AND company_id = ${company!.id} AND id <> ${row.id} AND stamps IS NOT NULL`;
  return { leadId: lead.id, companyId: company!.id, contactId: linkedContact?.id ?? null, companyCreated, contactCreated };
}
