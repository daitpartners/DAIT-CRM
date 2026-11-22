import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { userRoutes } from './routes/users.js';
import { lookupRoutes } from './routes/lookups.js';
import { allocationRoutes } from './routes/allocation.js';
import { mailboxRoutes } from './routes/mailboxes.js';
import { jobRoutes } from './routes/jobs.js';
import { companyRoutes } from './routes/companies.js';
import { contactRoutes } from './routes/contacts.js';
import { locationRoutes } from './routes/locations.js';
import { leadRoutes } from './routes/leads.js';
import { taskRoutes } from './routes/tasks.js';
import { calendarRoutes } from './routes/calendar.js';
import { notificationRoutes } from './routes/notifications.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { importRoutes } from './routes/imports.js';
import { navCountRoutes } from './routes/navCounts.js';
import { reportRoutes } from './routes/reports.js';
import { emailTemplateRoutes } from './routes/emailTemplates.js';
import { leadEmailRoutes } from './routes/leadEmails.js';
import { mailRoutes } from './routes/mail.js';
import { mailerRoutes } from './routes/mailer.js';
import { NotFoundError, ValidationError } from './validate.js';
import { registerAuth } from './plugins/auth.js';
import { createMsalClient, type MicrosoftClient } from './auth/microsoft.js';
import { createGraphClient, type GraphClient } from './graph/client.js';

export interface BuildAppOptions {
  logger?: boolean;
  microsoft?: MicrosoftClient;
  /** Microsoft Graph client used by routes that talk to mailboxes; defaults to the real one. */
  graph?: GraphClient;
}

declare module 'fastify' {
  interface FastifyInstance {
    graph: GraphClient;
  }
}

function sessionSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set (32+ characters)');
  // Dev fallback: in-flight Microsoft sign-ins do not survive a restart.
  return randomBytes(32).toString('base64url');
}

/** Route patterns that accept cross-site writes (public forms, plan 1D). Every other write must be same-origin. */
const PUBLIC_PATH_PREFIXES = ['/api/public/'];

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Same-site CSRF guard for state-changing requests. A browser always sends `Origin` on cross-origin
 * writes; when it is absent, `Sec-Fetch-Site` (sent by every current browser) must not say cross-site.
 * Non-browser clients send neither and are let through (they cannot ride a user's cookies).
 */
function isSameOrigin(request: FastifyRequest, expectedOrigin: string | null): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (expectedOrigin) return origin === expectedOrigin;
    // PUBLIC_URL unset (development only; production requires it): the origin must match the Host header.
    const given = originOf(origin);
    return given !== null && new URL(given).host === request.headers.host;
  }
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

function publicUrl(env: NodeJS.ProcessEnv): string {
  const url = env.PUBLIC_URL ?? '';
  if (env.NODE_ENV === 'production' && !url.startsWith('https://')) {
    throw new Error('PUBLIC_URL must be set to the https:// origin of the site when NODE_ENV=production');
  }
  return url;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = process.env;
  const publicOrigin = publicUrl(env);
  const secureCookies = publicOrigin.startsWith('https://');
  const expectedOrigin = publicOrigin ? originOf(publicOrigin) : null;
  const localLogin = env.LOCAL_ADMIN_LOGIN === '1';
  const testLogin = env.TEST_LOGIN === '1' && env.NODE_ENV !== 'production';
  const microsoft = opts.microsoft ?? (env.MS_CLIENT_ID ? createMsalClient(env) : null);

  const app = Fastify({
    // OpenLiteSpeed proxies from loopback: trust only its X-Forwarded-For so rate limits see the real client IP.
    trustProxy: ['127.0.0.1', '::1'],
    // Query strings are dropped from request logs so OAuth codes never reach them.
    logger: opts.logger
      ? { serializers: { req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }) } }
      : false,
  });
  // Only JSON bodies are accepted: a text/plain POST (a "simple" cross-site request) gets 415.
  app.removeContentTypeParser('text/plain');
  app.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    // Decide from the matched route pattern, never the raw URL: the router decodes `%61pi` to `api`,
    // so a raw-path test could be bypassed. Unmatched (404) requests have no route url and are checked too.
    const route = request.routeOptions?.url;
    if (route && isPublicPath(route)) return;
    if (!isSameOrigin(request, expectedOrigin)) return reply.code(403).send({ error: 'bad_origin' });
  });
  await app.register(cookie, { secret: sessionSecret(env) });
  await app.register(rateLimit, { global: false });
  app.decorate('graph', opts.graph ?? createGraphClient(env));
  registerAuth(app, { secureCookies });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: 'validation', issues: error.issues });
    if (error instanceof NotFoundError) return reply.code(404).send({ error: 'not_found' });
    return reply.send(error);
  });

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api', microsoft, localLogin, testLogin, secureCookies });
  await app.register(meRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(lookupRoutes, { prefix: '/api' });
  await app.register(allocationRoutes, { prefix: '/api' });
  await app.register(mailboxRoutes, { prefix: '/api' });
  await app.register(jobRoutes, { prefix: '/api' });
  await app.register(companyRoutes, { prefix: '/api' });
  await app.register(contactRoutes, { prefix: '/api' });
  await app.register(locationRoutes, { prefix: '/api' });
  await app.register(leadRoutes, { prefix: '/api' });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.register(calendarRoutes, { prefix: '/api' });
  await app.register(notificationRoutes, { prefix: '/api' });
  await app.register(navCountRoutes, { prefix: '/api' });
  await app.register(reportRoutes, { prefix: '/api' });
  await app.register(emailTemplateRoutes, { prefix: '/api' });
  await app.register(leadEmailRoutes, { prefix: '/api' });
  await app.register(mailRoutes, { prefix: '/api' });
  await app.register(mailerRoutes, { prefix: '/api' });
  await app.register(dashboardRoutes, { prefix: '/api' });
  await app.register(importRoutes, { prefix: '/api' });
  return app;
}
