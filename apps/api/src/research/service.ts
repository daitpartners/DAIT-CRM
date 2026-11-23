/**
 * AI research runs (release 4): starting a run (one at a time per company, daily limit), running it through the
 * providers (website reader → Google Places → Claude), and the decisions a user makes on its suggestions.
 *
 * The golden rule: a run proposes a value only for a field that is empty and not verified; accepting writes it, marks it
 * verified and records it in `ai_fields`; nothing a person confirmed is ever overwritten. Claude's own classification
 * (summary, AI industry / category, opportunity score, confidence) goes straight to the `ai_*` columns.
 */
import { Prisma, type Company, type PrismaClient } from '@prisma/client';
import {
  CompanyUpdate, ENRICHMENT_SETTINGS_DEFAULTS, RESEARCH_FIELDS, can, researchFieldLabel, type ManualSourceCreate,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { enqueue, STALE_AFTER_MS } from '../jobs/queue.js';
import { notifyUser } from '../leads/notify.js';
import { assertCompanyVisible } from '../companies/visibility.js';
import { NotFoundError } from '../validate.js';
import type { AuthUser } from '../plugins/auth.js';
import type { Finding, ReadWebsiteOptions } from './websiteReader.js';
import {
  DEFAULT_CLAUDE_MODEL, claudeProvider, createClaudeClient, placesProvider, redact, websiteProvider,
  type AiClassification, type ClaudeClient, type ProviderInput, type ProviderResult, type ResearchProvider, type SourceDraft,
} from './providers.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** A refused start or decision; the route answers `status` with `{ error: code }`. */
export class ResearchError extends Error {
  constructor(readonly code: 'research_running' | 'daily_limit' | 'locked' | 'already_decided' | 'forbidden', readonly status: number) {
    super(code);
  }
}

/** Test seams: the reader's resolver, fake Claude / Places clients and the environment (keys, model). */
export interface ResearchDeps {
  reader?: ReadWebsiteOptions;
  claude?: ClaudeClient;
  placesFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** Serialises run starts across the CRM (one at a time per company, and the daily limit). */
const START_LOCK = 4_042_001;
/** A run still Pending this long after it was queued is treated as lost (the worker never picked it up). */
const PENDING_STALE_MS = 4 * STALE_AFTER_MS;
const RESEARCH_FIELD_KEYS = new Set<string>(RESEARCH_FIELDS.map((f) => f.field));

// ---------------------------------------------------------------------------------------------------------------
// Settings and month totals

export type EnrichmentSettingsValues = {
  dailyRunLimit: number; claudeEnabled: boolean; claudeMonthlyCapUsd: number;
  placesEnabled: boolean; placesMonthlyCallCap: number; webSearchEnabled: boolean;
};

/** Row 1, or the defaults when it is missing. */
export async function loadEnrichmentSettings(db: Db): Promise<EnrichmentSettingsValues> {
  const row = await db.enrichmentSettings.findUnique({ where: { id: 1 } });
  if (!row) return { ...ENRICHMENT_SETTINGS_DEFAULTS };
  return {
    dailyRunLimit: row.dailyRunLimit, claudeEnabled: row.claudeEnabled, claudeMonthlyCapUsd: row.claudeMonthlyCapUsd.toNumber(),
    placesEnabled: row.placesEnabled, placesMonthlyCallCap: row.placesMonthlyCallCap, webSearchEnabled: row.webSearchEnabled,
  };
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfUtcMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Claude spend (USD) and Places Details calls recorded on runs this calendar month (UTC). */
export async function monthTotals(db: Db, now = new Date()): Promise<{ claudeUsd: number; placesCalls: number }> {
  const sum = await db.enrichmentRun.aggregate({
    where: { createdAt: { gte: startOfUtcMonth(now) } }, _sum: { costUsd: true, placesCalls: true },
  });
  return { claudeUsd: sum._sum.costUsd?.toNumber() ?? 0, placesCalls: sum._sum.placesCalls ?? 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Field helpers

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const jsonMap = <T>(v: Prisma.JsonValue): Record<string, T> =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, T>) } : {};

/** The company column a research field writes to. */
const columnOf = (field: string) => (field === 'aiPotentialServices' ? 'aiPotentialServices' : field);

/** The company's current value for a research field, as plain JSON (Decimal → number). */
export function currentValue(company: Company, field: string): unknown {
  const v = (company as unknown as Record<string, unknown>)[columnOf(field)];
  return Prisma.Decimal.isDecimal(v) ? (v as Prisma.Decimal).toNumber() : v ?? null;
}

/** A suggestion may only apply while the field is empty and not verified. */
export const isLocked = (company: Company, field: string) =>
  jsonMap<boolean>(company.verifiedFields)[field] === true || !isEmpty(currentValue(company, field));

/** Fields counted for the verification status (prototype store.js recomputeVerification). */
const VERIFICATION_FIELDS = [
  'name', 'legalName', 'website', 'industry', 'businessCategory', 'businessType', 'yearEstablished', 'description',
  'country', 'city', 'street', 'employeeCount', 'employeeRange', 'annualRevenue', 'registrationNumber', 'mainServices',
  'mainProducts', 'websiteTechnology',
];

function verificationStatus(company: Company, verified: Record<string, boolean>): string {
  const filled = VERIFICATION_FIELDS.filter((f) => !isEmpty((company as unknown as Record<string, unknown>)[f]));
  const done = filled.filter((f) => verified[f]);
  if (filled.length > 0 && done.length === filled.length) return 'Verified';
  return done.length > 0 ? 'Partially Verified' : 'Unverified';
}

// ---------------------------------------------------------------------------------------------------------------
// Starting a run

export interface StartOptions {
  companyId: number;
  trigger: string;
  userId: number | null;
  leadId?: number | null;
  /** Automatic runs are skipped (null) instead of refused when one is running or the limit is reached. */
  auto?: boolean;
}

/**
 * Queues a run: refuses (or, for automatic runs, skips) while the company has one Pending / Processing, or once the
 * day's run limit is reached. A run interrupted long ago (worker crash, host sleep) is marked Failed and no longer blocks.
 */
export async function startResearch(opts: StartOptions): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${START_LOCK})`;
    const now = new Date();
    const active = await tx.enrichmentRun.findMany({ where: { companyId: opts.companyId, status: { in: ['Pending', 'Processing'] } } });
    for (const run of active) {
      const stale = run.status === 'Processing'
        ? (run.startedAt ?? run.createdAt).getTime() < now.getTime() - STALE_AFTER_MS
        : run.createdAt.getTime() < now.getTime() - PENDING_STALE_MS;
      if (!stale) {
        if (opts.auto) return null;
        throw new ResearchError('research_running', 409);
      }
      await tx.enrichmentRun.update({ where: { id: run.id }, data: { status: 'Failed', result: 'Interrupted', error: 'Interrupted', finishedAt: now } });
    }
    const settings = await loadEnrichmentSettings(tx);
    const today = await tx.enrichmentRun.count({ where: { createdAt: { gte: startOfUtcDay(now) } } });
    if (today >= settings.dailyRunLimit) {
      if (opts.auto) return null;
      throw new ResearchError('daily_limit', 429);
    }
    const run = await tx.enrichmentRun.create({
      data: {
        companyId: opts.companyId, leadId: opts.leadId ?? null, trigger: opts.trigger.slice(0, 120), engine: 'Website reader',
        status: 'Pending', createdById: opts.userId,
      },
    });
    await tx.company.update({ where: { id: opts.companyId }, data: { aiResearchStatus: 'Pending' } });
    // One attempt: a retry could spend on Claude twice; a failed run is simply run again by hand.
    await enqueue(tx, 'research_company', { runId: run.id }, { maxAttempts: 1 });
    return run.id;
  });
}

/**
 * Automatic run for a lead created one at a time (New lead page, lead modal, lead from an email): only when its company
 * has a website and was never researched. Adds "AI enrichment queued for <company>" to the lead's timeline.
 * Never throws (the lead is already saved).
 */
export async function autoResearchForLead(leadId: number, userId: number, log?: (msg: string) => void): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { company: true } });
    const company = lead?.company;
    if (!lead || !company || !company.website || company.aiResearchStatus !== 'Not started') return;
    const runId = await startResearch({ companyId: company.id, trigger: `New lead ${lead.number}`, userId, leadId: lead.id, auto: true });
    if (runId === null) return;
    await prisma.leadActivity.create({
      data: {
        leadId: lead.id, activityType: 'ai', title: `AI enrichment queued for ${company.name}`, byUserId: null,
        body: "Status Pending. Results will appear under the company's AI Intelligence tab, marked as unverified.",
      },
    });
  } catch (err) {
    log?.(`auto research for lead ${leadId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Running a run (worker job research_company)

/** Value as stored in a suggestion / written to the column. */
function columnValue(field: string, value: unknown): unknown {
  if (field === 'lat' || field === 'lng') return new Prisma.Decimal(Number(value));
  return value;
}

/** Best finding per field (highest confidence; the earlier provider on a tie). */
function bestPerField(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const f of findings) {
    if (!RESEARCH_FIELD_KEYS.has(f.field)) continue;
    const cur = best.get(f.field);
    if (!cur || f.confidence > cur.confidence) best.set(f.field, f);
  }
  return [...best.values()];
}

/**
 * The run was released while it was working (it outlived the stale limit and was marked Interrupted, or a newer run
 * started): its results are dropped so they never overwrite the newer run's.
 */
class RunReleased extends Error {
  constructor() {
    super('run_released');
  }
}

/** Ends the run (still Processing) in `tx`; throws RunReleased, rolling the transaction back, when it is not. */
async function endRun(tx: Prisma.TransactionClient, runId: number, data: Prisma.EnrichmentRunUpdateManyMutationInput): Promise<void> {
  const ended = await tx.enrichmentRun.updateMany({ where: { id: runId, status: 'Processing' }, data });
  if (ended.count === 0) throw new RunReleased();
}

/** Locks the company row for the rest of the transaction and returns it as it is now. */
async function lockCompany(tx: Prisma.TransactionClient, companyId: number): Promise<Company> {
  await tx.$executeRaw`SELECT 1 FROM companies WHERE id = ${companyId} FOR UPDATE`;
  return tx.company.findUniqueOrThrow({ where: { id: companyId } });
}

/** Who hears that a run finished: the company's lead owner (the triggering lead's first), else who started it. */
async function runRecipient(
  tx: Prisma.TransactionClient, run: { leadId: number | null; createdById: number | null }, companyId: number,
): Promise<number | null> {
  const trigger = run.leadId ? await tx.lead.findUnique({ where: { id: run.leadId }, select: { assignedToId: true } }) : null;
  if (trigger?.assignedToId) return trigger.assignedToId;
  const anyLead = await tx.lead.findFirst({
    where: { companyId, assignedToId: { not: null }, archivedAt: null }, orderBy: { createdAt: 'desc' }, select: { assignedToId: true },
  });
  return anyLead?.assignedToId ?? run.createdById;
}

async function finishFailed(runId: number, companyId: number, message: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const company = await lockCompany(tx, companyId);
      const now = new Date();
      await endRun(tx, runId, { status: 'Failed', result: message, error: message, finishedAt: now });
      await tx.company.update({ where: { id: companyId }, data: { aiResearchStatus: 'Failed', aiLastResearchAt: now } });
      const run = await tx.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
      const to = await runRecipient(tx, run, companyId);
      if (to) await notifyUser(tx, to, `AI research failed · ${company.name}`, message, `/companies/${companyId}#ai`);
    });
  } catch (err) {
    if (!(err instanceof RunReleased)) throw err;
  }
}

