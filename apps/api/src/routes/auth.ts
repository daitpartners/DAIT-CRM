import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { can } from '@dait-crm/shared';
import { CONNECT_SCOPES, type MicrosoftClient } from '../auth/microsoft.js';
import { connectSystemMailbox } from '../graph/accounts.js';
import { verifyLocalAdmin } from '../auth/local.js';
import { SESSION_COOKIE, createSession, deleteSession } from '../auth/session.js';
import { requireRight, sessionCookieOptions } from '../plugins/auth.js';

export interface AuthRoutesOptions {
  microsoft: MicrosoftClient | null;
  localLogin: boolean;
  testLogin: boolean;
  secureCookies: boolean;
}

const MS_STATE_COOKIE = 'ms_state';
const MS_STATE_MAX_AGE_S = 10 * 60;
const NOT_REGISTERED = '/sign-in?error=not-registered';
const MAILBOX_CONNECTED = '/settings/mailbox?connected=1';
const MAILBOX_FAILED = '/settings/mailbox?error=connect-failed';

interface SavedState {
  state?: unknown;
  verifier?: unknown;
  mode?: unknown;
  userId?: unknown;
}

const emailBody = {
  type: 'object',
  required: ['email'],
  properties: { email: { type: 'string', minLength: 3, maxLength: 320 } },
} as const;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  const { microsoft, secureCookies } = opts;

  async function startSession(reply: FastifyReply, userId: number, previous?: string): Promise<void> {
    if (previous) await deleteSession(previous);
    const session = await createSession(userId);
    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    reply.setCookie(SESSION_COOKIE, session.id, sessionCookieOptions(secureCookies, session.expiresAt));
  }

  /** Callback leg of `GET /auth/microsoft/connect?mode=system`. Never logs or returns the token. */
  async function finishSystemConnect(
    request: FastifyRequest<{ Querystring: { code?: string; error?: string } }>,
    reply: FastifyReply,
    verifier: string,
    savedUserId: unknown,
  ) {
    const { code } = request.query;
    const actor = request.user;
    // The admin who started the connect must finish it, in the same session, and still hold the right.
    if (!microsoft || !actor || actor.id !== savedUserId || !can(actor.role, 'manage_users')) {
      return reply.redirect(MAILBOX_FAILED);
    }
    if (request.query.error || !code) return reply.redirect(MAILBOX_FAILED);
    try {
      const identity = await microsoft.redeemCode({ code, codeVerifier: verifier, scopes: CONNECT_SCOPES });
      if (!identity.refreshToken || !identity.email) throw new Error('missing_refresh_token');
      await connectSystemMailbox({
        address: identity.email,
        refreshToken: identity.refreshToken,
        tokenExpiresAt: identity.expiresOn,
        actorId: actor.id,
      });
    } catch (err) {
      request.log.warn({ errName: (err as Error)?.name }, 'system mailbox connect failed');
      return reply.redirect(MAILBOX_FAILED);
    }
    return reply.redirect(MAILBOX_CONNECTED);
  }

  app.get('/auth/options', async () => ({ localLogin: opts.localLogin, testLogin: opts.testLogin }));

  function pkce() {
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { state, verifier, challenge };
  }

  function setStateCookie(reply: FastifyReply, value: SavedState): void {
    reply.setCookie(MS_STATE_COOKIE, JSON.stringify(value), {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: MS_STATE_MAX_AGE_S,
      signed: true,
    });
  }

  app.get('/auth/microsoft', async (_request, reply) => {
    if (!microsoft) return reply.code(503).send({ error: 'microsoft_not_configured' });
    const { state, verifier, challenge } = pkce();
    const url = await microsoft.getAuthUrl({ state, codeVerifier: verifier, codeChallenge: challenge });
    setStateCookie(reply, { state, verifier, mode: 'signin' });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { mode?: string } }>(
    '/auth/microsoft/connect',
    { preHandler: [requireRight('manage_users')] },
    async (request, reply) => {
      if (request.query.mode !== 'system') return reply.code(400).send({ error: 'unsupported_mode' });
      if (!microsoft) return reply.code(503).send({ error: 'microsoft_not_configured' });
      const { state, verifier, challenge } = pkce();
      const url = await microsoft.getConnectUrl({ state, codeVerifier: verifier, codeChallenge: challenge, mode: 'system' });
      setStateCookie(reply, { state, verifier, mode: 'system', userId: request.user!.id });
      return reply.redirect(url);
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/microsoft/callback',
    async (request, reply) => {
      if (!microsoft) return reply.code(503).send({ error: 'microsoft_not_configured' });
      const raw = request.cookies[MS_STATE_COOKIE];
      reply.clearCookie(MS_STATE_COOKIE, { path: '/api/auth' });
      const unsigned = raw ? request.unsignCookie(raw) : null;
      let saved: SavedState = {};
      try {
        if (unsigned?.valid && unsigned.value) saved = JSON.parse(unsigned.value);
      } catch {
        saved = {};
      }
      const { code, state } = request.query;
      const system = saved.mode === 'system';
      if (
        typeof saved.state !== 'string' || typeof saved.verifier !== 'string' ||
        !state || !safeEqual(saved.state, state)
      ) {
        return reply.redirect(system ? MAILBOX_FAILED : '/sign-in?error=state');
      }
      if (system) return finishSystemConnect(request, reply, saved.verifier, saved.userId);
      if (request.query.error || !code) return reply.redirect('/sign-in?error=microsoft');

      let identity;
      try {
        identity = await microsoft.redeemCode({ code, codeVerifier: saved.verifier });
      } catch (err) {
        request.log.warn({ errName: (err as Error)?.name }, 'microsoft code redemption failed');
        return reply.redirect('/sign-in?error=microsoft');
      }

      const email = identity.email.trim().toLowerCase();
      let user = await prisma.user.findUnique({ where: { microsoftOid: identity.oid } });
      if (!user) {
        const byEmail = await prisma.user.findUnique({ where: { email } });
        // An email match already bound to a different Microsoft account is not the same person.
        if (byEmail && (!byEmail.microsoftOid || byEmail.microsoftOid === identity.oid)) user = byEmail;
      }
      if (!user || !user.isActive) return reply.redirect(NOT_REGISTERED);
      if (user.microsoftOid !== identity.oid) {
        await prisma.user.update({ where: { id: user.id }, data: { microsoftOid: identity.oid } });
      }
      await startSession(reply, user.id, request.cookies[SESSION_COOKIE]);
      return reply.redirect('/');
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const id = request.cookies[SESSION_COOKIE];
    if (id) await deleteSession(id);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(secureCookies));
    return reply.code(204).send();
  });

  if (opts.localLogin) {
    app.post<{ Body: { email: string; password: string } }>(
      '/auth/local',
      {
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: {
          body: {
            ...emailBody,
            required: ['email', 'password'],
            properties: { ...emailBody.properties, password: { type: 'string', minLength: 1, maxLength: 1024 } },
          },
        },
      },
      async (request, reply) => {
        const user = await verifyLocalAdmin(request.body.email, request.body.password);
        if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
        await startSession(reply, user.id, request.cookies[SESSION_COOKIE]);
        return reply.code(204).send();
      },
    );
  }

  if (opts.testLogin) {
    app.post<{ Body: { email: string } }>('/auth/test-login', { schema: { body: emailBody } }, async (request, reply) => {
      const user = await prisma.user.findUnique({ where: { email: request.body.email.trim().toLowerCase() } });
      if (!user || !user.isActive) return reply.code(404).send({ error: 'not_found' });
      await startSession(reply, user.id, request.cookies[SESSION_COOKIE]);
      return reply.code(204).send();
    });
  }
};
