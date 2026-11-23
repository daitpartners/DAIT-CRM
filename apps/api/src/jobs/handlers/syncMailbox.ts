import type { EmailAccount, Job } from '@prisma/client';
import { prisma } from '../../db.js';
import { enqueue, errorMessage } from '../queue.js';
import { GraphError, deltaStartUrl, isAuthFailure, type GraphMessage, type MailFolder } from '../../graph/client.js';
import { isUniqueViolation } from '../../prismaErrors.js';
import { mailUser, matchMail } from '../../mail/match.js';
import { emailBodies } from '../../mail/html.js';
import type { AuthUser } from '../../plugins/auth.js';
import type { SyncMailboxPayload } from '../types.js';
import type { JobContext } from '../runner.js';

/** Graph folder → CRM folder, in the order they are read. */
const FOLDERS: { graph: MailFolder; folder: string }[] = [
  { graph: 'inbox', folder: 'inbox' },
  { graph: 'sentitems', folder: 'sent' },
  { graph: 'drafts', folder: 'drafts' },
  { graph: 'archive', folder: 'archive' },
];
export const INITIAL_DAYS = 90;
export const MAX_PAGES = 20;
export const BODY_MAX = 50_000;
/** A CRM-sent message and its Sent Items copy are this close in time. */
const CLAIM_WINDOW_MS = 15 * 60_000;
/** A run that stopped at the page cap continues this soon. */
const MORE_AFTER_MS = 60_000;

type SyncState = Partial<Record<MailFolder, { link: string }>>;

/** Subject without reply / forward prefixes ("Re:", "RE:", "Fw:", "Fwd:", "RV:"), for matching a sent copy. */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^(re|fw|fwd|rv|res|aw|wg)\s*:\s*/i, '');
    if (next === s) return s.toLowerCase();
    s = next;
  }
}

const isOwn = (account: EmailAccount, address: string | undefined) =>
  !!address && [account.address, account.sendAs].some((a) => a?.toLowerCase() === address);

/** Claims the CRM's own row for a Sent Items copy of a message it sent; true when one was claimed. */
async function claimCrmCopy(userId: number, m: GraphMessage): Promise<boolean> {
  const at = Date.parse(m.sentAt ?? m.receivedAt);
  const candidates = await prisma.emailMessage.findMany({
    where: {
      userId, source: 'crm', graphId: null, status: 'sent',
      occurredAt: { gte: new Date(at - CLAIM_WINDOW_MS), lte: new Date(at + CLAIM_WINDOW_MS) },
    },
    orderBy: { occurredAt: 'asc' },
  });
  const subject = baseSubject(m.subject);
  const hit = candidates.find((c) => baseSubject(c.subject) === subject && (c.toAddresses as string[]).some((a) => m.to.includes(a.toLowerCase())));
  if (!hit) return false;
  await prisma.emailMessage.update({ where: { id: hit.id }, data: { graphId: m.id, threadId: m.conversationId, messageId: m.internetMessageId } });
  return true;
}

/**
 * Release 3B: a message joining a conversation takes the project of the user's own latest tagged message in it (their
 * mailbox only: another user's mail never lends its tag); null when none carries one.
 */
async function inheritedProject(userId: number, threadId: string | null): Promise<number | null> {
  if (!threadId) return null;
  const tagged = await prisma.emailMessage.findFirst({
    where: { userId, threadId, projectId: { not: null } }, select: { projectId: true }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
  });
  return tagged?.projectId ?? null;
}

