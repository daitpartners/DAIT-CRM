import type { Prisma, PrismaClient } from '@prisma/client';
import { CLOSED_STATUSES, domainOf, isFreeMail } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { activeUser, leadWhere } from '../leads/visibility.js';

type Db = Prisma.TransactionClient | PrismaClient;

export interface MailLinks {
  leadId: number | null;
  contactId: number | null;
  companyId: number | null;
}

/** The mailbox owner as a request user (lead visibility); null when inactive. */
export const mailUser = activeUser;

const NONE: MailLinks = { leadId: null, contactId: null, companyId: null };

/** The most recent open lead the user can see among `where`, their own first. */
async function openLead(db: Db, user: AuthUser, where: Prisma.LeadWhereInput): Promise<number | null> {
  const leads = await db.lead.findMany({
    where: { AND: [where, leadWhere(user), { status: { notIn: [...CLOSED_STATUSES] } }] },
    select: { id: true, assignedToId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return (leads.find((l) => l.assignedToId === user.id) ?? leads[0])?.id ?? null;
}

/**
 * Links for a synced message (release 2B-2), first hit wins: the user's own linked conversation; a contact's business
 * email (contact, company, the contact's open lead, else the company's); a company domain (not free mail, not the
 * mailbox's own) held by exactly one company (company, and its open lead when it has exactly one). Leads only when the
 * user can see them.
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

  const addresses = [...new Set(m.counterparts.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  for (const address of addresses) {
    const contact = await db.contact.findFirst({
      where: { businessEmail: { equals: address, mode: 'insensitive' } },
      select: { id: true, companyId: true },
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
    });
    if (!contact) continue;
    const leadId = (await openLead(db, user, { contactId: contact.id })) ?? (await openLead(db, user, { companyId: contact.companyId }));
    return { leadId, contactId: contact.id, companyId: contact.companyId };
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
    return { leadId: open.length === 1 ? open[0]!.id : null, contactId: null, companyId };
  }
  return NONE;
}
