import type { EmailAccount, EmailMessage, Lead, Prisma } from '@prisma/client';
import { isClosedStatus } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import type { MailAttachment } from '../graph/client.js';
import type { SendUserEmailPayload } from '../jobs/types.js';
import { enqueue } from '../jobs/queue.js';
import { audit } from '../audit.js';
import { dateOnly, todayIn } from '../leads/dates.js';
import { RuleError, applyStatusChange, syncFollowUpTask } from '../leads/service.js';
import { projectWhere } from '../projects/visibility.js';
import { textToHtml } from './html.js';
import type { Formatted } from './formatted.js';

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
  /**
   * A formatted message: its HTML already sanitised by the caller (sanitizeFormatted, before the transaction) and the
   * plain text derived from it. Without it the message is the plain `body`, sent as simple HTML.
   */
  formatted?: Formatted | null;
  replyToId?: number;
  threadId?: string | null;
  /** "Set follow-up in N days" (prototype): an open lead only. */
  followUpDays?: number | null;
  /** Files sent with it (release 3A: the quotation PDF; template pictures and attachments), kept on the queued job. */
  attachments?: MailAttachment[];
  /**
   * Release 3A: a quotation sent by email. The message keeps the quotation's own contact and company, and the lead
   * gets no "Email sent" line or status change now: the quotation writes "Quotation sent" when the send succeeds.
   */
  quotation?: SendUserEmailPayload['quotation'];
  /**
   * Release 3B: the project the message is tagged with (checked by the caller with `assertProjectFor`, or carried over
   * from the replied-to message). A tag never widens who sees the message: it stays its sender's alone.
   */
  projectId?: number | null;
}

/**
 * A project the sender may tag an email with (release 3B): one they can see, of the company the email is for (the
 * lead's, or the client given without a lead). Otherwise 400 `invalid_project`.
 */
export async function assertProjectFor(tx: Tx, user: AuthUser, projectId: number, companyId: number | null): Promise<void> {
  const project = await tx.project.findFirst({ where: { AND: [{ id: projectId }, projectWhere(user)] }, select: { companyId: true } });
  if (!project || companyId === null || project.companyId !== companyId) throw new RuleError('invalid_project');
}

/**
 * Queues a message the user wrote in the CRM, sent by the worker through their own mailbox (releases 2B-1/2B-2).
 * On a lead it also writes the "Email sent" history line (private subject), moves New / Not Contacted to Contacted,
 * and sets the follow-up when asked. Audit carries the message id only: the mail is private to its sender.
 */
export async function queueOutgoing(tx: Tx, user: AuthUser, account: EmailAccount, o: Outgoing): Promise<EmailMessage> {
  const lead = o.lead;
  const links = lead && !o.quotation
    ? { contactId: lead.contactId, companyId: lead.companyId }
    : { contactId: o.contactId ?? null, companyId: o.companyId ?? null };
  const msg = await tx.emailMessage.create({
    data: {
      userId: user.id, accountId: account.id, leadId: lead?.id ?? null, ...links,
      folder: 'sent', status: 'queued', source: 'crm', fromAddress: account.address, toAddresses: o.to, ccAddresses: o.cc,
      subject: o.subject, bodyText: o.formatted ? o.formatted.text || o.body : o.body, bodyHtml: o.formatted?.html ?? textToHtml(o.body), replyToId: o.replyToId ?? null, threadId: o.threadId ?? null, projectId: o.projectId ?? null,
      // Inline pictures are part of the body, not attachments the message lists.
      attachmentNames: (o.attachments ?? []).filter((a) => !a.isInline).map((a) => a.name),
    },
  });
  const payload: SendUserEmailPayload = {
    emailMessageId: msg.id, ...(o.attachments?.length ? { attachments: o.attachments } : {}), ...(o.quotation ? { quotation: o.quotation } : {}),
  };
  await enqueue(tx, 'send_user_email', payload, { maxAttempts: SEND_ATTEMPTS });
  if (lead && !o.quotation) await recordOnLead(tx, user, lead, msg, o.subject, o.followUpDays);
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
