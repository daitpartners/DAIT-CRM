import type { EmailAccount, EmailMessage, Lead, Prisma } from '@prisma/client';
import { isClosedStatus } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import { enqueue } from '../jobs/queue.js';
import { audit } from '../audit.js';
import { dateOnly, todayIn } from '../leads/dates.js';
import { applyStatusChange, syncFollowUpTask } from '../leads/service.js';

type Tx = Prisma.TransactionClient;

/** Retries for a user's email: about half an hour of backoff (2, 4, 8, 16 minutes) before it is marked failed. */
const SEND_ATTEMPTS = 5;
const DAY_MS = 86_400_000;
/** Statuses an email moves to Contacted. */
const CONTACTED_ON_EMAIL = new Set(['New', 'Not Contacted']);

export interface Outgoing {
  /** The lead it is sent on (already checked visible and locked by the caller), or null. */
  lead: Lead | null;
  companyId?: number | null;
  contactId?: number | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  replyToId?: number;
  threadId?: string | null;
  /** "Set follow-up in N days" (prototype): an open lead only. */
  followUpDays?: number | null;
}

/**
 * Queues a message the user wrote in the CRM, sent by the worker through their own mailbox (releases 2B-1/2B-2).
 * On a lead it also writes the "Email sent" history line (private subject), moves New / Not Contacted to Contacted,
 * and sets the follow-up when asked. Audit carries the message id only: the mail is private to its sender.
 */
export async function queueOutgoing(tx: Tx, user: AuthUser, account: EmailAccount, o: Outgoing): Promise<EmailMessage> {
  const lead = o.lead;
  const msg = await tx.emailMessage.create({
    data: {
      userId: user.id, accountId: account.id, leadId: lead?.id ?? null,
      contactId: lead ? lead.contactId : (o.contactId ?? null), companyId: lead ? lead.companyId : (o.companyId ?? null),
      folder: 'sent', status: 'queued', source: 'crm', fromAddress: account.address, toAddresses: o.to, ccAddresses: o.cc,
      subject: o.subject, bodyText: o.body, replyToId: o.replyToId ?? null, threadId: o.threadId ?? null,
    },
  });
  await enqueue(tx, 'send_user_email', { emailMessageId: msg.id }, { maxAttempts: SEND_ATTEMPTS });
  if (lead) await recordOnLead(tx, user, lead, msg, o.subject, o.followUpDays);
  return msg;
}

/**
 * An email the user sent on a lead: the private "Email sent" history line, New / Not Contacted → Contacted, the
 * follow-up when asked (open leads), audited with the message id only (also used by the Mailer, release 2C).
 */
export async function recordOnLead(
  tx: Tx, user: Pick<AuthUser, 'id' | 'timezone'>, lead: Lead, msg: EmailMessage, subject: string, followUpDays?: number | null,
): Promise<void> {
  const o = { subject, followUpDays };
  await tx.leadActivity.create({
    data: { leadId: lead.id, activityType: 'email', title: `Email sent · ${o.subject}`, relatedType: 'email_message', relatedId: msg.id, byUserId: user.id },
  });
  // Emailing a lead not yet contacted moves it to Contacted (prototype; owner, 22 Nov 2026).
  let current = lead;
  if (CONTACTED_ON_EMAIL.has(current.status)) {
    current = await applyStatusChange(tx, current, 'Contacted', { userId: user.id }, { sourceTitle: 'Email sent' });
  }
  if (o.followUpDays && !isClosedStatus(current.status)) {
    const due = new Date(dateOnly(todayIn(user.timezone)).getTime() + o.followUpDays * DAY_MS);
    const updated = await tx.lead.update({ where: { id: current.id }, data: { nextFollowUp: due } });
    await syncFollowUpTask(tx, updated);
  }
  await audit(tx, { entityType: 'lead', entityId: lead.id, action: 'update', userId: user.id, after: { emailMessageId: msg.id } });
}
