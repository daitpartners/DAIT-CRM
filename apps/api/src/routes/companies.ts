import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  CompanyBulkStatus, CompanyCreate, CompanyListQuery, CompanyUpdate, DuplicateCheck,
  checkDomain, normaliseCompanyName, pageArgs, type CompanyCandidate,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { parseBody, parseQuery } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { companyWhere } from '../companies/visibility.js';
import { companyDetail, companyDetailInclude, companySummary, companySummaryInclude } from '../companies/serialize.js';
import { findCompanyMatches } from '../companies/match.js';

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const isNotFound = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';

class StaleError extends Error {}

/** The company's own columns for the audit log (drops included relations). */
const columns = <T extends { contacts?: unknown; _count?: unknown; createdBy?: unknown }>(row: T) => {
  const { contacts: _c, _count: _n, createdBy: _b, ...rest } = row;
  return rest;
};

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

export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/companies', { preHandler: [requireUser] }, async (request) => {
    const query = parseQuery(CompanyListQuery, request.query);
    const and: Prisma.CompanyWhereInput[] = [companyWhere(request.user!)];
    if (query.status) and.push({ status: query.status });
    if (query.country) and.push({ country: { equals: query.country, mode: 'insensitive' } });
    if (query.industry) and.push({ industry: { equals: query.industry, mode: 'insensitive' } });
    if (query.isClient !== undefined) and.push({ isClient: query.isClient });
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' as const };
      and.push({ OR: [{ name: contains }, { legalName: contains }, { domain: contains }, { number: contains }] });
    }
    const where: Prisma.CompanyWhereInput = { AND: and };
    const sort = query.sort ?? 'name';
    const [total, rows] = await prisma.$transaction([
      prisma.company.count({ where }),
      prisma.company.findMany({
        where,
        include: companySummaryInclude,
        orderBy: [{ [sort]: query.dir }, { id: query.dir }],
        ...pageArgs(query),
      }),
    ]);
    return { items: rows.map(companySummary), total, page: query.page, pageSize: query.pageSize };
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

  app.get<{ Params: { id: string } }>('/companies/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const row = await prisma.company.findFirst({ where: { id, ...companyWhere(request.user!) }, include: companyDetailInclude });
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return companyDetail(row);
  });

  app.patch<{ Params: { id: string } }>('/companies/:id', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const { updatedAt, ...body } = parseBody(CompanyUpdate, request.body);
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const user = request.user!;
    let domain: string | null = null;
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const before = await tx.company.findFirst({ where: { id, ...companyWhere(user) } });
        if (!before) return null;
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
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        const after = await tx.company.update({ where: { id, updatedAt: before.updatedAt }, data, include: companyDetailInclude });
        await audit(tx, { entityType: 'company', entityId: id, action: 'update', userId: user.id, before, after: columns(after) });
        return after;
      });
      if (!updated) return reply.code(404).send({ error: 'not_found' });
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
    const where = companyWhere(request.user!);
    const visible = new Set(
      Object.keys(where).length === 0 || ids.length === 0
        ? ids
        : (await prisma.company.findMany({ where: { id: { in: ids }, ...where }, select: { id: true } })).map((c) => c.id),
    );
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
