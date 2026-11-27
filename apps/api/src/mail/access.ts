import type { EmailMessage, Prisma, PrismaClient } from '@prisma/client';
import { can } from '@dait-crm/shared';
import type { AuthUser } from '../plugins/auth.js';
import type { TimelineViewer } from '../leads/serialize.js';
import { NotFoundError } from '../validate.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Who sees whose mail (web-mail release 1). A message belongs to the user whose mailbox it is. Administrators and
 * Managers (`view_team_mail`) also read every other user's lead mail, view only; Sales representatives and Data research
 * users see their own only. The app answers `403 { error: code }`.
 */
export class MailAccessError extends Error {
  readonly status = 403 as const;
  constructor(readonly code: 'forbidden' | 'view_only') {
    super(code);
  }
}

/** Another user's mail that the team may read: not a draft, not mail of a deleted lead, linked to a lead, contact or company. */
export const teamReadableWhere: Prisma.EmailMessageWhereInput = {
  folder: { not: 'drafts' },
  leadDeletedAt: null,
  OR: [{ leadId: { not: null } }, { contactId: { not: null } }, { companyId: { not: null } }],
};

export const canSeeTeamMail = (user: AuthUser): boolean => can(user.role, 'view_team_mail');

/**
 * The mailboxes a list reads (`mailOf`): none / `me` / your own id → your own mail, all of it; `all` → yours plus every
 * other user's team-readable mail; another user's id → that user's team-readable mail. `ownerId` is the one mailbox
 * read, or null for every mailbox. Anything but your own without the right is 403 forbidden.
 */
export function mailScope(user: AuthUser, mailOf: string | undefined): { where: Prisma.EmailMessageWhereInput; ownerId: number | null } {
  if (mailOf === undefined || mailOf === 'me' || mailOf === String(user.id)) return { where: { userId: user.id }, ownerId: user.id };
  if (!canSeeTeamMail(user)) throw new MailAccessError('forbidden');
  if (mailOf === 'all') {
    return { where: { OR: [{ userId: user.id }, { AND: [{ userId: { not: user.id } }, teamReadableWhere] }] }, ownerId: null };
  }
  const ownerId = Number(mailOf);
  if (!Number.isSafeInteger(ownerId)) throw new NotFoundError();
  return { where: { AND: [{ userId: ownerId }, teamReadableWhere] }, ownerId };
}

/**
 * One message for a route: your own (viewOnly false), else another user's team-readable message when you have the
 * right (viewOnly true; `change`, anything that would alter their mailbox, is 403 view_only). Anything else is 404, so
 * a user without the right cannot tell another user's message exists. `crm` is a CRM-side action on the message's lead
 * (log, task), done by and for the viewer.
 */
export async function messageFor(db: Db, user: AuthUser, rawId: string, use: 'read' | 'crm' | 'change'): Promise<{ m: EmailMessage; viewOnly: boolean }> {
  const id = Number(rawId);
  if (!/^\d{1,9}$/.test(rawId) || !Number.isInteger(id)) throw new NotFoundError();
  const own = await db.emailMessage.findFirst({ where: { id, userId: user.id } });
  if (own) return { m: own, viewOnly: false };
  const other = canSeeTeamMail(user) ? await db.emailMessage.findFirst({ where: { AND: [{ id }, teamReadableWhere] } }) : null;
  if (!other) throw new NotFoundError();
  if (use === 'change') throw new MailAccessError('view_only');
  return { m: other, viewOnly: true };
}

/** The reader of these timeline rows, with the mailbox owner of each logged email (one query; none for Admin/Manager). */
export async function timelineViewer(
  db: Db, user: AuthUser, rows: { activityType: string; relatedType: string | null; relatedId: number | null }[],
): Promise<TimelineViewer> {
  const teamMail = canSeeTeamMail(user);
  const ids = teamMail ? [] : [...new Set(rows.flatMap((a) => (a.activityType === 'email' && a.relatedType === 'email_message' && a.relatedId !== null ? [a.relatedId] : [])))];
  const owners = ids.length ? await db.emailMessage.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true } }) : [];
  return { id: user.id, teamMail, mailOwners: new Map(owners.map((m) => [m.id, m.userId])) };
}
