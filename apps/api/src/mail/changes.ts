import type { EmailAccount, EmailMessage } from '@prisma/client';
import { flagDueDay, localNow, type MailChange } from '@dait-crm/shared';
import { prisma } from '../db.js';
import { errorMessage } from '../jobs/queue.js';
import { GraphError, isAuthFailure, type GraphClient, type GraphFlag } from '../graph/client.js';
import { dateOnly, ymd } from '../leads/dates.js';
import type { AuthUser } from '../plugins/auth.js';
import { NotFoundError } from '../validate.js';
import { MailAccessError, messageFor } from './access.js';

/**
 * Mailbox changes from the Email screen (web-mail release 2): move (Inbox, Archive, Deleted items), delete, read /
 * unread and flag. Outlook first, inline, on the owner's own mailbox; the CRM row changes only once Outlook accepted,
 * so a refusal changes nothing. Callers pass a message from `messageFor(…, 'change')`, so another user's message never
 * gets here (403 view_only).
 */

/** Why a change was refused; the app answers `status { error: code }`. `graphStatus` and `errName` are for the log only. */
export class MailChangeError extends Error {
  constructor(
    readonly code: 'mailbox_not_connected' | 'outlook_refused' | 'outlook_busy' | 'sending' | 'draft',
    readonly status: 409 | 502 | 503,
    readonly graphStatus?: number,
    readonly errName?: string,
  ) {
    super(code);
    this.name = 'MailChangeError';
  }
}

/** A message after a change; `removed` when it was deleted for good (the row is gone). */
export interface ChangedMessage {
  id: number;
  folder: string;
  isRead: boolean;
  flagStatus: string;
  flagDue: string | null;
  removed: boolean;
}

/** Most Graph calls one bulk change runs at once. */
export const BULK_CONCURRENCY = 4;

const GRAPH_FOLDER = { inbox: 'inbox', archive: 'archive', deleted: 'deleteditems' } as const;

const changed = (m: EmailMessage, removed = false): ChangedMessage => ({
  id: m.id, folder: m.folder, isRead: m.isRead, flagStatus: m.flagStatus, flagDue: ymd(m.flagDue), removed,
});

/** The Outlook flag and the row's columns for a Flag menu choice, the presets in the user's own zone. */
function flagFor(user: AuthUser, flag: Extract<MailChange, { type: 'flag' }>['flag'], now: Date) {
  if (flag === 'complete') return { graph: { status: 'complete' } as GraphFlag, row: { flagStatus: 'complete', flagDue: null } };
  if (flag === 'clear') return { graph: { status: 'notFlagged' } as GraphFlag, row: { flagStatus: 'notFlagged', flagDue: null } };
  const today = localNow(user.timezone, now).day;
  const due = flagDueDay(flag, today);
  return {
    graph: { status: 'flagged', start: due ? today : null, due, timeZone: user.timezone } as GraphFlag,
    row: { flagStatus: 'flagged', flagDue: due ? dateOnly(due) : null },
  };
}

/** The row's own mailbox while it is still its owner's connected personal one, else null. */
const ownMailbox = (m: EmailMessage) => (m.accountId === null
  ? null
  : prisma.emailAccount.findFirst({ where: { id: m.accountId, userId: m.userId, kind: 'personal', status: 'connected' } }));

/** Runs the Outlook call; every failure becomes a MailChangeError (a revoked mailbox is put in error, as mailAction). */
async function inOutlook(account: EmailAccount, call: () => Promise<void>): Promise<void> {
  try {
    await call();
  } catch (err) {
    const errName = (err as Error | null)?.name;
    if (isAuthFailure(err)) {
      await prisma.emailAccount.updateMany({
        where: { id: account.id, status: 'connected', refreshTokenEnc: account.refreshTokenEnc },
        data: { status: 'error', lastError: errorMessage(err) },
      });
      throw new MailChangeError('mailbox_not_connected', 409, err instanceof GraphError ? err.status : undefined, errName);
    }
    if (err instanceof GraphError) {
      const busy = err.status === 429 || err.status >= 500;
      throw new MailChangeError(busy ? 'outlook_busy' : 'outlook_refused', busy ? 503 : 502, err.status, errName);
    }
    // Not from Graph (a network failure, an MSAL error other than a revoked consent): like throttling, try later.
    throw new MailChangeError('outlook_busy', 503, undefined, errName);
  }
}

/**
 * Makes one change to `m` (the caller's own message): refused first (a message still sending; a draft moved), then
 * Outlook on the row's own mailbox (a row without a Graph id, CRM-only, skips it), then the CRM row. Delete moves to
 * Deleted items; Delete of a message already there deletes it in Outlook and removes the row.
 */
export async function changeMessage(graph: GraphClient, user: AuthUser, m: EmailMessage, change: MailChange, now: Date = new Date()): Promise<ChangedMessage> {
  if (m.status === 'queued' || m.status === 'sending') throw new MailChangeError('sending', 409);
  if (change.type === 'move' && (m.folder === 'drafts' || m.status === 'draft')) throw new MailChangeError('draft', 409);
  const purge = change.type === 'delete' && m.folder === 'deleted';
  const flag = change.type === 'flag' ? flagFor(user, change.flag, now) : null;
  const folder = change.type === 'move' ? change.folder : change.type === 'delete' ? 'deleted' : null;

  if (m.graphId) {
    const account = await ownMailbox(m);
    if (!account) throw new MailChangeError('mailbox_not_connected', 409);
    const graphId = m.graphId;
    await inOutlook(account, () => {
      if (purge) return graph.deleteMessage(account, graphId);
      if (folder) return graph.moveTo(account, graphId, GRAPH_FOLDER[folder]);
      if (flag) return graph.setFlag(account, graphId, flag.graph);
      return graph.markRead(account, graphId, (change as Extract<MailChange, { type: 'read' }>).isRead);
    });
  }

  const where = { id: m.id, userId: m.userId };
  if (purge) {
    await prisma.emailMessage.deleteMany({ where });
    return changed(m, true);
  }
  const data = folder ? { folder } : flag ? flag.row : { isRead: (change as Extract<MailChange, { type: 'read' }>).isRead };
  await prisma.emailMessage.updateMany({ where, data });
  const fresh = await prisma.emailMessage.findFirst({ where });
  if (!fresh) throw new NotFoundError();
  return changed(fresh);
}

/**
 * The same change to several messages (a selection, or a conversation's messages), at most BULK_CONCURRENCY at once.
 * Each id is checked as a single change is (another user's → `view_only`, unknown → `not_found`); a refusal fails that
 * id only. Results keep the order of `ids` (a repeated id counts once).
 */
export async function changeMany(
  graph: GraphClient, user: AuthUser, ids: number[], change: MailChange, now: Date = new Date(),
): Promise<{ done: ChangedMessage[]; failed: { id: number; error: string }[] }> {
  const unique = [...new Set(ids)];
  const results: ({ ok: ChangedMessage } | { id: number; error: string })[] = new Array(unique.length);
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const i = next++;
      const id = unique[i]!;
      try {
        const { m } = await messageFor(prisma, user, String(id), 'change');
        results[i] = { ok: await changeMessage(graph, user, m, change, now) };
      } catch (err) {
        if (err instanceof MailAccessError || err instanceof MailChangeError) results[i] = { id, error: err.code };
        else if (err instanceof NotFoundError) results[i] = { id, error: 'not_found' };
        else throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, unique.length) }, worker));
  const done: ChangedMessage[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const r of results) {
    if ('ok' in r) done.push(r.ok);
    else failed.push(r);
  }
  return { done, failed };
}
