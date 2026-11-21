import { readFile } from 'node:fs/promises';
import type { Company, PrismaClient } from '@prisma/client';
import { LeadCreate, PRIORITIES, normaliseCompanyName, roleLabel } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { parseCsv } from './csv.js';
import { auditCreatedLead, createLeadWithCompany } from './service.js';

/**
 * One-off migration of the 21 Nov 2026 prospects sheet (`leads_pending_1C.csv`): one Prospect per
 * row on the company the 1B import created from the same sheet.
 */
export const PROSPECT_BATCH = 'IMPORT-2026-11-21';

/** The sheet has no country column; its companies are in these countries, tried in this order. */
const SHEET_COUNTRIES = ['United States', 'Canada'];

const REQUIRED_HEADERS = ['company_name', 'owner', 'pipeline_stage', 'priority', 'notes'];

/** `"Deepak=a@x.com,Carlos=b@x.com"` → `{ Deepak: 'a@x.com', Carlos: 'b@x.com' }`. */
export function parseOwners(spec: string): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, email, ...rest] = part.split('=').map((p) => p.trim());
    if (!name || !email || rest.length > 0) throw new Error(`Bad --owners entry "${part}": expected Name=email`);
    owners[name] = email.toLowerCase();
  }
  if (Object.keys(owners).length === 0) throw new Error('--owners is empty: expected "Name=email,Name=email"');
  return owners;
}

/** Lead status from the sheet's pipeline stage: anything "Contacted" → Contacted, else New. */
export function statusFromStage(stage: string): string {
  return /contacted/i.test(stage) ? 'Contacted' : 'New';
}

/** Priority from the sheet when High / Medium / Low, else Medium. */
export function priorityFromSheet(value: string): (typeof PRIORITIES)[number] {
  return PRIORITIES.find((p) => p.toLowerCase() === value.trim().toLowerCase()) ?? 'Medium';
}

export type ProspectTally = {
  dryRun: boolean;
  rows: number;
  /** Prospects created (on a dry run: that would be created). */
  created: number;
  /** Rows whose company already has a Prospect from this batch. */
  alreadyImported: number;
  /** Rows whose owner is blank or not named in --owners. */
  skippedOwner: number;
  /** Company names with no matching company. */
  unknownCompany: string[];
  errors: { row: number; message: string }[];
};

type Options = { file: string; owners: Record<string, string>; dryRun: boolean; log?: (line: string) => void };

async function resolveOwners(db: PrismaClient, owners: Record<string, string>): Promise<Map<string, AuthUser>> {
  const users = new Map<string, AuthUser>();
  for (const [name, email] of Object.entries(owners)) {
    const u = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!u || !u.isActive) throw new Error(`Owner ${name}: no active user with email ${email}`);
    users.set(name, {
      id: u.id, email: u.email, name: u.name, role: roleLabel(u.role), language: u.language, timezone: u.timezone,
      dateFormat: u.dateFormat,
    });
  }
  return users;
}

async function findCompany(db: PrismaClient, name: string, country: string): Promise<Company | null> {
  const countries = country ? [country] : SHEET_COUNTRIES;
  const found = await db.company.findMany({
    where: { nameNormalised: normaliseCompanyName(name), country: { in: countries } }, orderBy: { id: 'asc' },
  });
  for (const c of countries) {
    const hit = found.find((f) => f.country === c);
    if (hit) return hit;
  }
  return null;
}

/**
 * Imports the sheet: per row, the owner (named in `owners`, else skipped) becomes the assignee and
 * the acting user; the company is found by normalised name (+ the row's country, else United
 * States then Canada); a Prospect is created linked to it and its primary contact, without the
 * usual new-lead task and notification. Idempotent on (batch, company). Fails fast when an owner
 * is not an active user. Each row is its own transaction.
 */
export async function importProspects(db: PrismaClient, opts: Options): Promise<ProspectTally> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const users = await resolveOwners(db, opts.owners);
  const { headers, rows } = parseCsv(await readFile(opts.file, 'utf8'));
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) throw new Error(`CSV is missing column(s): ${missing.join(', ')}`);

  const tally: ProspectTally = {
    dryRun: opts.dryRun, rows: rows.length, created: 0, alreadyImported: 0, skippedOwner: 0, unknownCompany: [], errors: [],
  };
  for (const [i, r] of rows.entries()) {
    const row = i + 1;
    const companyName = r.company_name ?? '';
    const owner = users.get((r.owner ?? '').trim());
    if (!owner) {
      tally.skippedOwner += 1;
      log(`row ${row} ${r.prospect_id ?? ''} ${companyName}: owner "${r.owner ?? ''}" not in --owners, skipped`);
      continue;
    }
    const company = await findCompany(db, companyName, r.country ?? '');
    if (!company) {
      tally.unknownCompany.push(companyName);
      log(`row ${row} ${r.prospect_id ?? ''} ${companyName}: no matching company, skipped`);
      continue;
    }
    const parsed = LeadCreate.safeParse({
      leadType: 'Prospect', companyName: company.name, website: company.website, businessEmail: company.businessEmail,
      country: company.country, city: company.city, leadSource: 'CSV Import', sourceUrl: r.source_url || null,
      priority: priorityFromSheet(r.priority ?? ''), status: statusFromStage(r.pipeline_stage ?? ''), nextFollowUp: null,
      notes: r.notes || null, assignedToId: owner.id, linkCompanyId: company.id, createCompany: false,
    });
    if (!parsed.success) {
      const message = parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
      tally.errors.push({ row, message });
      log(`row ${row} ${companyName}: ${message}`);
      continue;
    }
    const exists = (tx: Pick<PrismaClient, 'lead'>) =>
      tx.lead.count({ where: { importBatch: PROSPECT_BATCH, companyId: company.id, leadType: 'Prospect' } });
    try {
      const created = await db.$transaction(async (tx) => {
        if ((await exists(tx)) > 0) return false;
        if (opts.dryRun) return true;
        const lead = await createLeadWithCompany(
          tx, { ...parsed.data, importBatch: PROSPECT_BATCH }, owner, { quiet: true, trustedLink: true },
        );
        await auditCreatedLead(tx, owner.id, lead);
        return true;
      });
      if (created) tally.created += 1;
      else tally.alreadyImported += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      tally.errors.push({ row, message });
      log(`row ${row} ${companyName}: ${message}`);
    }
  }
  log(
    `${opts.dryRun ? 'DRY RUN - nothing written. ' : ''}rows ${tally.rows}, ${opts.dryRun ? 'would create' : 'created'} ${tally.created}, `
    + `already imported ${tally.alreadyImported}, skipped (owner) ${tally.skippedOwner}, `
    + `unknown company ${tally.unknownCompany.length}, errors ${tally.errors.length}`,
  );
  return tally;
}
