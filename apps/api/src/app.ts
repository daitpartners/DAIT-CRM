import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { userRoutes } from './routes/users.js';
import { lookupRoutes } from './routes/lookups.js';
import { allocationRoutes } from './routes/allocation.js';
import { ValidationError } from './validate.js';
import { registerAuth } from './plugins/auth.js';
import { createMsalClient, type MicrosoftClient } from './auth/microsoft.js';

export interface BuildAppOptions {
  logger?: boolean;
  microsoft?: MicrosoftClient;
}

function sessionSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set (32+ characters)');
  // Dev fallback: in-flight Microsoft sign-ins do not survive a restart.
  return randomBytes(32).toString('base64url');
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = process.env;
  const secureCookies = (env.PUBLIC_URL ?? '').startsWith('https');
  const localLogin = env.LOCAL_ADMIN_LOGIN === '1';
  const testLogin = env.TEST_LOGIN === '1' && env.NODE_ENV !== 'production';
  const microsoft = opts.microsoft ?? (env.MS_CLIENT_ID ? createMsalClient(env) : null);

  const app = Fastify({
    // Query strings are dropped from request logs so OAuth codes never reach them.
    logger: opts.logger
      ? { serializers: { req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }) } }
      : false,
  });
  await app.register(cookie, { secret: sessionSecret(env) });
  await app.register(rateLimit, { global: false });
  registerAuth(app, { secureCookies });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: 'validation', issues: error.issues });
    return reply.send(error);
  });

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api', microsoft, localLogin, testLogin, secureCookies });
  await app.register(meRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(lookupRoutes, { prefix: '/api' });
  await app.register(allocationRoutes, { prefix: '/api' });
  return app;
}
