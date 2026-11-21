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
