import type { Prisma, PrismaClient } from '@prisma/client';
import { CLOSED_STATUSES, resolveTimezones, type TimezoneSource } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { leadWhere } from '../leads/visibility.js';

type Db = Prisma.TransactionClient | PrismaClient;

const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/;

/** A selected lead as the Mailer sees it: where the email goes, the recipient's time zone, or why it is skipped. */
export interface RecipientCheck {
  leadId: number;
  leadNumber: string | null;
  contactId: number | null;
  to: string;
  name: string;
  company: string;
  block: string | null;
  zones: string[];
  source: TimezoneSource;
}

const leadInclude = {
  contact: { select: { id: true, firstName: true, lastName: true, businessEmail: true, unsubscribedAt: true } },
  company: { select: { name: true, country: true, state: true, city: true, timezone: true } },
} satisfies Prisma.LeadInclude;
type MailLead = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

/** The address a lead is emailed at: its contact's business email, else the lead's. */
const addressOf = (l: MailLead) => (l.contact?.businessEmail || l.businessEmail || '').trim().toLowerCase();

/** Why a lead cannot be mailed right now, or null (prototype `mailBlock`; the same texts). */
function blockOf(l: MailLead): string | null {
  const to = addressOf(l);
  if (!to) return 'No email address';
  if (!EMAIL_RE.test(to)) return 'Invalid email address';
  if (l.doNotEmail) return 'Marked do not email';
  if (l.contact?.unsubscribedAt) return 'Unsubscribed';
  if (l.archivedAt) return 'Lead is archived';
  if ((CLOSED_STATUSES as readonly string[]).includes(l.status)) return `Lead is closed (${l.status})`;
  return null;
}

/**
 * The wizard's check (prototype `mailerCheck`), in the order given: one email per address per run, leads the sender
 * cannot see are "Lead not available" (nothing about them is shown). The time zone comes from the lead's company,
 * else the lead's own country and city, else the sender's (release 2C, client working hours).
 */
export async function checkRecipients(db: Db, user: AuthUser, leadIds: number[]): Promise<RecipientCheck[]> {
  const ids = [...new Set(leadIds.filter((id) => Number.isInteger(id)))];
  const leads = await db.lead.findMany({ where: { AND: [{ id: { in: ids } }, leadWhere(user, { includeArchived: true })] }, include: leadInclude });
  const byId = new Map(leads.map((l) => [l.id, l]));
  const seen = new Set<string>();
  return ids.map((id) => {
    const l = byId.get(id);
    if (!l) return { leadId: id, leadNumber: null, contactId: null, to: '', name: '', company: '', block: 'Lead not available', zones: [user.timezone], source: 'sender' as const };
    const to = addressOf(l);
    let block = blockOf(l);
    if (!block) {
      if (seen.has(to)) block = 'Same address as another selected lead';
      else seen.add(to);
    }
    // A company with no time zone, state or city (often only a country) leaves the lead's own city to place it.
    const co = l.company;
    const tz = resolveTimezones(
      co && (co.timezone || co.state || co.city)
        ? { companyTimezone: co.timezone, country: co.country, state: co.state, city: co.city }
        : { country: co?.country ?? l.country, state: null, city: l.city },
      user.timezone,
    );
    return {
      leadId: l.id, leadNumber: l.number, contactId: l.contactId, to,
      name: l.contact ? `${l.contact.firstName} ${l.contact.lastName}`.trim() : '', company: l.company?.name ?? l.companyName,
      block, zones: tz.zones, source: tz.source,
    };
  });
}

/**
 * The same rule at send time, plus "replied since the campaign was created" (a received message in the sender's mail).
 * With `queued` (the recipient as queued): the lead must still be emailed at that address (a switched contact is not
 * mailed under the new name at the old address), and the queued contact must not have unsubscribed since.
 */
export async function sendBlock(
  db: Db, user: AuthUser, leadId: number | null, since: Date, queued?: { toAddress: string; contactId: number | null },
): Promise<string | null> {
  const l = leadId === null ? null : await db.lead.findFirst({ where: { AND: [{ id: leadId }, leadWhere(user, { includeArchived: true })] }, include: leadInclude });
  if (!l) return 'Lead no longer available';
  const block = blockOf(l);
  if (block) return block;
  if (queued) {
    if (addressOf(l) !== queued.toAddress.toLowerCase()) return 'Email address changed since the campaign was queued';
    if (queued.contactId !== null && queued.contactId !== l.contactId) {
      const was = await db.contact.findUnique({ where: { id: queued.contactId }, select: { unsubscribedAt: true } });
      if (was?.unsubscribedAt) return 'Unsubscribed';
    }
  }
  const replied = await db.emailMessage.count({ where: { userId: user.id, leadId: l.id, status: 'received', occurredAt: { gt: since } } });
  return replied > 0 ? 'Replied before this email was due' : null;
}

/**
 * One-time fill (release 2C): empty company time zones that the address resolves to exactly one zone, so they show on
 * the company and can be corrected there. Returns how many were set.
 */
export async function fillCompanyTimezones(db: Db): Promise<number> {
  const companies = await db.company.findMany({ where: { timezone: null }, select: { id: true, country: true, state: true, city: true } });
  let n = 0;
  for (const c of companies) {
    const tz = resolveTimezones({ country: c.country, state: c.state, city: c.city }, 'UTC');
    if (tz.source === 'sender' || tz.zones.length !== 1) continue;
    await db.company.update({ where: { id: c.id }, data: { timezone: tz.zones[0] } });
    n += 1;
  }
  return n;
}