/**
 * Runs a queued run. Only a Pending run is taken (a run already taken, or marked Interrupted, is left alone).
 * Never throws for a provider failure: the run is marked Failed with the reason instead.
 */
export async function runResearch(runId: number, deps: ResearchDeps = {}): Promise<void> {
  const claimed = await prisma.enrichmentRun.updateMany({
    where: { id: runId, status: 'Pending' }, data: { status: 'Processing', startedAt: new Date() },
  });
  if (claimed.count === 0) return;
  const run = await prisma.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
  const env = deps.env ?? process.env;
  const secrets = [env.ANTHROPIC_API_KEY, env.GOOGLE_PLACES_API_KEY];
  try {
    const company = await prisma.company.update({ where: { id: run.companyId }, data: { aiResearchStatus: 'Processing' } });
    if (!company.website) {
      await complete(run.id, company.id, { result: 'No website on file', sources: [], engine: 'Website reader', findings: [], drafts: [], costUsd: 0, placesCalls: 0 });
      return;
    }

    const input: ProviderInput = { company, pages: [], employeeRanges: [] };
    const website = await websiteProvider(deps.reader).run(input);
    if (website.error) {
      await finishFailed(run.id, company.id, website.error);
      return;
    }
    input.pages = website.pages ?? [];
    const results: ProviderResult[] = [website];
    const used: string[] = ['website'];
    let engine = 'Website reader';
    const notes: string[] = [];

    const settings = await loadEnrichmentSettings(prisma);
    const totals = await monthTotals(prisma);
    const placesKey = env.GOOGLE_PLACES_API_KEY;
    if (placesKey && settings.placesEnabled && settings.placesMonthlyCallCap > 0 && totals.placesCalls < settings.placesMonthlyCallCap) {
      const places = await placesProvider({ apiKey: placesKey, fetchImpl: deps.placesFetch }).run(input);
      results.push(places);
      used.push('places');
      if (places.error) notes.push(`Google Places: ${places.error}`);
    }

    const claudeKey = env.ANTHROPIC_API_KEY;
    if (claudeKey && settings.claudeEnabled && settings.claudeMonthlyCapUsd > 0 && totals.claudeUsd < settings.claudeMonthlyCapUsd) {
      const model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
      input.employeeRanges = (await prisma.lookupValue.findMany({
        where: { group: 'employee_range', isActive: true }, orderBy: { sortOrder: 'asc' }, select: { value: true },
      })).map((v) => v.value);
      const provider: ResearchProvider = claudeProvider({
        client: deps.claude ?? createClaudeClient(claudeKey), model, webSearch: settings.webSearchEnabled, secrets: [claudeKey],
      });
      const claude = await provider.run(input);
      results.push(claude);
      used.push('claude');
      if (settings.webSearchEnabled) used.push('websearch');
      engine = `Website reader + Claude ${model}`.slice(0, 120);
      if (claude.error) notes.push(claude.error);
    }

    await complete(run.id, company.id, {
      engine,
      sources: used,
      findings: bestPerField(results.flatMap((r) => r.findings)),
      drafts: results.flatMap((r) => r.sources),
      ai: Object.assign({}, ...results.map((r) => r.ai ?? {})) as AiClassification,
      costUsd: results.reduce((n, r) => n + (r.costUsd ?? 0), 0),
      placesCalls: results.reduce((n, r) => n + (r.placesCalls ?? 0), 0),
      notes,
    });
  } catch (err) {
    await finishFailed(run.id, run.companyId, redact(err instanceof Error ? err.message : 'Research failed', secrets));
  }
}

