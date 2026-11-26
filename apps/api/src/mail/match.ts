import type { Prisma, PrismaClient } from '@prisma/client';
import { CLOSED_STATUSES, domainOf, isFreeMail } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { activeUser, leadWhere } from '../leads/visibility.js';
import { isExcludedDomain, isOwnDomain, normaliseAddress } from './leadMail.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface MailLinks {
  leadId: number | null;
  contactId: number | null;
  companyId: number | null;
}

/** The mailbox owner as a request user (mail: the conversation lookup; calendar: lead visibility); null when inactive. */
export const mailUser = activeUser;

const NONE: MailLinks = { leadId: null, contactId: null, companyId: null };

/**
 * The lead among `where` that mail links to, whoever owns it (archived and closed included): an open lead (not closed,
 * not archived) first, then the most recently updated.
 */
async function pickLead(db: Db, where: Prisma.LeadWhereInput): Promise<PickedLead | null> {
  const leads = await db.lead.findMany({
    where,
    select: { id: true, contactId: true, companyId: true, status: true, archivedAt: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  });
  const isOpen = (l: (typeof leads)[number]) => l.archivedAt === null && !(CLOSED_STATUSES as readonly string[]).includes(l.status);
  const picked = leads.find(isOpen) ?? leads[0];
  return picked ? { id: picked.id, contactId: picked.contactId, companyId: picked.companyId } : null;
}

type PickedLead = { id: number; contactId: number | null; companyId: number | null };

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
 * Several leads: an open one first, then the most recently updated (`pickLead`). Addresses compare trimmed, any case;
 * an address at our own or the mailbox's domain never links.
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

  const ownDomain = domainOf(m.ownAddress);
  const ownDomains = ownDomain ? [ownDomain] : [];
  // An address at our own or the mailbox's domain (a test lead with a colleague's address) never links (as in
  // leadMail, F18).
  const addresses = [...new Set(m.counterparts.map(normaliseAddress).filter(Boolean))].filter((a) => {
    const domain = domainOf(a);
    return !domain || !isOwnDomain(domain, ownDomains);
  });
  if (addresses.length === 0) return NONE;

  const byAddress = await leadsAt(db, addresses);
  if (byAddress.length > 0) {
    const lead = (await pickLead(db, { id: { in: byAddress } }))!;
    return { leadId: lead.id, contactId: lead.contactId, companyId: lead.companyId };
  }

  // The first address (in the order given) that is a contact's; an active contact before an inactive one.
  const [contact] = await db.$queryRaw<{ id: number; companyId: number }[]>`
    SELECT id, company_id AS "companyId" FROM contacts
    WHERE lower(trim(business_email)) = ANY(${addresses}::text[])
    ORDER BY array_position(${addresses}::text[], lower(trim(business_email))), is_active DESC, id ASC
    LIMIT 1`;
  if (contact) {
    const lead = (await pickLead(db, { contactId: contact.id })) ?? (await pickLead(db, { companyId: contact.companyId }));
    return { leadId: lead?.id ?? null, contactId: contact.id, companyId: contact.companyId };
  }

  const domains = [...new Set(addresses.map(domainOf))].filter((d): d is string => d !== null && !isExcludedDomain(d, ownDomains));
  let companyOnly: number | null = null;
  for (const domain of domains) {
    const company = await db.company.findUnique({ where: { domain }, select: { id: true } });
    if (company) {
      const lead = await pickLead(db, { companyId: company.id });
      if (lead) return { leadId: lead.id, contactId: null, companyId: company.id };
      companyOnly ??= company.id;
    }

    const atDomain = await leadsAtDomain(db, domain);
    if (atDomain.length > 0) {
      const found = (await pickLead(db, { id: { in: atDomain } }))!;
      if (found.companyId === null) return { leadId: found.id, contactId: null, companyId: null };
      const lead = await pickLead(db, { companyId: found.companyId });
      return { leadId: lead?.id ?? null, contactId: null, companyId: found.companyId };
    }

    const [viaContact] = await db.$queryRaw<{ companyId: number }[]>`
      SELECT c.company_id AS "companyId" FROM contacts c
      WHERE right(lower(trim(c.business_email)), length(${domain}) + 1) = '@' || ${domain}
        AND EXISTS (SELECT 1 FROM leads l WHERE l.company_id = c.company_id)
      ORDER BY c.is_active DESC, c.id ASC
      LIMIT 1`;
    if (viaContact) {
      const lead = await pickLead(db, { companyId: viaContact.companyId });
      return { leadId: lead?.id ?? null, contactId: null, companyId: viaContact.companyId };
    }
  }
  return companyOnly !== null ? { ...NONE, companyId: companyOnly } : NONE;
}

/** The most recent open lead the user can see among `where`, their own first (3C calendar rule). */
async function visibleOpenLead(db: Db, user: AuthUser, where: Prisma.LeadWhereInput): Promise<number | null> {
  const leads = await db.lead.findMany({
    where: { AND: [where, leadWhere(user), { status: { notIn: [...CLOSED_STATUSES] } }] },
    select: { id: true, assignedToId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return (leads.find((l) => l.assignedToId === user.id) ?? leads[0])?.id ?? null;
}

/**
 * Links for a synced calendar event, unchanged since release 3C (mail matching changed in web-mail release 1, events
 * did not), first hit wins: a contact's business email (company, the contact's open lead, else the company's); a
 * company domain (not free mail, not the mailbox's own) held by exactly one company (company, and its open lead when it
 * has exactly one). Leads only when open and the user can see them, their own first.
 */
export async function matchCalendarEvent(
  db: Db, user: AuthUser, m: { counterparts: string[]; ownAddress: string },
): Promise<Pick<MailLinks, 'leadId' | 'companyId'>> {
  const addresses = [...new Set(m.counterparts.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  for (const address of addresses) {
    const contact = await db.contact.findFirst({
      where: { businessEmail: { equals: address, mode: 'insensitive' } },
      select: { id: true, companyId: true },
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
    });
    if (!contact) continue;
    const leadId = (await visibleOpenLead(db, user, { contactId: contact.id }))
      ?? (await visibleOpenLead(db, user, { companyId: contact.companyId }));
    return { leadId, companyId: contact.companyId };
  }

  const ownDomain = domainOf(m.ownAddress);
  for (const address of addresses) {
    const domain = domainOf(address);
    if (!domain || domain === ownDomain || isFreeMail(domain)) continue;
    const companies = await db.company.findMany({ where: { domain }, select: { id: true }, take: 2 });
    if (companies.length !== 1) continue;
    const companyId = companies[0]!.id;
    const open = await db.lead.findMany({
      where: { AND: [{ companyId }, leadWhere(user), { status: { notIn: [...CLOSED_STATUSES] } }] },
      select: { id: true },
      take: 2,
    });
    return { leadId: open.length === 1 ? open[0]!.id : null, companyId };
  }
  return { leadId: null, companyId: null };
}
