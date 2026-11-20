import argon2 from 'argon2';
import type { User } from '@prisma/client';
import { prisma } from '../db.js';

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies local-admin credentials. Always runs one argon2 verify so unknown
 * emails take the same time as wrong passwords.
 */
export async function verifyLocalAdmin(email: string, password: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  const eligible = user && user.isLocalAdmin && user.isActive && user.passwordHash;
  dummyHash ??= hashPassword('dummy-password-for-timing');
  const hash = eligible ? user.passwordHash! : await dummyHash;
  let ok = false;
  try {
    ok = await argon2.verify(hash, password);
  } catch {
    ok = false;
  }
  return eligible && ok ? user : null;
}