type Outcome = {
  engine: string;
  sources: string[];
  findings: Finding[];
  drafts: SourceDraft[];
  ai?: AiClassification;
  costUsd: number;
  placesCalls: number;
  /** Fixed result text (no suggestions counted). */
  result?: string;
  notes?: string[];
};

/** Writes the run's results in one transaction, against the company as it is now (a user may have edited it meanwhile). */
async function complete(runId: number, companyId: number, o: Outcome): Promise<void> {
  try {
    await completeTx(runId, companyId, o);
  } catch (err) {
    if (!(err instanceof RunReleased)) throw err;
  }
}

async function completeTx(runId: number, companyId: number, o: Outcome): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Locked: a hand edit or an accept committing meanwhile is seen, never overwritten.
    const company = await lockCompany(tx, companyId);
    const run = await tx.enrichmentRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'Processing') throw new RunReleased();
    const fresh = o.findings.filter((f) => !isLocked(company, f.field));
    if (fresh.length > 0) {
      await tx.enrichmentSuggestion.updateMany({
        where: { companyId, decision: 'pending', field: { in: fresh.map((f) => f.field) } }, data: { decision: 'superseded' },
      });
      await tx.enrichmentSuggestion.createMany({
        data: fresh.map((f) => ({
          runId, companyId, field: f.field, label: researchFieldLabel(f.field), value: f.value as Prisma.InputJsonValue,
          display: f.display ?? null, confidence: f.confidence, sourceUrl: f.sourceUrl, sourceLabel: f.sourceLabel.slice(0, 200),
        })),
      });
    }
    if (o.drafts.length > 0) {
      await tx.sourceRecord.createMany({
        data: o.drafts.map((d) => ({
          companyId, leadId: run.leadId, title: d.title.slice(0, 200), url: d.url?.slice(0, 500) ?? null, sourceType: d.sourceType,
          collectedBy: 'Enrichment worker', fieldsPopulated: d.fieldsPopulated.slice(0, 500), confidence: d.confidence.slice(0, 20),
          snapshot: d.snapshot,
        })),
      });
    }
    const n = fresh.length;
    const counted = `${n} suggestion${n === 1 ? '' : 's'}`;
    const result = o.result ?? [counted, ...(o.notes ?? [])].join(' · ');
    const now = new Date();
    await endRun(tx, runId, {
      status: 'Completed', engine: o.engine, sources: o.sources, result, finishedAt: now, costUsd: o.costUsd, placesCalls: o.placesCalls,
      error: o.notes?.length ? o.notes.join(' · ') : null,
    });
    await tx.company.update({ where: { id: companyId }, data: { aiResearchStatus: 'Completed', aiLastResearchAt: now, ...(o.ai ?? {}) } });
    await tx.lead.updateMany({ where: { companyId, enrichmentStatus: { not: 'Completed' } }, data: { enrichmentStatus: 'Completed' } });

    const to = await runRecipient(tx, run, companyId);
    if (to) await notifyUser(tx, to, `AI research completed · ${company.name}`, `${counted} to review`, `/companies/${companyId}#ai`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Decisions (users who may edit the company)

const assertCanEdit = (user: AuthUser) => {
  if (!can(user.role, 'manage_companies')) throw new ResearchError('forbidden', 403);
};

/** The suggestion with its company, or 404 when either is hidden from the user. */
async function visibleSuggestion(tx: Prisma.TransactionClient, user: AuthUser, id: number) {
  const s = Number.isInteger(id) ? await tx.enrichmentSuggestion.findUnique({ where: { id } }) : null;
  if (!s) throw new NotFoundError();
  await assertCompanyVisible(tx, user, s.companyId);
  return { s };
}

async function applySuggestion(
  tx: Prisma.TransactionClient, user: AuthUser, s: { id: number; runId: number; field: string; value: Prisma.JsonValue; confidence: number; sourceUrl: string },
  company: Company,
): Promise<Company> {
  const verified = jsonMap<boolean>(company.verifiedFields);
  verified[s.field] = true;
  const aiFields = jsonMap<unknown>(company.aiFields);
  aiFields[s.field] = { confidence: s.confidence, source: s.sourceUrl, runId: s.runId, acceptedAt: new Date().toISOString() };
  const written = { ...company, [columnOf(s.field)]: s.value } as Company;
  const after = await tx.company.update({
    where: { id: company.id },
    data: {
      [columnOf(s.field)]: columnValue(s.field, s.value) as never,
      verifiedFields: verified, aiFields: aiFields as Prisma.InputJsonValue,
      verificationStatus: verificationStatus(written, verified),
    },
  });
  await tx.enrichmentSuggestion.update({ where: { id: s.id }, data: { decision: 'accepted', decidedById: user.id, decidedAt: new Date() } });
  await tx.enrichmentRun.update({ where: { id: s.runId }, data: { appliedCount: { increment: 1 } } });
  await audit(tx, {
    entityType: 'company', entityId: company.id, action: 'update', userId: user.id,
    before: { [s.field]: currentValue(company, s.field) }, after: { [s.field]: s.value, acceptedSuggestion: s.id },
  });
  return after;
}

/** Accept or reject one pending suggestion. Accept refuses (locked) once the field became verified or filled. */
export async function decideSuggestion(user: AuthUser, id: number, accept: boolean): Promise<{ id: number; decision: string }> {
  assertCanEdit(user);
  return prisma.$transaction(async (tx) => {
    const { s } = await visibleSuggestion(tx, user, id);
    // Company row first (as acceptAllHigh and a finishing run), then the suggestion: concurrent accepts on other fields
    // and a hand edit committing meanwhile are seen, never overwritten; a double click decides once.
    const company = await lockCompany(tx, s.companyId);
    await tx.$executeRaw`SELECT 1 FROM enrichment_suggestions WHERE id = ${s.id} FOR UPDATE`;
    const current = await tx.enrichmentSuggestion.findUniqueOrThrow({ where: { id: s.id } });
    if (current.decision !== 'pending') throw new ResearchError('already_decided', 409);
    if (!accept) {
      await tx.enrichmentSuggestion.update({ where: { id: s.id }, data: { decision: 'rejected', decidedById: user.id, decidedAt: new Date() } });
      return { id: s.id, decision: 'rejected' };
    }
    if (isLocked(company, s.field)) throw new ResearchError('locked', 409);
    await applySuggestion(tx, user, current, company);
    return { id: s.id, decision: 'accepted' };
  });
}

/** "Accept all ≥ 80%": every pending suggestion with confidence 80 or more whose field is still open. */
export async function acceptAllHigh(user: AuthUser, companyId: number): Promise<{ accepted: number }> {
  assertCanEdit(user);
  return prisma.$transaction(async (tx) => {
    const visible = await assertCompanyVisible(tx, user, companyId);
    let company = await lockCompany(tx, visible.id);
    const pending = await tx.enrichmentSuggestion.findMany({
      where: { companyId, decision: 'pending', confidence: { gte: 80 } }, orderBy: { id: 'asc' },
    });
    let accepted = 0;
    for (const s of pending) {
      if (isLocked(company, s.field)) continue;
      company = await applySuggestion(tx, user, s, company);
      accepted += 1;
    }
    return { accepted };
  });
}

/** The fields a user edits on the company form (the PATCH body's keys). */
const PROFILE_FIELDS = Object.keys(CompanyUpdate.shape).filter((k) => k !== 'updatedAt' && k !== 'isClient');

/** "Mark profile verified": every filled field verified, verification status Verified; ai_fields cleared (prototype). */
export async function markProfileVerified(user: AuthUser, companyId: number): Promise<void> {
  assertCanEdit(user);
  await prisma.$transaction(async (tx) => {
    const company = await assertCompanyVisible(tx, user, companyId);
    const verified = jsonMap<boolean>(company.verifiedFields);
    for (const f of PROFILE_FIELDS) if (!isEmpty((company as unknown as Record<string, unknown>)[f])) verified[f] = true;
    await tx.company.update({ where: { id: company.id }, data: { verifiedFields: verified, aiFields: {}, verificationStatus: 'Verified' } });
    await audit(tx, {
      entityType: 'company', entityId: company.id, action: 'verify', userId: user.id,
      before: { verificationStatus: company.verificationStatus, verifiedFields: company.verifiedFields },
      after: { verificationStatus: 'Verified', verifiedFields: verified },
    });
  });
}

/** "+ Add source manually": type as chosen, by "<user> (manual)", notes kept as the snapshot. */
export async function addManualSource(user: AuthUser, companyId: number, body: ManualSourceCreate) {
  assertCanEdit(user);
  return prisma.$transaction(async (tx) => {
    await assertCompanyVisible(tx, user, companyId);
    return tx.sourceRecord.create({
      data: {
        companyId, title: body.title, url: body.url ?? null, sourceType: body.sourceType, collectedBy: `${user.name} (manual)`.slice(0, 120),
        fieldsPopulated: body.fieldsPopulated ?? '', confidence: 'Manual', snapshot: body.notes ?? null,
      },
    });
  });
}
