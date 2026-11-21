import type { Prisma } from '@prisma/client';

/** In-app notification for `userId` (no email in 1C). */
export async function notifyUser(
  tx: Prisma.TransactionClient, userId: number, text: string, detail?: string | null, link?: string | null,
): Promise<void> {
  await tx.notification.create({ data: { userId, text, detail: detail ?? null, link: link ?? null } });
}
