import type { EmailMessage, Prisma, PrismaClient } from '@prisma/client';
import { CLOSED_STATUSES, domainOf, isClosedStatus } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { audit } from '../audit.js';
import { dateOnly, ymd } from '../leads/dates.js';
import { RuleError, openFollowUpTask, syncFollowUpTask } from '../leads/service.js';
import { assertLeadVisible, leadWhere } from '../leads/visibility.js';
import { lockLeads } from '../routes/leads.js';
import { isExcludedDomain, isOwnAddress, loadMailboxDomains, participantsOf } from './leadMail.js';

type Db = Prisma.TransactionClient | PrismaClient;
type Tx = Prisma.TransactionClient;

/** How many leads Link to lead suggests for a message. */
export const SUGGESTIONS_MAX = 5;

/**
 * Follow-up from an email (web-mail release 2): the lead's next follow-up day, and `v.time` on its open follow-up task
 * (openFollowUpTask: the assignee's, kept by `syncFollowUpTask`, or an email follow-up task due that day standing in for it;
 * none while the lead is unassigned). `null` clears both. Locks the lead;
 * the user must see it (else NotFoundError); an archived lead is `lead_archived` and a closed lead with a date
 * `lead_closed`, as editing the lead.
 */
export async function setLeadFollowUp(
  tx: Tx, user: AuthUser, leadId: number, v: { date: string; time: string } | null, emailMessageId: number | null = null,
): Promise<{ nextFollowUp: string | null; taskId: number | null }> {
  await lockLeads(tx, [leadId]);
  const before = await assertLeadVisible(tx, user, leadId, { includeArchived: true });
  if (before.archivedAt) throw new RuleError('lead_archived');
  if (v && isClosedStatus(before.status)) throw new RuleError('lead_closed');

  const after = await tx.lead.update({ where: { id: leadId }, data: { nextFollowUp: v ? dateOnly(v.date) : null } });
  await syncFollowUpTask(tx, after);
  const task = await openFollowUpTask(tx, after);
  if (task && v) await tx.task.update({ where: { id: task.id }, data: { dueTime: v.time } });

  await audit(tx, {
    entityType: 'lead', entityId: leadId, action: 'update', userId: user.id,
    before: { nextFollowUp: before.nextFollowUp },
    after: { nextFollowUp: after.nextFollowUp, dueTime: task && v ? v.time : null, emailMessageId },
  });
  return { nextFollowUp: ymd(after.nextFollowUp), taskId: task?.id ?? null };
}

/** An open lead: not archived, not in a closed status. */
const OPEN: Prisma.LeadWhereInput = { archivedAt: null, status: { notIn: [...CLOSED_STATUSES] } };

/**
 * Leads to offer under Link to lead for `m`: at most SUGGESTIONS_MAX the user can see (archived included), never the
 * message's own lead. First leads whose own or contact's address is a participant, then leads of companies whose domain
 * is a participant's domain (free mail, shared hosts, our own and the mailboxes' domains excluded, as lead mail). Each
 * group open leads first, then most recently updated. Addresses at our own or a mailbox's domain never count (F18).
 */
export async function suggestLeads(
  db: Db, user: AuthUser, m: EmailMessage,
): Promise<{ id: number; number: string; companyName: string; status: string }[]> {
  const mailboxDomains = await loadMailboxDomains(db);
  const addresses = participantsOf({
    from: m.fromAddress, to: m.toAddresses as string[], cc: m.ccAddresses as string[], bcc: m.bccAddresses as string[],
  }).filter((a) => !isOwnAddress(a, mailboxDomains));
  if (addresses.length === 0) return [];
  const domains = [...new Set(addresses.map(domainOf))].filter((d): d is string => d !== null && !isExcludedDomain(d, mailboxDomains));

  const [byLead, byContact] = await Promise.all([
    db.$queryRaw<{ id: number }[]>`SELECT id FROM leads WHERE lower(trim(business_email)) = ANY(${addresses}::text[])`,
    db.$queryRaw<{ id: number }[]>`SELECT id FROM contacts WHERE lower(trim(business_email)) = ANY(${addresses}::text[])`,
  ]);
  const contactIds = byContact.map((c) => c.id);
  const addressWhere: Prisma.LeadWhereInput[] = [];
  if (byLead.length) addressWhere.push({ id: { in: byLead.map((l) => l.id) } });
  if (contactIds.length) addressWhere.push({ contactId: { in: contactIds } });
  const tiers: Prisma.LeadWhereInput[] = [];
  if (addressWhere.length) tiers.push({ OR: addressWhere });
  if (domains.length) tiers.push({ company: { domain: { in: domains } } });

  const select = { id: true, number: true, companyName: true, status: true } as const;
  const visible = leadWhere(user, { includeArchived: true });
  const picked: { id: number; number: string; companyName: string; status: string }[] = [];
  const seen = new Set<number>(m.leadId !== null ? [m.leadId] : []);
  // Each group: open leads first, then closed or archived, newest first (as the release-1 link rule picks a lead).
  for (const where of tiers.flatMap((t) => [{ AND: [t, OPEN] }, { AND: [t, { NOT: OPEN }] }])) {
    if (picked.length >= SUGGESTIONS_MAX) break;
    const rows = await db.lead.findMany({
      where: { AND: [where, visible, { id: { notIn: [...seen] } }] },
      select,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: SUGGESTIONS_MAX - picked.length,
    });
    for (const l of rows) {
      seen.add(l.id);
      picked.push(l);
    }
  }
  return picked;
}
