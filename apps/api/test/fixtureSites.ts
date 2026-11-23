/**
 * A local HTTP server for the website reader tests (no real network calls). It binds to 127.0.0.1 and serves the
 * fixture sites in test/fixtures/sites by Host header; the tests map the `*.test` names to 127.0.0.1 with an injected
 * resolver and put them on the RESEARCH_TEST_ALLOW_HOSTS allow-list.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const SITES = join(import.meta.dirname, 'fixtures', 'sites');

/** Host → path → fixture file. */
const ROUTES: Record<string, Record<string, string>> = {
  'site.test': {
    '/': 'acme/index.html',
    '/about-us': 'acme/about-us.html',
    '/contact': 'acme/contact.html',
    '/private/company-history': 'acme/private-company-history.html',
    '/robots.txt': 'acme/robots.txt',
  },
  'meta.test': { '/': 'meta-only/index.html' },
};

/** Hosts the reader tests may reach (all served by this server on 127.0.0.1). */
export const FIXTURE_HOSTS = [
  'site.test', 'meta.test', 'other.test', 'slow.test', 'big.test', 'blocked.test', 'hop.test', 'gzip.test',
  'mailto.test', 'freight.test', 'nomail.test',
];

export const BIG_PAGE_BYTES = 2 * 1024 * 1024;

export interface FixtureServer {
  port: number;
  /** Every request seen, as `host path`. */
  requests: string[];
  userAgents: string[];
  /** Bytes the server managed to write for the 2 MB page before the client hung up. */
  bigBytesWritten: () => number;
  url: (host: string, path?: string) => string;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const userAgents: string[] = [];
  let bigBytes = 0;
  let port = 0;
  const hanging = new Set<ServerResponse>();

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    requests.push(`${host} ${path}`);
    userAgents.push(String(req.headers['user-agent'] ?? ''));

    if (path === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end();
      return;
    }
    if (path.startsWith('/hop/')) {
      const n = Number(path.slice(5));
      res.writeHead(302, { location: n > 0 ? `/hop/${n - 1}` : '/' }).end();
      return;
    }
    if (host === 'slow.test' && path !== '/robots.txt') {
      hanging.add(res); // never answers
      return;
    }
    if (host === 'big.test' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const head = '<!doctype html><html><head><title>Big</title><meta name="description" content="A very big page.">'
        + '</head><body><p>';
      const chunk = 'x'.repeat(64 * 1024);
      res.write(head);
      bigBytes = head.length;
      let clientGone = false;
      res.on('close', () => { clientGone = true; });
      let paused = false;
      const pump = () => {
        while (bigBytes < BIG_PAGE_BYTES) {
          if (clientGone) return;
          // Past the 1.5 MB limit, pause so the client's hang-up is seen before the rest is written
          // (otherwise loopback socket buffers can swallow the whole page first).
          if (!paused && bigBytes > 1.6 * 1024 * 1024) { paused = true; setTimeout(pump, 300); return; }
          bigBytes += chunk.length;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end('</p></body></html>');
      };
      res.on('error', () => {});
      pump();
      return;
    }
    if (host === 'blocked.test' && path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
        .end('User-agent: DAIT-CRM-Research\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
      return;
    }
    if (host === 'gzip.test' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
        .end(gzipSync('<html><head><title>Zipped</title><meta name="description" content="Compressed page."></head></html>'));
      return;
    }
    if (host === 'mailto.test' && path === '/') {
      // A hostile 1M-character mailto (no dot after the @, so a backtracking email regex would crawl), then a real one.
      const hostile = 'mailto:' + 'a'.repeat(500_000) + '@' + 'b'.repeat(500_000);
      res.writeHead(200, { 'content-type': 'text/html' })
        .end(`<html><body><a href="${hostile}">x</a><a href="mailto:office@mailto.test">office</a></body></html>`);
      return;
    }
    if (host === 'nomail.test') {
      // Import research: an email and a phone written as text only (no mailto, no JSON-LD), for Claude to cite.
      if (path !== '/') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>No Mail Ltd</title></head>
<body><h1>No Mail Ltd</h1><p>Sales: sales@nomail.test, or ring +91 (20) 5555-0199.</p></body></html>`);
      return;
    }
    if (host === 'freight.test') {
      // Import research: JSON-LD address in Pune and a same-domain mailto; no phone, no links to other pages.
      if (path !== '/') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>Fixture Freight</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture Freight",
"address":{"@type":"PostalAddress","addressLocality":"Pune","addressCountry":"IN"}}</script></head>
<body><h1>Fixture Freight</h1><p>Road and rail freight across Maharashtra.</p>
<p>Write to <a href="mailto:office@freight.test">office@freight.test</a>.</p></body></html>`);
      return;
    }
    if (host === 'other.test' || host === 'hop.test' || host === 'mailto.test') {
      if (path === '/robots.txt') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>${host}</title></head><body>ok</body></html>`);
      return;
    }
    const file = ROUTES[host]?.[path];
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const type = file.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8';
    const headers: Record<string, string> = { 'content-type': type };
    if (host === 'meta.test') headers['cf-ray'] = '8d1f2e3a4b5c6d7e-LHR';
    res.writeHead(200, headers).end(readFileSync(join(SITES, file)));
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    userAgents,
    bigBytesWritten: () => bigBytes,
    url: (host, path = '/') => `http://${host}:${port}${path}`,
    close: async () => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Resolver for the tests: every fixture host → 127.0.0.1; anything else from the given map, else not found. */
export function fixtureResolver(extra: Record<string, string[]> = {}): (host: string) => Promise<string[]> {
  return async (host) => {
    if (FIXTURE_HOSTS.includes(host)) return ['127.0.0.1'];
    const hit = extra[host];
    if (hit) return hit;
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  };
}
