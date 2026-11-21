import type { EmailAccount, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../audit.js';
import { encrypt } from '../crypto/tokens.js';

/** Audit-safe view of a mailbox: never includes the token. */
export function accountSummary(a: EmailAccount) {
  return { id: a.id, address: a.address, sendAs: a.sendAs, provider: a.provider, kind: a.kind, userId: a.userId, status: a.status };
}

/** Stores the system mailbox, replacing any previous one (there is only ever one `kind='system'` row). */
export async function connectSystemMailbox(args: {
  address: string;
  /** Shared mailbox to send as; defaults to `address`. */
  sendAs?: string;
  refreshToken: string;
  tokenExpiresAt?: Date;
  actorId: number;
}): Promise<EmailAccount> {
  const address = args.address.trim().toLowerCase();
  const sendAs = args.sendAs?.trim().toLowerCase() || address;
  const data = {
    sendAs,
    provider: 'microsoft',
    kind: 'system',
    userId: args.actorId,
    refreshTokenEnc: encrypt(args.refreshToken),
    tokenExpiresAt: args.tokenExpiresAt ?? null,
    status: 'connected',
    lastError: null,
  } satisfies Prisma.EmailAccountUncheckedUpdateInput;

  return prisma.$transaction(async (tx) => {
    const previous = await tx.emailAccount.findMany({ where: { kind: 'system', NOT: { address } } });
    for (const p of previous) {
      await tx.emailAccount.delete({ where: { id: p.id } });
      await audit(tx, { entityType: 'email_account', entityId: p.id, action: 'delete', userId: args.actorId, before: accountSummary(p) });
    }
    const key = { address_kind: { address, kind: 'system' } };
    const before = await tx.emailAccount.findUnique({ where: key });
    const account = await tx.emailAccount.upsert({ where: key, create: { address, ...data }, update: data });
    await audit(tx, {
      entityType: 'email_account',
      entityId: account.id,
      action: before ? 'update' : 'create',
      userId: args.actorId,
      before: before ? accountSummary(before) : undefined,
      after: accountSummary(account),
    });
    return account;
  });
}

/** The mailbox is already connected by another user (not disconnected): it is never moved silently. */
export class MailboxTakenError extends Error {
  readonly code = 'mailbox_taken';
}

/**
 * Stores a user's own mailbox (release 2A): one `kind='personal'` row per user. Reconnecting with the same
 * address refreshes the token; with another address the old row is replaced. The token is stored encrypted.
 */
export async function connectPersonalMailbox(args: {
  userId: number;
  address: string;
  refreshToken: string;
  tokenExpiresAt?: Date;
}): Promise<EmailAccount> {
  const address = args.address.trim().toLowerCase();
  const data = {
    userId: args.userId,
    provider: 'microsoft',
    refreshTokenEnc: encrypt(args.refreshToken),
    tokenExpiresAt: args.tokenExpiresAt ?? null,
    status: 'connected',
    lastError: null,
  } satisfies Prisma.EmailAccountUncheckedUpdateInput;
  return prisma.$transaction(async (tx) => {
    const previous = await tx.emailAccount.findMany({ where: { kind: 'personal', userId: args.userId, NOT: { address } } });
    for (const p of previous) {
      await tx.emailAccount.delete({ where: { id: p.id } });
      await audit(tx, { entityType: 'email_account', entityId: p.id, action: 'delete', userId: args.userId, before: accountSummary(p) });
    }
    const key = { address_kind: { address, kind: 'personal' } };
    const before = await tx.emailAccount.findUnique({ where: key });
    // Another user's live connection stays theirs; a disconnected or orphaned one may be taken over.
    if (before && before.userId !== null && before.userId !== args.userId && before.status !== 'disconnected') {
      throw new MailboxTakenError();
    }
    const account = await tx.emailAccount.upsert({ where: key, create: { address, kind: 'personal', ...data }, update: data });
    await audit(tx, {
      entityType: 'email_account',
      entityId: account.id,
      action: before ? 'update' : 'create',
      userId: args.userId,
      before: before ? accountSummary(before) : undefined,
      after: accountSummary(account),
    });
    return account;
  });
}
