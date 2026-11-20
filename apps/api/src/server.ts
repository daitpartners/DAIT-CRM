import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';

const app = await buildApp({ logger: true });

const webDist = process.env.WEB_DIST;
if (webDist) {
  const root = path.resolve(webDist);
  await app.register(fastifyStatic, { root });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
}

const port = Number(process.env.PORT ?? 3090);
// Loopback by default: OpenLiteSpeed proxies to it, so the app is never reachable directly from outside.
const host = process.env.HOST || '127.0.0.1';
try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
