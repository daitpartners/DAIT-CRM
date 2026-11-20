import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { healthRoutes } from './routes/health.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cookie);
  await app.register(healthRoutes, { prefix: '/api' });
  return app;
}
