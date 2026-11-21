import { parse } from 'csv-parse/sync';
import type { PrismaClient } from '@prisma/client';
import {
  CSV_FIELDS, LeadCreate, PRIORITIES, optionalEmail, optionalText, type CompanyMatchHow, type CsvField, type CsvImport,
  type CsvSuggestedMapping,
} from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { findCompanyMatches } from '../companies/match.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { isUniqueViolation } from '../prismaErrors.js';
import { RuleError, auditCreatedLead, createLeadWithCompany } from './service.js';

export type ParsedCsv = { headers: string[]; rows: Record<string, string>[] };

/** Parses CSV text with a header row (BOM, blank lines and ragged rows tolerated). Malformed CSV is a 400 on `csv`. */
export function parseCsv(text: string): ParsedCsv {
  let headers: string[] = [];
  try {
    const rows = parse<Record<string, string>>(text, {
      columns: (h: string[]) => (headers = h),
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
    return { headers, rows };
  } catch (e) {
    throw new ValidationError([{ path: ['csv'], message: e instanceof Error ? e.message : 'Invalid CSV' }]);
  }
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header spellings (squashed) recognised per field, besides the field name itself. */
const ALIASES: Record<CsvField, string[]> = {
  companyName: ['company', 'companyname', 'businessname', 'name', 'organisation', 'organization'],
  website: ['website', 'url', 'web', 'site'],
  businessEmail: ['email', 'businessemail', 'companyemail'],
  phone: ['phone', 'telephone', 'tel', 'phonenumber'],
  country: ['country'],
  city: ['city', 'town'],
  contactFirstName: ['firstname', 'contactfirstname', 'forename'],
  contactLastName: ['lastname', 'contactlastname', 'surname'],
  contactEmail: ['contactemail'],
  leadSource: ['leadsource', 'source'],
  priority: ['priority'],
  notes: ['notes', 'note', 'comments'],
  sourceUrl: ['sourceurl'],
};

/** Suggests a header per field by case-insensitive match on the field name or a common alias. */
export function suggestMapping(headers: string[]): CsvSuggestedMapping {
  const columns = {} as Record<CsvField, string | null>;
  const taken = new Set<string>();
  for (const field of CSV_FIELDS) {
    const keys = new Set([squash(field), ...ALIASES[field]]);
    const hit = headers.find((h) => !taken.has(h) && keys.has(squash(h)));
    columns[field] = hit ?? null;
    if (hit) taken.add(hit);
  }
  return { columns };
}

/** First five data rows, in header order. */
export function sampleRows(parsed: ParsedCsv, n = 5): string[][] {
  return parsed.rows.slice(0, n).map((r) => parsed.headers.map((h) => r[h] ?? ''));
}

/** `CSV-YYYYMMDD-HHMM` in UTC. */
export function csvBatch(now = new Date()): string {
  const iso = now.toISOString();
  return `CSV-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** One row's own validation (company name, country, priority, contact columns) on top of LeadCreate. */
const CsvRow = LeadCreate.extend({
  contactFirstName: optionalText(100),
  contactLastName: optionalText(100),
  contactEmail: optionalEmail(),
});

/** Refusal of one CSV row, reported in `errors` (the rest of the file is still imported). */
class RowError extends Error {}

export type CsvImportResult = {
  batch: string;
  /** Leads created (linked, new company, or awaiting review). */
  created: number;
  /** Of those, linked to an existing company by an automatic (domain) match. */
  linked: number;
  review: { row: number; leadId: number; companyName: string; candidates: { id: number; number: string; name: string; how: CompanyMatchHow }[] }[];
  errors: { row: number; message: string }[];
};

function rowMessage(e: unknown): string | null {
  if (e instanceof RowError) return e.message;
  if (e instanceof ValidationError) return e.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ');
  if (e instanceof RuleError) return e.code;
  if (e instanceof NotFoundError) return 'Not found';
  if (isUniqueViolation(e, 'domain')) return 'Domain already belongs to another company';
  return null;
}

/**
 * Imports CSV rows as Prospects, one transaction per row: domain auto-match links the company;
 * review candidates (legal name / name + country) leave the lead without a company and list it
 * in `review`; no match creates the company (and a primary contact from the contact columns).
 * The assignee (if any) must already have been checked by the caller.
 */
export async function importCsvLeads(
  db: PrismaClient, user: AuthUser, body: CsvImport, onUnexpected: (e: unknown, row: number) => void,
): Promise<CsvImportResult> {
  const { rows } = parseCsv(body.csv);
  const { columns } = body.mapping;
  const result: CsvImportResult = { batch: csvBatch(), created: 0, linked: 0, review: [], errors: [] };

  for (const [i, record] of rows.entries()) {
    const row = i + 1;
    const get = (field: CsvField): string => {
      const header = columns[field];
      return header ? (record[header] ?? '').trim() : '';
    };
    try {
      const outcome = await db.$transaction(async (tx) => {
        const companyName = get('companyName');
        const country = get('country');
        if (!companyName) throw new RowError('Company name is required');
        if (!country) throw new RowError('Country is required');
        if (!(await tx.lookupValue.count({ where: { group: 'country', value: country, isActive: true } }))) {
          throw new RowError(`Unknown country "${country}"`);
        }
        const leadSource = get('leadSource') || body.leadSource;
        if (!(await tx.lookupValue.count({ where: { group: 'lead_source', value: leadSource, isActive: true } }))) {
          throw new RowError(`Unknown lead source "${leadSource}"`);
        }
        const rawPriority = get('priority');
        const priority = rawPriority ? PRIORITIES.find((p) => p.toLowerCase() === rawPriority.toLowerCase()) : 'Medium';
        if (!priority) throw new RowError(`Unknown priority "${rawPriority}"`);

        const parsed = CsvRow.safeParse({
          leadType: 'Prospect', companyName, country, leadSource, priority,
          website: get('website'), businessEmail: get('businessEmail'), phone: get('phone'), city: get('city'),
          notes: get('notes'), sourceUrl: get('sourceUrl'), contactFirstName: get('contactFirstName'),
          contactLastName: get('contactLastName'), contactEmail: get('contactEmail'),
          assignedToId: body.assignedToId ?? undefined,
        });
        if (!parsed.success) {
          throw new RowError(parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
        }
        const input = parsed.data;
        const matches = await findCompanyMatches(tx, {
          name: input.companyName, website: input.website ?? undefined, businessEmail: input.businessEmail ?? undefined, country,
        });
        const review = matches.auto ? [] : matches.review;
        const created = await createLeadWithCompany(tx, { ...input, createCompany: review.length === 0, importBatch: result.batch }, user);
        await auditCreatedLead(tx, user.id, created);
        return { created, review };
      });
      result.created += 1;
      const { lead, createdCompanyId } = outcome.created;
      if (lead.companyId !== null && createdCompanyId === null) result.linked += 1;
      if (outcome.review.length > 0) {
        result.review.push({
          row, leadId: lead.id, companyName: lead.companyName,
          candidates: outcome.review.map((r) => ({ id: r.candidate.id, number: r.candidate.number, name: r.candidate.name, how: r.how })),
        });
      }
    } catch (e) {
      const message = rowMessage(e);
      if (message === null) onUnexpected(e, row);
      result.errors.push({ row, message: message ?? 'Unexpected error importing this row' });
    }
  }
  return result;
}