async function storeMessage(account: EmailAccount, user: AuthUser, folder: string, m: GraphMessage, ctx: JobContext): Promise<void> {
  const existing = await prisma.emailMessage.findUnique({ where: { userId_graphId: { userId: user.id, graphId: m.id } } });
  const outbound = m.isDraft || folder === 'sent' || folder === 'drafts' || isOwn(account, m.from?.address);
  const occurredAt = new Date(outbound ? (m.sentAt ?? m.receivedAt) : m.receivedAt);
  if (existing) {
    // Links the user (or matching) set are kept; only Outlook's state follows. A draft sent from Outlook becomes Sent.
    const sentDraft = existing.status === 'draft' && !m.isDraft ? { status: outbound ? 'sent' : 'received', occurredAt } : {};
    // A row stored before bodies came as HTML takes the HTML (and the cleaner text) now that it is here anyway.
    const bodies = !existing.bodyHtml && m.body.contentType === 'html' ? emailBodies(m.body, BODY_MAX) : {};
    await prisma.emailMessage.update({ where: { id: existing.id }, data: { folder, isRead: outbound ? true : m.isRead, ...sentDraft, ...bodies } });
    return;
  }
  if (outbound && !m.isDraft && (await claimCrmCopy(user.id, m))) return;

  const links = await matchMail(prisma, user, {
    threadId: m.conversationId,
    counterparts: outbound ? [...m.to, ...m.cc] : m.from ? [m.from.address] : [],
    ownAddress: account.address,
  });
  const threadId = m.conversationId?.slice(0, 255) ?? null;
  const attachmentNames = m.hasAttachments ? await ctx.graph.attachmentNames(account, m.id).catch(() => []) : [];
  const projectId = await inheritedProject(user.id, threadId);
  const { bodyHtml, bodyText } = emailBodies(m.body, BODY_MAX);
  try {
    await prisma.emailMessage.create({
      data: {
        userId: user.id, accountId: account.id, graphId: m.id, source: 'sync', folder,
        status: m.isDraft ? 'draft' : outbound ? 'sent' : 'received',
        fromAddress: m.from?.address ?? '', fromName: m.from?.name ? m.from.name.slice(0, 255) : null,
        toAddresses: m.to, ccAddresses: m.cc, subject: m.subject.slice(0, 500), bodyText, bodyHtml,
        messageId: m.internetMessageId?.slice(0, 255) ?? null, threadId,
        isRead: outbound ? true : m.isRead, occurredAt,
        attachmentNames, projectId, ...links,
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err; // a concurrent run stored it first
  }
}

/**
 * Removals are applied after every folder was read, and only to a row still in the folder that removed it, so a
 * message moved between synced folders keeps its row (immutable ids). A synced row goes; a CRM-sent one stays.
 */
async function applyRemovals(userId: number, removed: { graphId: string; folder: string }[]): Promise<void> {
  for (const r of removed) {
    const row = await prisma.emailMessage.findUnique({ where: { userId_graphId: { userId, graphId: r.graphId } } });
    if (!row || row.folder !== r.folder) continue;
    if (row.source === 'crm') await prisma.emailMessage.update({ where: { id: row.id }, data: { graphId: null } });
    else await prisma.emailMessage.delete({ where: { id: row.id } });
  }
}

/**
 * Reads one folder from `link` (else a delta query from `since`) for at most MAX_PAGES pages. Returns the link to
 * continue from, the removals seen, and whether pages remain. An expired delta link (410) restarts the folder once.
 */
async function readFolder(
  account: EmailAccount, user: AuthUser, f: { graph: MailFolder; folder: string }, link: string | undefined, since: Date, ctx: JobContext,
): Promise<{ link: string | null; removed: { graphId: string; folder: string }[]; more: boolean }> {
  let url = link ?? deltaStartUrl(f.graph, since);
  let restarted = !link;
  const removed: { graphId: string; folder: string }[] = [];
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    let page;
    try {
      page = await ctx.graph.deltaPage(account, url);
    } catch (err) {
      if (err instanceof GraphError && err.status === 410 && !restarted) {
        restarted = true;
        removed.length = 0;
        url = deltaStartUrl(f.graph, since);
        pages = -1;
        continue;
      }
      throw err;
    }
    for (const m of page.messages) await storeMessage(account, user, f.folder, m, ctx);
    for (const graphId of page.removed) removed.push({ graphId, folder: f.folder });
    if (!page.nextLink) return { link: page.deltaLink ?? url, removed, more: false };
    url = page.nextLink;
  }
  return { link: url, removed, more: true };
}

/**
 * Reads new mail from a personal mailbox (release 2B-2): each folder continues from its stored delta link, or starts
 * 90 days back; at most MAX_PAGES pages per folder per run (the rest a minute later). A revoked token puts the mailbox
 * in `error`; a folder that fails is skipped (noted in `lastError`) and read again next run; the run fails only when
 * every folder does.
 */
export async function syncMailboxHandler(job: Job, ctx: JobContext): Promise<void> {
  const { accountId } = job.payload as unknown as SyncMailboxPayload;
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account || account.kind !== 'personal' || account.status !== 'connected' || !account.syncMail || account.userId === null) return;
  const user = await mailUser(prisma, account.userId);
  if (!user) return;

  const state: SyncState = { ...(account.syncState as SyncState) };
  const since = new Date(Date.now() - INITIAL_DAYS * 86_400_000);
  const removed: { graphId: string; folder: string }[] = [];
  const failures: { folder: MailFolder; err: unknown }[] = [];
  let more = false;
  try {
    for (const f of FOLDERS) {
      // A folder's new link and removals count only once the folder is read to a stopping point; a folder that fails
      // keeps its old link, so the same changes (removals included) are read again next time. Storing is idempotent.
      try {
        const done = await readFolder(account, user, f, state[f.graph]?.link, since, ctx);
        if (done.link) state[f.graph] = { link: done.link };
        else delete state[f.graph];
        removed.push(...done.removed);
        more ||= done.more;
      } catch (err) {
        if (isAuthFailure(err)) throw err;
        failures.push({ folder: f.graph, err });
      }
    }
    if (failures.length === FOLDERS.length) throw failures[0]!.err;
    await applyRemovals(user.id, removed);
    await prisma.emailAccount.update({ where: { id: account.id }, data: { syncState: state } });
  } catch (err) {
    if (isAuthFailure(err)) {
      // Only the connection this run used: a mailbox disconnected or reconnected meanwhile keeps its new state.
      await prisma.emailAccount.updateMany({
        where: { id: account.id, status: 'connected', refreshTokenEnc: account.refreshTokenEnc },
        data: { status: 'error', lastError: errorMessage(err) },
      });
      return;
    }
    throw err;
  }
  const lastError = failures.length ? errorMessage(failures.map((x) => `${x.folder}: ${errorMessage(x.err)}`).join('; ')) : null;
  // Only the current owner's mail: rows a previous owner synced stay theirs (and out of this count).
  const messageCount = await prisma.emailMessage.count({ where: { accountId: account.id, userId: user.id } });
  await prisma.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: new Date(), messageCount, lastError } });
  if (more) await enqueue(prisma, 'sync_mailbox', { accountId: account.id }, { runAt: new Date(Date.now() + MORE_AFTER_MS), maxAttempts: 1 });
}
