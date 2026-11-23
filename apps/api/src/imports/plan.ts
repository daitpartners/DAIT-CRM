/**
 * Import leads, step 4 ("Review and import"): what each staged row will do with the current choices, decided on the
 * row's effective values (its own values, plus research values only when "Accept research values with confidence 80% or
 * higher" is ticked), never on its status. The same plan drives the review totals and the import job.
 */
import type { ImportRow } from '@prisma/client';
import {
  ACCEPT_CONFIDENCE, IMPORT_FIELDS,
  type ImportField, type ProblemCode, type ResearchValue, type ReviewSummary, type RowFields,
} from '@dait-crm/shared';
import { companyKeyOf } from './companies.js';
import { matchCountry } from './countries.js';

export type PlanRow = Pick<ImportRow, 'id' | 'fields' | 'research' | 'status' | 'include' | 'matchedCompanyId'>;

export type RowPlan = {
  rowId: number;
  action: 'import' | 'skip';
  reason: ProblemCode | null;
  companyKey: string | null;
  existingCompanyId: number | null;
  /** No email and no phone (on the effective values). */
  noContact: boolean;
  /** Left out for a missing country while research found one that is not accepted (Q2). */
  researchOnlyCountry: boolean;
  /** The effective country as written (the unknown-country list reads it). */
  country: string | null;
};

export type PlanOptions = { acceptHigh: boolean; noContactRows: 'import' | 'leave' | null; knownCountries: readonly string[] };

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** A row's research values (stored as `import_rows.research`). */
export const researchOf = (row: Pick<ImportRow, 'research'>): Partial<Record<ImportField, ResearchValue>> =>
  row.research && typeof row.research === 'object' && !Array.isArray(row.research)
    ? (row.research as Partial<Record<ImportField, ResearchValue>>)
    : {};

/** A research value that counts as accepted with the box ticked. */
export const acceptable = (v: ResearchValue | undefined, acceptHigh: boolean): v is ResearchValue =>
  acceptHigh && !!v && has(v.value) && v.confidence >= ACCEPT_CONFIDENCE;

/**
 * The row's values for planning and importing: its own values always; a research value fills an empty field only when
 * `acceptHigh` and its confidence is at least ACCEPT_CONFIDENCE. `fromResearch` names the fields filled that way.
 */
export function effectiveFields(
  row: Pick<ImportRow, 'fields' | 'research'>, acceptHigh: boolean,
): { fields: RowFields; fromResearch: ImportField[] } {
  const own = (row.fields ?? {}) as RowFields;
  const fields: RowFields = { ...own };
  const fromResearch: ImportField[] = [];
  const research = researchOf(row);
  for (const field of IMPORT_FIELDS) {
    if (has(own[field])) continue;
    const v = research[field];
    if (acceptable(v, acceptHigh)) {
      fields[field] = v.value;
      fromResearch.push(field);
    }
  }
  return { fields, fromResearch };
}

/**
 * One plan per row, in the given order. Left out, first reason wins: not a lead; not ticked (an unticked Already in CRM
 * row: already in CRM); no company name; no country; a country the CRM does not know; no email and no phone with
 * "Leave them out". With no choice yet (`null`) rows with no email or phone are planned as imported (the import itself
 * refuses until a choice is made).
 */
export function planBatch(rows: readonly PlanRow[], opts: PlanOptions): RowPlan[] {
  return rows.map((row) => {
    const { fields } = effectiveFields(row, opts.acceptHigh);
    const noContact = !has(fields.email) && !has(fields.phone);
    const plan: RowPlan = {
      rowId: row.id, action: 'skip', reason: null, companyKey: companyKeyOf(fields), existingCompanyId: row.matchedCompanyId,
      noContact, researchOnlyCountry: false, country: has(fields.country) ? fields.country.trim() : null,
    };
    const skip = (reason: ProblemCode): RowPlan => ({ ...plan, reason });
    if (row.status === 'Not a lead') return skip('not_a_lead');
    if (!row.include) return skip(row.status === 'Already in CRM' ? 'already_in_crm' : 'unticked');
    if (!has(fields.companyName)) return skip('company_missing');
    if (!has(fields.country)) {
      const own = (row.fields ?? {}) as RowFields;
      const found = researchOf(row).country;
      return { ...skip('country_missing'), researchOnlyCountry: !has(own.country) && !!found && has(found.value) };
    }
    if (!matchCountry(fields.country, opts.knownCountries)) return skip('country_unknown');
    if (noContact && opts.noContactRows === 'leave') return skip('no_contact_left_out');
    return { ...plan, action: 'import' };
  });
}

/** The step-4 totals of a plan. */
export function summarisePlan(plans: readonly RowPlan[]): ReviewSummary {
  const imports = plans.filter((p) => p.action === 'import');
  const skips = plans.filter((p) => p.action === 'skip');
  const count = (code: ProblemCode) => skips.filter((p) => p.reason === code).length;
  // An imported row always has a company name, so a key.
  const newKeys = new Set(imports.filter((p) => p.existingCompanyId === null).map((p) => p.companyKey ?? `row:${p.rowId}`));
  const unknown = new Map<string, { value: string; count: number }>();
  for (const p of skips) {
    if (p.reason !== 'country_unknown') continue;
    const value = p.country ?? '';
    const key = value.toLowerCase();
    const entry = unknown.get(key) ?? { value, count: 0 };
    entry.count += 1;
    unknown.set(key, entry);
  }
  const alreadyInCrm = count('already_in_crm');
  const notLead = count('not_a_lead');
  const unticked = count('unticked');
  return {
    willImport: imports.length,
    newCompanies: newKeys.size,
    existingCompanies: imports.filter((p) => p.existingCompanyId !== null).length,
    skipped: { total: skips.length, alreadyInCrm, notLead, unticked, other: skips.length - alreadyInCrm - notLead - unticked },
    noContactRows: plans.filter((p) => p.noContact && (p.action === 'import' || p.reason === 'no_contact_left_out')).length,
    researchOnlyCountry: skips.filter((p) => p.researchOnlyCountry).length,
    unknownCountries: [...unknown.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };
}
