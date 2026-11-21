import { parse } from 'csv-parse/sync';
import type { PrismaClient } from '@prisma/client';
import {
  CSV_FIELDS, CSV_MAX_ROWS, LeadCreate, PRIORITIES, optionalEmail, optionalText, type CompanyMatchHow, type CsvField, type CsvImport,
  type CsvSuggestedMapping,
} from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { findCompanyMatches } from '../companies/match.js';
import { NotFoundError, ValidationError } from '../validate.js';
import { isUniqueViolation } from '../prismaErrors.js';
import { RuleError, auditCreatedLead, createLeadWithCompany } from './service.js';

export type ParsedCsv = { headers: string[]; rows: Record<string, string>[] };

/** A lead's notes cap (the `notes` field of LeadCreate). */
const NOTES_MAX = 5000;

/** The CSV cannot be used: parser error, no header row or no data rows. Routes answer 400 `csv_invalid`. */
export class CsvInvalidError extends Error {}

/** More data rows than one import accepts. Routes answer 400 `{ error: 'csv_too_large', rows, max }`. */
export class CsvTooLargeError extends Error {
  constructor(readonly rows: number, readonly max = CSV_MAX_ROWS) {
    super(`The file has ${rows} rows; at most ${max} per import`);
  }
}

/** Refuses a parsed CSV with more than CSV_MAX_ROWS data rows (throws CsvTooLargeError). */
export function assertRowCap(parsed: ParsedCsv): void {
  if (parsed.rows.length > CSV_MAX_ROWS) throw new CsvTooLargeError(parsed.rows.length);
}

/** Parses CSV text with a header row (BOM, blank lines and ragged rows tolerated); throws CsvInvalidError. */
export function parseCsv(text: string): ParsedCsv {
  let headers: string[] = [];
  let rows: Record<string, string>[];
  try {
    rows = parse<Record<string, string>>(text, {
      columns: (h: string[]) => (headers = h),
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (e) {
    throw new CsvInvalidError(e instanceof Error ? e.message : 'The file could not be read as CSV');
  }
  if (headers.length === 0 || headers.every((h) => !h)) throw new CsvInvalidError('The file has no header row');
  if (rows.length === 0) throw new CsvInvalidError('The file has no data rows');
  return { headers, rows };
}

/** A cell by header: own string properties only, so headers such as `__proto__` read as ''. */
export function cell(record: Record<string, string>, header: string): string {
  const v = Object.hasOwn(record, header) ? record[header] : undefined;
  return typeof v === 'string' ? v : '';
}

/** 400 `validation` unless every mapped header (companyName and country included) is a header of the file. */
export function assertMappingHeaders(columns: CsvImport['mapping']['columns'], headers: string[]): void {
  const known = new Set(headers);
  const issues = CSV_FIELDS.flatMap((field) => {
    const header = columns[field];
    return header !== null && !known.has(header)
      ? [{ path: ['mapping', 'columns', field], message: `Column "${header}" is not in the file` }]
      : [];
  });
  if (issues.length > 0) throw new ValidationError(issues);
}

/** `CSV contact: First Last <email> phone` from the parts present, or null when there are none. */
export function contactNote(parts: { firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null }): string | null {
  const name = [parts.firstName, parts.lastName].filter(Boolean).join(' ');
  const text = [name, parts.email ? `<${parts.email}>` : '', parts.phone ?? ''].filter(Boolean).join(' ');
  return text ? `CSV contact: ${text}` : null;
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
  return parsed.rows.slice(0, n).map((r) => parsed.headers.map((h) => cell(r, h)));
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
  const parsed = parseCsv(body.csv);
  assertRowCap(parsed);
  const { headers, rows } = parsed;
  const { columns } = body.mapping;
  assertMappingHeaders(columns, headers);
  const result: CsvImportResult = { batch: csvBatch(), created: 0, linked: 0, review: [], errors: [] };

  for (const [i, record] of rows.entries()) {
    const row = i + 1;
    const get = (field: CsvField): string => {
      const header = columns[field];
      return header ? cell(record, header).trim() : '';
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
        // An unlinked lead keeps no contact: carry the contact columns in its notes for resolve-company.
        let notes = input.notes ?? null;
        const contact = review.length > 0
          ? contactNote({
            firstName: input.contactFirstName, lastName: input.contactLastName,
            email: input.contactEmail ?? input.businessEmail, phone: input.phone,
          })
          : null;
        if (contact) notes = notes ? `${notes}\n${contact}` : contact;
        // The notes column cap (5000) still holds once the contact note is appended.
        if (notes && notes.length > NOTES_MAX) notes = notes.slice(0, NOTES_MAX);
        const created = await createLeadWithCompany(
          tx, { ...input, notes, createCompany: review.length === 0, importBatch: result.batch }, user,
        );
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
