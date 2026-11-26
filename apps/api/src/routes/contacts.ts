import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import {
  ContactCreate, ContactDuplicateCheck, ContactListQuery, ContactMove, ContactUpdate,
  normalisePhone, pageArgs, type ContactCandidate,
} from '@dait-crm/shared';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { suppressed } from '../mailer/suppression.js';
import { NotFoundError, ValidationError, parseBody, parseQuery } from '../validate.js';
import { requireRight, requireUser } from '../plugins/auth.js';
import { assertCompanyVisible, companyWhere, visibleCompanyIds } from '../companies/visibility.js';
import { contactProfile, contactSummary, contactSummaryInclude } from '../companies/serialize.js';
import { findContactMatches } from '../companies/match.js';
import { assertLookupValue } from '../companies/lookups.js';
import { StaleError, isNotFound, isUniqueViolation } from '../prismaErrors.js';

type Tx = Prisma.TransactionClient;


class CompanyInactiveError extends Error {}
class LastPrimaryError extends Error {}
class ContactInactiveError extends Error {}

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
    // Pickers and lists show active contacts; `inactive=1` adds the deactivated ones.
    if (!query.inactive) and.push({ isActive: true });
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

  /** One contact with its full profile; 404 unless its company is visible to the user. */
  app.get<{ Params: { id: string } }>('/contacts/:id', { preHandler: [requireUser] }, async (request) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) throw new NotFoundError();
    const row = await prisma.contact.findFirst({ where: { id, company: companyWhere(request.user!) }, include: contactSummaryInclude });
    if (!row) throw new NotFoundError();
    return contactProfile(row);
  });

  app.post('/contacts', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const body = parseBody(ContactCreate, request.body);
    const user = request.user!;
    try {
      const created = await prisma.$transaction(async (tx) => {
        const company = await assertCompanyVisible(tx, user, body.companyId);
        if (company.status === 'Closed') throw new CompanyInactiveError();
        await assertLookupValue(tx, 'contact_type', body.contactType, 'contactType');
        const hasPrimary = (await tx.contact.count({ where: { companyId: company.id, isPrimary: true } })) > 0;
        // The first (active) contact of a company is always its primary.
        const isPrimary = !hasPrimary || body.isPrimary;
        if (isPrimary && hasPrimary) await clearPrimary(tx, company.id, user.id);
        // An address on the suppression list (a deleted lead or contact opted out): unsubscribed from the start.
        const listed = (await suppressed(tx, [body.businessEmail])).size > 0;
        const row = await tx.contact.create({
          data: {
            ...body, isPrimary, phoneNormalised: phoneKey(body.phone), mobileNormalised: phoneKey(body.mobile),
            unsubscribedAt: listed ? new Date() : null,
          },
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
        const data: Prisma.ContactUpdateInput = { ...body };
        // Changed to an address on the suppression list: unsubscribed (kept when already so).
        if (body.businessEmail && body.businessEmail.toLowerCase() !== (before.businessEmail ?? '').toLowerCase() && !before.unsubscribedAt
          && (await suppressed(tx, [body.businessEmail])).size > 0) data.unsubscribedAt = new Date();
        const deactivating = before.isActive && body.isActive === false;
        const reactivating = !before.isActive && body.isActive === true;
        // Only an active contact can be primary.
        if (body.isPrimary === true && !(body.isActive ?? before.isActive)) throw new ContactInactiveError();
        if (deactivating && before.isPrimary) {
          // A company with active contacts always has exactly one primary: promote another contact first.
          // The last active contact may go, leaving the company without a primary.
          const others = await tx.contact.count({ where: { companyId: before.companyId, isActive: true, id: { not: id } } });
          if (others > 0) throw new LastPrimaryError();
          data.isPrimary = false;
        } else if (body.isPrimary === false && before.isPrimary) {
          throw new LastPrimaryError();
        }
        if (body.isPrimary === true && !before.isPrimary) {
          await clearPrimary(tx, before.companyId, user.id);
        } else if (reactivating && (await tx.contact.count({ where: { companyId: before.companyId, isPrimary: true } })) === 0) {
          // Reactivating a contact of a company left without a primary makes it the primary again.
          data.isPrimary = true;
        }
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
      if (e instanceof ContactInactiveError) return reply.code(400).send({ error: 'contact_inactive' });
      if (e instanceof StaleError || isNotFound(e) || isUniqueViolation(e)) return reply.code(409).send({ error: 'stale' });
      throw e;
    }
  });

  /**
   * Moves a contact to another visible, not-Closed company. A primary contact stops being primary
   * at its old company (which may be left without one); at the new company it becomes primary only
   * if that company has none. Leads of other companies that pointed at the contact lose it, each
   * with a note on its timeline.
   */
  app.post<{ Params: { id: string } }>('/contacts/:id/move', { preHandler: [requireRight('manage_companies')] }, async (request, reply) => {
    const body = parseBody(ContactMove, request.body);
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'not_found' });
    const user = request.user!;
    try {
      const moved = await prisma.$transaction(async (tx) => {
        // Lock order as everywhere: leads, then the contact (Do not email locks its lead, then the contact).
        await tx.$queryRaw`SELECT id FROM leads WHERE contact_id = ${id} ORDER BY id FOR UPDATE`;
        const before = await tx.contact.findFirst({ where: { id, company: companyWhere(user) } });
        if (!before) throw new NotFoundError();
        if (new Date(body.updatedAt).getTime() !== before.updatedAt.getTime()) throw new StaleError();
        const target = await assertCompanyVisible(tx, user, body.companyId);
        if (target.status === 'Closed') throw new CompanyInactiveError();
        if (target.id === before.companyId) {
          throw new ValidationError([{ path: ['companyId'], message: 'The contact is already at this company' }]);
        }
        const targetHasPrimary = (await tx.contact.count({ where: { companyId: target.id, isPrimary: true } })) > 0;
        const isPrimary = before.isActive && !targetHasPrimary;
        // Matching updatedAt in the where makes a concurrent write since `before` a P2025 (stale).
        const after = await tx.contact.update({
          where: { id, updatedAt: before.updatedAt }, data: { companyId: target.id, isPrimary }, include: contactSummaryInclude,
        });
        await audit(tx, {
          entityType: 'contact', entityId: id, action: 'update', userId: user.id,
          before: { companyId: before.companyId, isPrimary: before.isPrimary },
          after: { companyId: target.id, isPrimary },
        });
        const leads = await tx.lead.findMany({
          where: { contactId: id, OR: [{ companyId: null }, { companyId: { not: target.id } }] },
          select: { id: true },
        });
        if (leads.length > 0) {
          const ids = leads.map((l) => l.id);
          await tx.lead.updateMany({ where: { id: { in: ids } }, data: { contactId: null } });
          await tx.leadActivity.createMany({
            data: ids.map((leadId) => ({ leadId, activityType: 'note', title: `Contact moved to ${target.name}`, byUserId: user.id })),
          });
          for (const leadId of ids) {
            await audit(tx, {
              entityType: 'lead', entityId: leadId, action: 'update', userId: user.id,
              before: { contactId: id }, after: { contactId: null },
            });
          }
        }
        return after;
      });
      return contactSummary(moved);
    } catch (e) {
      if (e instanceof CompanyInactiveError) return reply.code(409).send({ error: 'company_inactive' });
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
    const visible = await visibleCompanyIds(prisma, request.user!, companyIds);
    // A contact on a hidden company is still reported (no email or phone keys) so the user knows it exists.
    const shown = (c: ContactCandidate) =>
      visible.has(c.companyId) ? c : { id: c.id, companyId: c.companyId, firstName: c.firstName, lastName: c.lastName };
    return {
      auto: matches.auto ? shown(matches.auto) : null,
      review: matches.review.map((r) => ({ candidate: shown(r.candidate), how: r.how })),
    };
  });
};
