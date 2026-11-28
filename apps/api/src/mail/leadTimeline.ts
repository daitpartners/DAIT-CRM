import type { EmailMessage, Prisma, PrismaClient } from '@prisma/client';
import { applyStatusChange } from '../leads/service.js';
import { CLAIM_WINDOW_MS, baseSubject } from '../jobs/handlers/syncMailbox.js';
import { CONTACTED_ON_EMAIL } from './outgoing.js';

/**
 * Lead mail timeline: every lead email, sent or received, from any team mailbox, goes on its lead's timeline ("Recent
 * on the lead") once, by itself. Written when sync or backfill stores a lead email, when a message is linked to a lead,
 * and by the one-time fill; Log as activity shares the "already logged" check. Logs carry ids only.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** Advisory lock namespace for a lead's mail lines (quotation numbers use 3001, project numbers 3002). */
const LOCK_NAMESPACE = 3003;

/** Statuses of a row that is not an email (yet): drafts, the CRM's send queue and a send that failed. */
export const UNSENT_STATUSES = ['draft', 'queued', 'sending', 'failed'];
const UNSENT = new Set(UNSENT_STATUSES);

export type LogResult = 'logged' | 'already' | 'skipped';

/** The columns that tell two stored rows are copies of one email. */
const COPY = { id: true, messageId: true, source: true, fromAddress: true, subject: true, occurredAt: true } as const;
type Copy = Pick<EmailMessage, keyof typeof COPY>;

/** A CRM-sent row the sender's sync has not claimed yet: it has no internet message id. */
const unclaimedCrm = (r: Copy) => r.source === 'crm' && r.messageId === null;

/**
 * Two rows are one email for the timeline: the same row; the same internet message id (any mailbox, either side: an
 * email to yourself has two copies); or an unclaimed CRM row and another mailbox's copy with the same sender, subject
 * (without Re:/Fw:) and a time within the claim window, as `claimCrmCopy` matches the sender's own copy.
 */
function sameEmail(a: Copy, b: Copy, senders: Map<string, number>): boolean {
  if (a.id === b.id) return true;
  if (a.messageId !== null && a.messageId === b.messageId) return true;
  const crmPair = (unclaimedCrm(a) && b.source !== 'crm') || (unclaimedCrm(b) && a.source !== 'crm');
  return crmPair && sameSender(a.fromAddress, b.fromAddress, senders) && baseSubject(a.subject) === baseSubject(b.subject)
    && Math.abs(a.occurredAt.getTime() - b.occurredAt.getTime()) <= CLAIM_WINDOW_MS;
}

/**
 * The same address, or two addresses of one team member: a CRM row keeps the mailbox address while Graph sends as its
 * send-as, so a colleague's copy shows the send-as address.
 */
function sameSender(a: string, b: string, senders: Map<string, number>): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const user = senders.get(x);
  return user !== undefined && user === senders.get(y);
}

