import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  ContactCreate, ContactDuplicateCheck, ContactListQuery, ContactUpdate,
  normalisePhone, pageArgs, type ContactCandidate,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { NotFoundError, parseBody, parseQuery } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { assertCompanyVisible, companyWhere } from '../companies/visibility.js';
import { contactSummary, contactSummaryInclude } from '../companies/serialize.js';
import { findContactMatches } from '../companies/match.js';
import { assertLookupValue } from '../companies/lookups.js';

type Tx = Prisma.TransactionClient;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const isNotFound = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025';

class StaleError extends Error {}
class CompanyInactiveError extends Error {}
class LastPrimaryError extends Error {}

/** Stored matching key for a phone or mobile: '' (under 8 digits) is stored as null. */
const phoneKey = (v: string | null | undefined) => normalisePhone(v) || null;

/** The contact's own columns for the audit log (drops the included company). */
const columns = <T extends { company?: unknown }>(row: T) => {
  const { company: _c, ...rest } = row;
  return rest;
};

/**
 * Clears the company's current primary contact (audited). Callers set the new primary in the
 * same transaction, so the partial unique index contacts_one_primary_per_company never trips.
 */
async function clearPrimary(tx: Tx, companyId: number, userId: number): Promise<void> {
  const current = await tx.contact.findFirst({ where: { companyId, isPrimary: true }, select: { id: true } });
  if (!current) return;
  await tx.contact.update({ where: { id: current.id }, data: { isPrimary: false } });
  await audit(tx, {
    entityType: 'contact', entityId: current.id, action: 'update', userId,
    before: { isPrimary: true }, after: { isPrimary: false },
  });
}

export const contactRoutes: FastifyPluginAsync = async (app) => {
  app.get('/contacts', { preHandler: [requireUser] }, async (request) => {
    const query = parseQuery(ContactListQuery, request.query);
    const and: Prisma.ContactWhereInput[] = [{ company: companyWhere(request.user!) }];
    if (query.companyId !== undefined) and.push({ companyId: query.companyId });
    if (query.contactType) and.push({ contactType: query.contactType });
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' as const };
      and.push({
        OR: [{ firstName: contains }, { lastName: contains }, { businessEmail: contains }, { company: { name: contains } }],
      });
    }
    const where: Prisma.ContactWhereInput = { AND: and };
    const sort = query.sort ?? 'lastName';
    const order: Prisma.ContactOrderByWithRelationInput =
      sort === 'company' ? { company: { name: query.dir } } : { [sort]: query.dir };
    const [total, rows] = await prisma.$transaction([
      prisma.contact.count({ where }),
      prisma.contact.findMany({
        where,
        include: contactSummaryInclude,
        orderBy: [order, { id: query.dir }],
        ...pageArgs(query),
      }),
    ]);
    return { items: rows.map(contactSummary), total, page: query.page, pageSize: query.pageSize };
  });

  app.post('/contacts', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const body = parseBody(ContactCreate, request.body);
    const user = request.user!;
    try {
      const created = await prisma.$transaction(async (tx) => {
        const company = await assertCompanyVisible(tx, user, body.companyId);
        if (company.status === 'Closed') throw new CompanyInactiveError();
        await assertLookupValue(tx, 'contact_type', body.contactType, 'contactType');
        const existing = await tx.contact.count({ where: { companyId: company.id } });
        // The first contact of a company is always its primary.
        const isPrimary = existing === 0 || body.isPrimary;
        if (isPrimary && existing > 0) await clearPrimary(tx, company.id, user.id);
        const row = await tx.contact.create({
          data: { ...body, isPrimary, phoneNormalised: phoneKey(body.phone), mobileNormalised: phoneKey(body.mobile) },
          include: contactSummaryInclude,
        });
        await audit(tx, { entityType: 'contact', entityId: row.id, action: 'create', userId: user.id, after: columns(row) });
        return row;
      });
      return reply.code(201).send(contactSummary(created));
    } catch (e) {
      if (e instanceof CompanyInactiveError) return reply.code(409).send({ error: 'company_inactive' });
      // A concurrent primary change for the same company tripped the one-primary index.
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'stale' });
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>('/contacts/:id', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const { updatedAt, ...body } = parseBody(ContactUpdate, request.body);
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const user = request.user!;
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const before = await tx.contact.findFirst({ where: { id, company: companyWhere(user) } });
        if (!before) throw new NotFoundError();
        if (new Date(updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
        if (body.contactType !== undefined) await assertLookupValue(tx, 'contact_type', body.contactType, 'contactType');
        // A company with contacts always has exactly one primary: change it by promoting another contact.
        if (body.isPrimary === false && before.isPrimary) throw new LastPrimaryError();
        if (body.isPrimary === true && !before.isPrimary) await clearPrimary(tx, before.companyId, user.id);
        const data: Prisma.ContactUpdateInput = { ...body };
        if (body.phone !== undefined) data.phoneNormalised = phoneKey(body.phone);
        if (body.mobile !== undefined) data.mobileNormalised = phoneKey(body.mobile);
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        const after = await tx.contact.update({ where: { id, updatedAt: before.updatedAt }, data, include: contactSummaryInclude });
        await audit(tx, { entityType: 'contact', entityId: id, action: 'update', userId: user.id, before, after: columns(after) });
        return after;
      });
      return contactSummary(updated);
    } catch (e) {
      if (e instanceof LastPrimaryError) return reply.code(400).send({ error: 'last_primary_contact' });
      if (e instanceof StaleError || isNotFound(e) || isUniqueViolation(e)) return reply.code(409).send({ error: 'stale' });
      throw e;
    }
  });

  app.post('/contacts/check-duplicates', { preHandler: [requireUser] }, async (request) => {
    const input = parseBody(ContactDuplicateCheck, request.body);
    const matches = await findContactMatches(prisma, input);
    const companyIds = [
      ...new Set([...(matches.auto ? [matches.auto.companyId] : []), ...matches.review.map((r) => r.candidate.companyId)]),
    ];
    const where = companyWhere(request.user!);
    const visible = new Set(
      Object.keys(where).length === 0 || companyIds.length === 0
        ? companyIds
        : (await prisma.company.findMany({ where: { id: { in: companyIds }, ...where }, select: { id: true } })).map((c) => c.id),
    );
    // A contact on a hidden company is still reported (no email or phone keys) so the user knows it exists.
    const shown = (c: ContactCandidate) =>
      visible.has(c.companyId) ? c : { id: c.id, companyId: c.companyId, firstName: c.firstName, lastName: c.lastName };
    return {
      auto: matches.auto ? shown(matches.auto) : null,
      review: matches.review.map((r) => ({ candidate: shown(r.candidate), how: r.how })),
    };
  });
};
