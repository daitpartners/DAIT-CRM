import type { Prisma, PrismaClient } from '@prisma/client';
import { domainOf, quoteTotals } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { todayIn, ymd } from '../leads/dates.js';
import { activityInclude, activityRow } from '../leads/serialize.js';
import { openFollowUpTask } from '../leads/service.js';
import { timelineViewer } from './access.js';
import { isExcludedDomain, loadMailboxDomains, normaliseAddress } from './leadMail.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** How many of the lead's newest activities the panel lists. */
const RECENT = 3;

/** The reading pane's lead panel (web-mail release 2, prototype "Lead" card beside an open message). */
export interface LeadPanel {
  company: { id: number; name: string; site: string | null; place: string | null } | null;
  contact: { name: string; role: string | null; email: string | null; phone: string | null } | null;
  owner: string | null;
  followUp: { date: string; time: string | null; due: boolean } | null;
  lastActivity: { title: string; occurredAt: string } | null;
  value: { amount: number; currency: string } | null;
  recent: ReturnType<typeof activityRow>[];
  linkReason: { kind: 'address' | 'domain'; value: string } | null;
}

type QuoteForValue = {
  taxRate: Prisma.Decimal; overallDiscount: Prisma.Decimal; lines: { qty: Prisma.Decimal; unitPrice: Prisma.Decimal; discount: Prisma.Decimal }[];
  revisions: { grandTotal: Prisma.Decimal }[];
};

/**
 * A quotation's sent figure: its latest sent revision's grand total, so a quotation being revised (editingNewRevision,
 * whose lines are the unsent n+1) still shows what the client received; `quoteTotals` of its lines only when it has no
 * stored revision (marked sent without one).
 */
function sentTotal(q: QuoteForValue): number {
  const sent = q.revisions[0];
  if (sent) return Number(sent.grandTotal);
  return quoteTotals({ lines: q.lines.map((l) => ({ qty: l.qty, price: l.unitPrice, discount: l.discount })), overallDiscount: q.overallDiscount, taxRate: q.taxRate }).total;
}

const placeOf = (city: string | null, country: string | null) => [city, country].map((s) => s?.trim()).filter(Boolean).join(', ') || null;

/**
 * The lead panel for a lead the caller has already checked `user` may see (canSeeLead): a restricted lead never comes
 * here. `participants`: the open message's addresses (participantsOf). Follow-up: the open follow-up task's day and time
 * (openFollowUpTask: an email follow-up task on the lead's day stands in), else the lead's next follow-up, due when on
 * or before today in the viewer's zone. Value: the sent total (sentTotal) of the newest quotation that is not a Draft. Recent: the newest activities, worded for the viewer (an email line's subject only for its mailbox
 * owner and team-mail readers). Link reason: a participant is the lead's or the contact's address, else at the
 * company's own domain (never free mail, shared hosts or our own domains).
 */
export async function leadPanel(db: Db, user: AuthUser, leadId: number, participants: string[], now: Date = new Date()): Promise<LeadPanel> {
  const [lead, activities, quotation, mailboxDomains] = await Promise.all([
    db.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: {
        businessEmail: true, phone: true, city: true, country: true, nextFollowUp: true,
        company: { select: { id: true, name: true, domain: true, city: true, country: true } },
        contact: { select: { firstName: true, lastName: true, designation: true, businessEmail: true, phone: true, mobile: true } },
        assignedTo: { select: { name: true } },
      },
    }),
    db.leadActivity.findMany({ where: { leadId }, include: activityInclude, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: RECENT }),
    db.quotation.findFirst({
      where: { leadId, status: { not: 'Draft' } }, orderBy: [{ quotationDate: 'desc' }, { id: 'desc' }],
      select: {
        currency: true, taxRate: true, overallDiscount: true, lines: { select: { qty: true, unitPrice: true, discount: true } },
        revisions: { orderBy: { revisionNo: 'desc' }, take: 1, select: { grandTotal: true } },
      },
    }),
    loadMailboxDomains(db),
  ]);
  const task = await openFollowUpTask(db, { id: leadId, nextFollowUp: lead.nextFollowUp });
  const viewer = await timelineViewer(db, user, activities);
  const recent = activities.map((a) => activityRow(a, viewer));

  const followDate = task ? ymd(task.dueDate) : ymd(lead.nextFollowUp);
  const today = todayIn(user.timezone, now);

  const people = participants.map(normaliseAddress).filter(Boolean);
  const own = new Set([lead.businessEmail, lead.contact?.businessEmail].map(normaliseAddress).filter(Boolean));
  const site = lead.company?.domain ?? null;
  const byAddress = people.find((p) => own.has(p));
  const byDomain = site && !isExcludedDomain(site, mailboxDomains) && people.some((p) => domainOf(p) === site);

  const { company, contact } = lead;
  return {
    company: company ? { id: company.id, name: company.name, site, place: placeOf(company.city, company.country) } : null,
    contact: contact
      ? {
        name: `${contact.firstName} ${contact.lastName}`.trim(), role: contact.designation, email: contact.businessEmail,
        phone: contact.phone || contact.mobile || lead.phone || null,
      }
      : null,
    owner: lead.assignedTo?.name ?? null,
    followUp: followDate ? { date: followDate, time: task?.dueTime ?? null, due: followDate <= today } : null,
    lastActivity: recent[0] ? { title: recent[0].title, occurredAt: recent[0].occurredAt.toISOString() } : null,
    value: quotation ? { amount: sentTotal(quotation), currency: quotation.currency } : null,
    recent,
    linkReason: byAddress ? { kind: 'address', value: byAddress } : byDomain ? { kind: 'domain', value: site } : null,
  };
}
