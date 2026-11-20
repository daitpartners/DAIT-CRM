import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import type { MicrosoftClient } from '../auth/microsoft.js';
import { verifyLocalAdmin } from '../auth/local.js';
import { SESSION_COOKIE, createSession, deleteSession } from '../auth/session.js';
import { sessionCookieOptions } from '../plugins/auth.js';

export interface AuthRoutesOptions {
  microsoft: MicrosoftClient | null;
  localLogin: boolean;
  testLogin: boolean;
  secureCookies: boolean;
}

const MS_STATE_COOKIE = 'ms_state';
const MS_STATE_MAX_AGE_S = 10 * 60;
const NOT_REGISTERED = '/sign-in?error=not-registered';

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

  app.get('/auth/options', async () => ({ localLogin: opts.localLogin, testLogin: opts.testLogin }));

  app.get('/auth/microsoft', async (_request, reply) => {
    if (!microsoft) return reply.code(503).send({ error: 'microsoft_not_configured' });
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = await microsoft.getAuthUrl({ state, codeVerifier: verifier, codeChallenge: challenge });
    reply.setCookie(MS_STATE_COOKIE, JSON.stringify({ state, verifier, mode: 'signin' }), {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: MS_STATE_MAX_AGE_S,
      signed: true,
    });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/microsoft/callback',
    async (request, reply) => {
      if (!microsoft) return reply.code(503).send({ error: 'microsoft_not_configured' });
      const raw = request.cookies[MS_STATE_COOKIE];
      reply.clearCookie(MS_STATE_COOKIE, { path: '/api/auth' });
      const unsigned = raw ? request.unsignCookie(raw) : null;
      let saved: { state?: unknown; verifier?: unknown } = {};
      try {
        if (unsigned?.valid && unsigned.value) saved = JSON.parse(unsigned.value);
      } catch {
        saved = {};
      }
      const { code, state } = request.query;
      if (
        typeof saved.state !== 'string' || typeof saved.verifier !== 'string' ||
        !state || !safeEqual(saved.state, state)
      ) {
        return reply.redirect('/sign-in?error=state');
      }
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
