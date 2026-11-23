import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  CLOSED_STATUSES, CompanyBulkStatus, CompanyCreate, CompanyListQuery, CompanyUpdate, DuplicateCheck,
  can, checkDomain, isClosedStatus, normaliseCompanyName, pageArgs, type CompanyCandidate, type CompanyTab,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { NotFoundError, parseBody, parseQuery } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { assertCompanyVisible, companyWhere, visibleCompanyIds } from '../companies/visibility.js';
import { companyDetail, companyDetailInclude, companyListInclude, companyListRow } from '../companies/serialize.js';
import { leadWhere } from '../leads/visibility.js';
import { findCompanyMatches } from '../companies/match.js';
import { StaleError, isNotFound, isUniqueViolation } from '../prismaErrors.js';

/** The company's own columns for the audit log (drops included relations). */
const columns = <T extends { contacts?: unknown; _count?: unknown; createdBy?: unknown }>(row: T) => {
  const { contacts: _c, _count: _n, createdBy: _b, ...rest } = row;
  return rest;
};

/** A stored column value in a form comparable with a request value: Decimal → number, undefined → null. */
const comparable = (v: unknown): unknown => (v === undefined ? null : Prisma.Decimal.isDecimal(v) ? v.toNumber() : v);

/**
 * Fields a hand edit marks verified: every key present in the PATCH body whose value differs from the stored one
 * (release 4 — verified fields are never suggested by AI research).
 */
function changedFields(before: object, body: object): string[] {
  const was = before as Record<string, unknown>;
  return Object.entries(body)
    .filter(([k, v]) => v !== undefined && JSON.stringify(comparable(v)) !== JSON.stringify(comparable(was[k])))
    .map(([k]) => k);
}

/** `verified_fields` as stored ({ field: true }); anything else reads as none. */
const verifiedMap = (v: Prisma.JsonValue): Record<string, boolean> =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, boolean>) } : {};

/** Duplicate-check domain key from optional schema values (null means cleared). */
const domainFor = (website: string | null | undefined, businessEmail: string | null | undefined) =>
  checkDomain({ website: website ?? undefined, businessEmail: businessEmail ?? undefined });

