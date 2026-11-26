/**
 * One-off clean-up for web-mail release 1 (CLI `cli/mail-cleanup.ts`, run once after the release is live): removes the
 * stored mail that is not lead mail, for every user. Mail stays in Outlook; only the CRM copy goes.
 *
 * A message is kept when any of: linked to a lead; marked `lead_deleted_at`; a send still queued or in flight; Mailer
 * campaign mail or project-tagged; the queued send of a quotation or a Mailer recipient's message; lead mail by the
 * rules of `leadMail.ts` (any participant); or in a conversation where the user keeps a lead-linked message.
 *
 * Leads deleted before `lead_deleted_at` existed (controller ruling 1, F1): their addresses come from the lead-delete
 * audit entries (`before.emails`); unlinked mail with one of them as a participant is marked `lead_deleted_at` and kept.
 * A lead-delete entry with no `before.emails` (written before release 1) cannot be recovered, so the real run refuses
 * unless `acceptUnrecordedDeletes` is given.
 *
 * Logs counts only (never subjects or addresses). Safe to run again: a second run removes nothing more.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { domainOf } from '@dait-crm/shared';
import { isLeadMail, isOwnDomain, loadLeadMailRules, normaliseAddress, participantsOf } from './leadMail.js';

const BATCH = 500;
const IN_FLIGHT = ['queued', 'sending'];

export interface CleanupReport {
  dryRun: boolean;
  users: { userId: number; name: string; checked: number; kept: number; removed: number }[];
  removed: number;
  /** Unlinked messages of a lead deleted before release 1, marked `lead_deleted_at` (would be, on a dry run). */
  stamped: number;
  /** Lead-delete audit entries that record no addresses: their mail cannot be recognised. */
  unrecordedDeletes: number;
}

/** The real run stopped before changing anything: lead-delete audit entries with no recorded addresses exist. */
export class CleanupRefusedError extends Error {
  constructor(readonly unrecordedDeletes: number) {
    super(
      `mail cleanup refused: ${unrecordedDeletes} lead delete audit entr${unrecordedDeletes === 1 ? 'y records' : 'ies record'} no addresses, `
        + 'so mail of those leads cannot be recognised and would be removed; run again with --accept-unrecorded-deletes to go ahead',
    );
  }
}

const strings = (v: Prisma.JsonValue): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/**
 * Addresses of deleted leads (and their contacts) from the lead-delete audit entries, and how many entries record none.
 * An address at our own or a connected mailbox's domain is dropped, as in the lead-mail rules (F18).
 */
async function deletedLeadAddresses(db: PrismaClient): Promise<{ addresses: Set<string>; unrecorded: number }> {
  const [entries, accounts] = await Promise.all([
    db.auditLog.findMany({ where: { entityType: 'lead', action: 'delete' }, select: { before: true } }),
    db.emailAccount.findMany({ select: { address: true, sendAs: true } }),
  ]);
  const mailboxDomains = accounts.flatMap((a) => [domainOf(a.address), domainOf(a.sendAs)]).filter((d): d is string => !!d);
  const addresses = new Set<string>();
  let unrecorded = 0;
  for (const { before } of entries) {
    const emails = before && typeof before === 'object' && !Array.isArray(before) ? before.emails : undefined;
    if (!Array.isArray(emails)) {
      unrecorded += 1;
      continue;
    }
    for (const raw of strings(emails)) {
      const address = normaliseAddress(raw);
      const domain = domainOf(address);
      if (address && !(domain && isOwnDomain(domain, mailboxDomains))) addresses.add(address);
    }
  }
  return { addresses, unrecorded };
}

