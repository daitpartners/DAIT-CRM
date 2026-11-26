import type { Prisma, PrismaClient } from '@prisma/client';
import { CLOSED_STATUSES, domainOf } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { activeUser } from '../leads/visibility.js';
import { isExcludedDomain, normaliseAddress } from './leadMail.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface MailLinks {
  leadId: number | null;
  contactId: number | null;
  companyId: number | null;
}

/** The mailbox owner as a request user (scopes the conversation lookup); null when inactive. */
export const mailUser = activeUser;

const NONE: MailLinks = { leadId: null, contactId: null, companyId: null };

/**
 * The lead among `where` that mail links to, whoever owns it (archived and closed included): an open lead (not closed,
 * not archived) first, then the most recently updated.
 */
async function pickLead(db: Db, where: Prisma.LeadWhereInput): Promise<number | null> {
  const leads = await db.lead.findMany({
    where,
    select: { id: true, status: true, archivedAt: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  });
  const isOpen = (l: (typeof leads)[number]) => l.archivedAt === null && !(CLOSED_STATUSES as readonly string[]).includes(l.status);
  return (leads.find(isOpen) ?? leads[0])?.id ?? null;
}

/** Ids of leads whose address (trimmed, any case) is one of `addresses`. */
async function leadsAt(db: Db, addresses: string[]): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM leads WHERE lower(trim(business_email)) = ANY(${addresses}::text[])`;
  return rows.map((r) => r.id);
}

/** Ids of leads whose address (trimmed, any case) is at exactly `domain`. */
async function leadsAtDomain(db: Db, domain: string): Promise<number[]> {
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM leads WHERE right(lower(trim(business_email)), length(${domain}) + 1) = '@' || ${domain}`;
  return rows.map((r) => r.id);
}

/**
 * Links for a synced or composed message (web-mail release 1: lead visibility is ignored, `user` only scopes the
 * conversation lookup), first hit wins:
 * 1. the user's own linked conversation, as stored (its lead kept even if since moved to someone else);
 * 2. a lead's own address → that lead, its company and contact;
 * 3. a contact's address → the contact, its company, and the contact's lead, else the company's;
 * 4. a domain (not free mail, shared host, our own or the mailbox's): the company with that domain and its lead; else a
 *    lead with an address there (its company and lead, or that lead alone when it has no company); else a contact
 *    there whose company has a lead; else the company alone.
 * Several leads: an open one first, then the most recently updated (`pickLead`). Addresses compare trimmed, any case.
 */
export async function matchMail(
  db: Db, user: AuthUser, m: { threadId: string | null; counterparts: string[]; ownAddress: string },
): Promise<MailLinks> {
  if (m.threadId) {
    const linked = await db.emailMessage.findFirst({
      where: { userId: user.id, threadId: m.threadId, OR: [{ leadId: { not: null } }, { companyId: { not: null } }] },
      select: { leadId: true, contactId: true, companyId: true },
      orderBy: { occurredAt: 'desc' },
    });
    if (linked) return linked;
  }

  const addresses = [...new Set(m.counterparts.map(normaliseAddress).filter(Boolean))];
  if (addresses.length === 0) return NONE;

  const byAddress = await leadsAt(db, addresses);
  if (byAddress.length > 0) {
    const leadId = (await pickLead(db, { id: { in: byAddress } }))!;
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { contactId: true, companyId: true } });
    return { leadId, contactId: lead.contactId, companyId: lead.companyId };
  }

  // The first address (in the order given) that is a contact's; an active contact before an inactive one.
  const [contact] = await db.$queryRaw<{ id: number; companyId: number }[]>`
    SELECT id, company_id AS "companyId" FROM contacts
    WHERE lower(trim(business_email)) = ANY(${addresses}::text[])
    ORDER BY array_position(${addresses}::text[], lower(trim(business_email))), is_active DESC, id ASC
    LIMIT 1`;
  if (contact) {
    const leadId = (await pickLead(db, { contactId: contact.id })) ?? (await pickLead(db, { companyId: contact.companyId }));
    return { leadId, contactId: contact.id, companyId: contact.companyId };
  }

  const ownDomain = domainOf(m.ownAddress);
  const domains = [...new Set(addresses.map(domainOf))].filter(
    (d): d is string => d !== null && !isExcludedDomain(d, ownDomain ? [ownDomain] : []),
  );
  let companyOnly: number | null = null;
  for (const domain of domains) {
    const company = await db.company.findUnique({ where: { domain }, select: { id: true } });
    if (company) {
      const leadId = await pickLead(db, { companyId: company.id });
      if (leadId) return { leadId, contactId: null, companyId: company.id };
      companyOnly ??= company.id;
    }

    const atDomain = await leadsAtDomain(db, domain);
    if (atDomain.length > 0) {
      const found = await db.lead.findUniqueOrThrow({
        where: { id: (await pickLead(db, { id: { in: atDomain } }))! },
        select: { id: true, companyId: true },
      });
      if (found.companyId === null) return { leadId: found.id, contactId: null, companyId: null };
      return { leadId: await pickLead(db, { companyId: found.companyId }), contactId: null, companyId: found.companyId };
    }

    const [viaContact] = await db.$queryRaw<{ companyId: number }[]>`
      SELECT c.company_id AS "companyId" FROM contacts c
      WHERE right(lower(trim(c.business_email)), length(${domain}) + 1) = '@' || ${domain}
        AND EXISTS (SELECT 1 FROM leads l WHERE l.company_id = c.company_id)
      ORDER BY c.is_active DESC, c.id ASC
      LIMIT 1`;
    if (viaContact) {
      return { leadId: await pickLead(db, { companyId: viaContact.companyId }), contactId: null, companyId: viaContact.companyId };
    }
  }
  return companyOnly !== null ? { ...NONE, companyId: companyOnly } : NONE;
}