/** 409 body for a domain unique violation: names the company holding the domain. */
async function domainTaken(domain: string | null, exceptId?: number) {
  if (!domain) return null;
  const holder = await prisma.company.findFirst({
    where: { domain, ...(exceptId !== undefined ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return holder ? { error: 'domain_taken', companyId: holder.id } : null;
}

/**
 * Normalised names shared by two or more companies the user may see (the "Duplicate review" tab), with the
 * number of companies under each. '' is no key (a name made only of legal suffixes), so it never groups.
 */
async function duplicateNameGroups(visible: Prisma.CompanyWhereInput): Promise<{ key: string; n: number }[]> {
  const groups = await prisma.company.groupBy({
    by: ['nameNormalised'],
    where: { AND: [visible, { nameNormalised: { not: '' } }] },
    having: { nameNormalised: { _count: { gt: 1 } } },
    _count: { _all: true },
    orderBy: { nameNormalised: 'asc' },
  });
  return groups.map((g) => ({ key: g.nameNormalised, n: g._count._all }));
}

export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/companies', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const query = parseQuery(CompanyListQuery, request.query);
    const visible = companyWhere(user);
    const leadsSeen = leadWhere(user);
    // Runs alongside the other queries; only the rows of the dups tab wait for it.
    const dupGroups = duplicateNameGroups(visible);
    const tabWhere: Record<Exclude<CompanyTab, 'dups'>, Prisma.CompanyWhereInput> = {
      all: {},
      clients: { isClient: true },
      open: { leads: { some: { AND: [leadsSeen, { status: { notIn: [...CLOSED_STATUSES] } }] } } },
      verify: { verificationStatus: { not: 'Verified' } },
    };
    const tab = query.tab ?? 'all';
    const and: Prisma.CompanyWhereInput[] = [visible];
    if (tab !== 'dups') and.push(tabWhere[tab]);
    if (query.status) and.push({ status: query.status });
    if (query.country) and.push({ country: { equals: query.country, mode: 'insensitive' } });
    if (query.industry) and.push({ industry: { equals: query.industry, mode: 'insensitive' } });
    if (query.employeeRange) and.push({ employeeRange: query.employeeRange });
    if (query.verification) and.push({ verificationStatus: query.verification });
    if (query.isClient !== undefined) and.push({ isClient: query.isClient });
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' as const };
      and.push({ OR: [{ name: contains }, { legalName: contains }, { domain: contains }, { number: contains }] });
    }
    const sort = query.sort ?? 'name';
    const page = async () => {
      if (tab === 'dups') and.push({ nameNormalised: { in: (await dupGroups).map((g) => g.key) } });
      const where: Prisma.CompanyWhereInput = { AND: and };
      return prisma.$transaction([
        prisma.company.count({ where }),
        prisma.company.findMany({
          where,
          include: companyListInclude(leadsSeen),
          orderBy: [{ [sort]: query.dir }, { id: query.dir }],
          ...pageArgs(query),
        }),
      ]);
    };
    // Tiles and tab counts cover every company the user may see (not the filters), like the prototype.
    // 8 queries: count + rows, three groupBys, clients, open, and the duplicate-name groups.
    const within = (extra: Prisma.CompanyWhereInput): Prisma.CompanyWhereInput => ({ AND: [visible, extra] });
    const [[total, rows], byStatus, byVerification, byResearch, clients, open, dupNames] = await Promise.all([
      page(),
      prisma.company.groupBy({ by: ['status'], where: visible, _count: { _all: true } }),
      prisma.company.groupBy({ by: ['verificationStatus'], where: visible, _count: { _all: true } }),
      prisma.company.groupBy({ by: ['aiResearchStatus'], where: visible, _count: { _all: true } }),
      prisma.company.count({ where: within(tabWhere.clients) }),
      prisma.company.count({ where: within(tabWhere.open) }),
      dupGroups,
    ]);
    const dups = dupNames.reduce((n, g) => n + g.n, 0);
    const tally = (pairs: [string, number][]) => (v: string) => pairs.find(([k]) => k === v)?.[1] ?? 0;
    const status = tally(byStatus.map((g) => [g.status, g._count._all]));
    const verification = tally(byVerification.map((g) => [g.verificationStatus, g._count._all]));
    const research = tally(byResearch.map((g) => [g.aiResearchStatus, g._count._all]));
    const all = byStatus.reduce((n, g) => n + g._count._all, 0);
    const verify = all - verification('Verified');
    return {
      items: rows.map(companyListRow),
      total,
      page: query.page,
      pageSize: query.pageSize,
      tiles: {
        total: all,
        active: status('Active'),
        inactive: status('Inactive'),
        closed: status('Closed'),
        verified: verification('Verified'),
        partiallyVerified: verification('Partially Verified'),
        unverified: verification('Unverified'),
        aiQueue: research('Pending') + research('Processing'),
        aiPending: research('Pending'),
        aiProcessing: research('Processing'),
        aiFailed: research('Failed'),
        possibleDuplicates: dups,
      },
      counts: { all, clients, open, verify, dups },
    };
  });

  app.post('/companies', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const body = parseBody(CompanyCreate, request.body);
    const domain = domainFor(body.website, body.businessEmail);
    try {
      const created = await prisma.$transaction(async (tx) => {
        const row = await tx.company.create({
          data: { ...body, nameNormalised: normaliseCompanyName(body.name), domain, createdById: request.user!.id },
          include: companyDetailInclude,
        });
        await audit(tx, { entityType: 'company', entityId: row.id, action: 'create', userId: request.user!.id, after: columns(row) });
        return row;
      });
      return reply.code(201).send(companyDetail(created));
    } catch (e) {
      if (isUniqueViolation(e)) {
        const taken = await domainTaken(domain);
        if (taken) return reply.code(409).send(taken);
      }
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/companies/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = await assertCompanyVisible(prisma, request.user!, Number(request.params.id));
    const row = await prisma.company.findUnique({ where: { id }, include: companyDetailInclude });
    if (!row) throw new NotFoundError();
    return companyDetail(row);
  });

  app.get<{ Params: { id: string } }>('/companies/:id/pipeline', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = await assertCompanyVisible(prisma, user, Number(request.params.id));
    const groups = await prisma.lead.groupBy({
      by: ['status'],
      where: { AND: [{ companyId: id }, leadWhere(user)] },
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const byStatus = groups.map((g) => ({ status: g.status, count: g._count._all }));
    const of = (status: string) => byStatus.find((g) => g.status === status)?.count ?? 0;
    return {
      byStatus,
      open: byStatus.filter((g) => !isClosedStatus(g.status)).reduce((n, g) => n + g.count, 0),
      won: of('Won'),
      lost: of('Lost'),
    };
  });

  app.patch<{ Params: { id: string } }>('/companies/:id', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const { updatedAt, ...body } = parseBody(CompanyUpdate, request.body);
    const id = Number(request.params.id);
    const user = request.user!;
    // The Client flag is a management decision: only Administrators / Managers (view_all_leads) may set it.
    if (body.isClient !== undefined && !can(user.role, 'view_all_leads')) return reply.code(403).send({ error: 'forbidden' });
    let domain: string | null = null;
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const before = await assertCompanyVisible(tx, user, id);
        if (new Date(updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
        const data: Prisma.CompanyUpdateInput = { ...body };
        if (body.name !== undefined) data.nameNormalised = normaliseCompanyName(body.name);
        domain = before.domain;
        if (body.website !== undefined || body.businessEmail !== undefined) {
          domain = domainFor(
            body.website !== undefined ? body.website : before.website,
            body.businessEmail !== undefined ? body.businessEmail : before.businessEmail,
          );
          data.domain = domain;
        }
        const changed = changedFields(before, body);
        if (changed.length > 0) {
          const verified = verifiedMap(before.verifiedFields);
          for (const k of changed) verified[k] = true;
          data.verifiedFields = verified;
          // The value is now the user's, no longer AI's.
          const ai = verifiedMap(before.aiFields) as Record<string, unknown>;
          if (changed.some((k) => k in ai)) {
            for (const k of changed) delete ai[k];
            data.aiFields = ai as Prisma.InputJsonValue;
          }
        }
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        const after = await tx.company.update({ where: { id, updatedAt: before.updatedAt }, data, include: companyDetailInclude });
        await audit(tx, { entityType: 'company', entityId: id, action: 'update', userId: user.id, before, after: columns(after) });
        return after;
      });
      return companyDetail(updated);
    } catch (e) {
      if (e instanceof StaleError || isNotFound(e)) return reply.code(409).send({ error: 'stale' });
      if (isUniqueViolation(e)) {
        const taken = await domainTaken(domain, id);
        if (taken) return reply.code(409).send(taken);
      }
      throw e;
    }
  });

  app.post('/companies/check-duplicates', { preHandler: [requireUser] }, async (request) => {
    const body = parseBody(DuplicateCheck, request.body);
    const matches = await findCompanyMatches(prisma, body);
    const ids = [...(matches.auto ? [matches.auto.id] : []), ...matches.review.map((r) => r.candidate.id)];
    const visible = await visibleCompanyIds(prisma, request.user!, ids);
    // A hidden company is still reported (id, number, name) so the user knows it exists.
    const shown = (c: CompanyCandidate) => (visible.has(c.id) ? c : { id: c.id, number: c.number, name: c.name });
    return {
      auto: matches.auto ? shown(matches.auto) : null,
      review: matches.review.map((r) => ({ candidate: shown(r.candidate), how: r.how })),
    };
  });

  app.post('/companies/bulk-status', { preHandler: [requireRight('manage_companies')] }, async (request) => {
    const body = parseBody(CompanyBulkStatus, request.body);
    const user = request.user!;
    const updated = await prisma.$transaction(async (tx) => {
      const rows = await tx.company.findMany({
        where: { id: { in: body.ids }, status: { not: body.status }, ...companyWhere(user) },
        select: { id: true, status: true },
        orderBy: { id: 'asc' },
      });
      if (rows.length === 0) return 0;
      await tx.company.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: body.status } });
      for (const r of rows) {
        await audit(tx, {
          entityType: 'company', entityId: r.id, action: 'update', userId: user.id,
          before: { status: r.status }, after: { status: body.status },
        });
      }
      return rows.length;
    });
    return { updated };
  });
};