export async function cleanUpNonLeadMail(
  db: PrismaClient,
  opts: { dryRun: boolean; log: (line: string) => void; acceptUnrecordedDeletes?: boolean },
): Promise<CleanupReport> {
  const { dryRun, log } = opts;
  const deleted = await deletedLeadAddresses(db);
  if (deleted.unrecorded > 0) {
    log(`mail cleanup: ${deleted.unrecorded} lead delete audit entries record no addresses (their mail cannot be recognised)`);
    if (!dryRun && !opts.acceptUnrecordedDeletes) throw new CleanupRefusedError(deleted.unrecorded);
  }
  const rules = await loadLeadMailRules(db);
  const report: CleanupReport = { dryRun, users: [], removed: 0, stamped: 0, unrecordedDeletes: deleted.unrecorded };

  const users = await db.user.findMany({
    where: { emailMessages: { some: {} } }, select: { id: true, name: true }, orderBy: { id: 'asc' },
  });
  for (const user of users) {
    const leadThreads = new Set(
      (await db.emailMessage.findMany({
        where: { userId: user.id, leadId: { not: null }, threadId: { not: null } }, select: { threadId: true }, distinct: ['threadId'],
      })).map((r) => r.threadId!),
    );
    const counts = { userId: user.id, name: user.name, checked: 0, kept: 0, removed: 0 };
    let cursor = 0;
    for (;;) {
      const rows = await db.emailMessage.findMany({
        where: { userId: user.id, id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: {
          id: true, leadId: true, leadDeletedAt: true, status: true, campaignId: true, projectId: true, threadId: true,
          fromAddress: true, toAddresses: true, ccAddresses: true, bccAddresses: true,
          _count: { select: { sendingQuotations: true, campaignRecipients: true } },
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      counts.checked += rows.length;

      const stamp: number[] = [];
      const remove: number[] = [];
      for (const m of rows) {
        if (m.leadId !== null || m.leadDeletedAt !== null || IN_FLIGHT.includes(m.status) || m.campaignId !== null
          || m.projectId !== null || m._count.sendingQuotations > 0 || m._count.campaignRecipients > 0) continue;
        const participants = participantsOf({
          from: m.fromAddress, to: strings(m.toAddresses), cc: strings(m.ccAddresses), bcc: strings(m.bccAddresses),
        });
        if (participants.some((p) => deleted.addresses.has(p))) stamp.push(m.id);
        else if (!isLeadMail(rules, participants) && !(m.threadId && leadThreads.has(m.threadId))) remove.push(m.id);
      }

      report.stamped += stamp.length;
      if (dryRun) {
        counts.removed += remove.length;
      } else {
        if (stamp.length > 0) {
          await db.emailMessage.updateMany({ where: { id: { in: stamp }, leadDeletedAt: null }, data: { leadDeletedAt: new Date() } });
        }
        if (remove.length > 0) {
          // Checked again in the delete itself, in case a message was linked or used since it was read.
          const { count } = await db.emailMessage.deleteMany({
            where: {
              id: { in: remove }, leadId: null, leadDeletedAt: null, status: { notIn: IN_FLIGHT }, campaignId: null, projectId: null,
              sendingQuotations: { none: {} }, campaignRecipients: { none: {} },
            },
          });
          counts.removed += count;
        }
      }
    }
    counts.kept = counts.checked - counts.removed;
    report.users.push(counts);
    report.removed += counts.removed;
    log(`mail cleanup: user ${counts.userId} (${counts.name}): checked ${counts.checked}, kept ${counts.kept}, removed ${counts.removed}`);
  }

  if (!dryRun) {
    const accounts = await db.emailAccount.findMany({ where: { kind: 'personal', userId: { not: null } }, select: { id: true, userId: true } });
    for (const a of accounts) {
      const messageCount = await db.emailMessage.count({ where: { accountId: a.id, userId: a.userId! } });
      await db.emailAccount.update({ where: { id: a.id }, data: { messageCount } });
    }
    await db.auditLog.create({
      data: {
        entityType: 'mail_cleanup', entityId: 'release-1', action: 'delete', userId: null,
        after: { users: report.users.map((u) => ({ userId: u.userId, removed: u.removed })), removed: report.removed, stamped: report.stamped },
      },
    });
  }

  const checked = report.users.reduce((n, u) => n + u.checked, 0);
  log(
    `mail cleanup: total: checked ${checked}, kept ${checked - report.removed}, removed ${report.removed}, `
      + `marked as deleted-lead mail ${report.stamped}${dryRun ? ' (dry run: nothing changed)' : ''}`,
  );
  return report;
}
