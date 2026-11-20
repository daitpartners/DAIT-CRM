import { randomBytes } from 'node:crypto';
import type { Session, User } from '@prisma/client';
import { prisma } from '../db.js';

export const SESSION_COOKIE = 'crm_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(userId: number): Promise<Session> {
  return prisma.session.create({
    data: { id: newSessionId(), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
}

/** Returns the live session with its user, deleting it on sight when expired. */
export async function findSession(id: string): Promise<(Session & { user: User }) | null> {
  const session = await prisma.session.findUnique({ where: { id }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await deleteSession(id);
    return null;
  }
  return session;
}

/** Slides the expiry when the session was last seen more than TOUCH_INTERVAL_MS ago. Returns the new expiry, or null when untouched. */
export async function touchSession(session: Session): Promise<Date | null> {
  const now = Date.now();
  if (now - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return null;
  const expiresAt = new Date(now + SESSION_TTL_MS);
  await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt } });
  return expiresAt;
}

export async function deleteSession(id: string): Promise<void> {
  await prisma.session.deleteMany({ where: { id } });
}
