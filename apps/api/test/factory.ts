import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import type { RoleEnum } from '@dait-crm/shared';
import { prisma } from '../src/db';

let n = 0;

export async function makeUser(
  overrides: Partial<{ email: string; name: string; role: RoleEnum; isActive: boolean; language: string }> = {},
): Promise<User> {
  n += 1;
  return prisma.user.create({
    data: {
      email: (overrides.email ?? `user${n}@daitpartners.com`).toLowerCase(),
      name: overrides.name ?? `User ${n}`,
      role: overrides.role ?? 'SALES_REPRESENTATIVE',
      isActive: overrides.isActive ?? true,
      language: overrides.language ?? 'en',
    },
  });
}

/** Signs in through the test-login route and returns the `Cookie` header value. */
export async function signIn(app: FastifyInstance, user: Pick<User, 'email'>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/test-login', payload: { email: user.email } });
  if (res.statusCode !== 204) throw new Error(`test-login failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'crm_session');
  if (!c) throw new Error('test-login set no crm_session cookie');
  return `crm_session=${c.value}`;
}
