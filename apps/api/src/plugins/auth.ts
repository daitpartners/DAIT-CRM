import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { can, roleLabel, type Action, type Role } from '@dait-crm/shared';
import { SESSION_COOKIE, deleteSession, findSession, touchSession } from '../auth/session.js';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  language: string;
  timezone: string;
  dateFormat: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function sessionCookieOptions(secure: boolean, expires?: Date) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    ...(expires ? { expires } : {}),
  };
}

/** Resolves `request.user` from the session cookie on every request. Never rejects. */
export function registerAuth(app: FastifyInstance, opts: { secureCookies: boolean }): void {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    request.user = null;
    const id = request.cookies[SESSION_COOKIE];
    if (!id) return;
    const session = await findSession(id);
    if (!session) return;
    if (!session.user.isActive) {
      await deleteSession(session.id);
      return;
    }
    const newExpiry = await touchSession(session);
    if (newExpiry) reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(opts.secureCookies, newExpiry));
    const u = session.user;
    request.user = {
      id: u.id,
      email: u.email,
      name: u.name,
      role: roleLabel(u.role),
      language: u.language,
      timezone: u.timezone,
      dateFormat: u.dateFormat,
    };
  });
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) await reply.code(401).send({ error: 'unauthenticated' });
}

export function requireRight(action: Action): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    if (!can(request.user.role, action)) return reply.code(403).send({ error: 'forbidden' });
  };
}