/** Serialises the mail lines of one lead until the transaction ends. */
export async function lockLeadTimeline(tx: Tx, leadId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${leadId}::int)`;
}

/**
 * True when the lead already has an email line made from `row` or from another copy of the same email. `senders` is
 * `teamSenders`, loaded here when not given.
 */
export async function alreadyLogged(db: Db, row: Copy & { leadId: number }, senders?: Map<string, number>): Promise<boolean> {
  const lines = await db.leadActivity.findMany({
    where: { leadId: row.leadId, activityType: 'email', relatedType: 'email_message', relatedId: { not: null } }, select: { relatedId: true },
  });
  const ids = lines.map((l) => l.relatedId!);
  if (ids.includes(row.id)) return true;
  if (ids.length === 0) return false;
  const copies = await db.emailMessage.findMany({ where: { id: { in: ids } }, select: COPY });
  const team = senders ?? (await teamSenders(db));
  return copies.some((c) => sameEmail(c, row, team));
}

/**
 * True when `row`, or a copy of the same email on its lead, is a quotation's sending email: "Quotation sent" already
 * records it, so it gets no "Email sent" line and no Contacted move. The quotation's pointer
 * (`sending_message_id`) is cleared once the send ends, so the mark is the audit row written when it was queued
 * (`quotations/send.ts`: entity quotation, `after.sendingMessageId`).
 */
async function quotationEmail(db: Db, row: Copy & { leadId: number }, senders: Map<string, number>): Promise<boolean> {
  const window = { gte: new Date(row.occurredAt.getTime() - CLAIM_WINDOW_MS), lte: new Date(row.occurredAt.getTime() + CLAIM_WINDOW_MS) };
  const candidates = await db.emailMessage.findMany({
    where: {
      leadId: row.leadId,
      OR: [
        { id: row.id },
        ...(row.messageId !== null ? [{ messageId: row.messageId }] : []),
        // The CRM fallback of `sameEmail`, either way round.
        { source: 'crm', messageId: null, occurredAt: window },
        ...(unclaimedCrm(row) ? [{ source: { not: 'crm' }, occurredAt: window }] : []),
      ],
    },
    select: COPY,
  });
  const ids = candidates.filter((c) => sameEmail(c, row, senders)).map((c) => c.id);
  if (ids.length === 0) return false;
  const queued = await db.auditLog.findFirst({
    where: { entityType: 'quotation', OR: ids.map((id) => ({ after: { path: ['sendingMessageId'], equals: id } })) },
    select: { id: true },
  });
  return queued !== null;
}

/** Every address a team member sends from (their user email, personal mailboxes and send-as), lowercased → user id. */
export async function teamSenders(db: Db): Promise<Map<string, number>> {
  const senders = new Map<string, number>();
  for (const u of await db.user.findMany({ select: { id: true, email: true }, orderBy: { id: 'asc' } })) senders.set(u.email.toLowerCase(), u.id);
  const accounts = await db.emailAccount.findMany({
    where: { kind: 'personal', userId: { not: null } }, select: { userId: true, address: true, sendAs: true }, orderBy: { id: 'asc' },
  });
  for (const a of accounts) {
    for (const address of [a.address, a.sendAs]) if (address) senders.set(address.toLowerCase(), a.userId!);
  }
  return senders;
}

export interface LogOptions {
  /** `teamSenders`, when the caller logs many rows; loaded per call otherwise. */
  senders?: Map<string, number>;
  /** A sent line moves New / Not Contacted to Contacted (default true). */
  contacted?: boolean;
}

/**
 * Puts a stored email on its lead's timeline, once per email: `Email sent · <subject>` by the sending team member when
 * the sender is a team address, else `Email received · <subject>` with no author; dated at the email, related to the
 * row (for a sent line, the sender's own copy when stored), which gets `logged_at`. A sent line with a recipient outside
 * the team moves New / Not Contacted to Contacted, as `recordOnLead`. Drafts, unsent or failed rows, rows without a
 * lead, deleted-lead mail and a quotation's sending email (and its copies) are skipped. Given a transaction it runs in it; given the client it opens one.
 * Either way it holds the lead's advisory lock, so two copies logged at once give one line.
 */
export async function logLeadMail(db: Db, emailMessageId: number, opts: LogOptions = {}): Promise<LogResult> {
  if ('$transaction' in db) return db.$transaction((tx) => logIn(tx, emailMessageId, opts));
  return logIn(db, emailMessageId, opts);
}

async function logIn(tx: Tx, emailMessageId: number, opts: LogOptions): Promise<LogResult> {
  const peek = await tx.emailMessage.findUnique({ where: { id: emailMessageId }, select: { leadId: true } });
  if (!peek?.leadId) return 'skipped';
  await lockLeadTimeline(tx, peek.leadId);
  // Read again under the lock: the row may have moved to another lead meanwhile.
  const row = await tx.emailMessage.findUnique({ where: { id: emailMessageId } });
  if (!row?.leadId) return 'skipped';
  if (row.leadId !== peek.leadId) return logIn(tx, emailMessageId, opts);
  if (row.folder === 'drafts' || UNSENT.has(row.status) || row.leadDeletedAt !== null) return 'skipped';
  const lead = await tx.lead.findUnique({ where: { id: row.leadId } });
  if (!lead) return 'skipped';
  const senders = opts.senders ?? (await teamSenders(tx));
  if (await alreadyLogged(tx, { ...row, leadId: lead.id }, senders)) return 'already';
  if (await quotationEmail(tx, { ...row, leadId: lead.id }, senders)) return 'skipped';

  const by = senders.get(row.fromAddress.toLowerCase()) ?? null;
  // A sent line made from a colleague's copy relates to the sender's own copy when it is stored, so the sender sees it.
  const own = by !== null && row.userId !== by && row.messageId !== null
    ? await tx.emailMessage.findFirst({
      where: { userId: by, messageId: row.messageId, leadId: lead.id, leadDeletedAt: null, folder: { not: 'drafts' }, status: { notIn: UNSENT_STATUSES } },
      select: { id: true }, orderBy: { id: 'asc' },
    })
    : null;
  const related = own?.id ?? row.id;
  await tx.leadActivity.create({
    data: {
      leadId: lead.id, activityType: 'email', title: `${by !== null ? 'Email sent' : 'Email received'} · ${row.subject}`,
      relatedType: 'email_message', relatedId: related, byUserId: by, occurredAt: row.occurredAt,
    },
  });
  await tx.emailMessage.updateMany({ where: { id: related, loggedAt: null }, data: { loggedAt: new Date() } });
  // A team member's email to a lead not yet contacted moves it to Contacted (owner, 28 Nov 2026), as a CRM send does;
  // only when someone outside the team got it (a forward to a colleague on the lead's thread is not contact).
  const recipients = [row.toAddresses, row.ccAddresses, row.bccAddresses].flatMap((list) => list as string[]);
  const external = recipients.some((a) => !senders.has(a.toLowerCase()));
  if (by !== null && external && (opts.contacted ?? true) && CONTACTED_ON_EMAIL.has(lead.status)) {
    await applyStatusChange(tx, lead, 'Contacted', { userId: by }, { sourceTitle: 'Email sent' });
  }
  return 'logged';
}
