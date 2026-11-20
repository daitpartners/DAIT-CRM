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
try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
