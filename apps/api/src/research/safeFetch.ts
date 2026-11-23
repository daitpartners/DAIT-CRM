/**
 * Fetching public web pages for the website reader, safely (release 4 AI research).
 *
 * - http(s) only, no credentials in the URL;
 * - the host must resolve only to public addresses: if ANY address is private, loopback, link-local, unique-local,
 *   multicast, reserved or unspecified (IPv4 and IPv6, including IPv4-mapped / NAT64 / 6to4 forms) it is refused;
 * - the connection is made to the address that was checked (the check runs inside the socket's DNS lookup, so a
 *   second, rebinding answer is never asked for);
 * - every redirect hop is checked again, at most 5 redirects;
 * - 1.5 MB body limit (after decompression), 10 s for the whole fetch, a CRM user-agent.
 *
 * Tests reach a local fixture server through RESEARCH_TEST_ALLOW_HOSTS, which is honoured only when NODE_ENV is
 * 'test' (vitest, and the e2e server — apps/web/e2e/start-server.sh) or 'e2e'. In production it is ignored.
 */
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import zlib from 'node:zlib';

export const RESEARCH_USER_AGENT = 'DAIT-CRM-Research/1.0 (+https://crm.daitpartners.com)';
/** robots.txt user-agent token (RFC 9309 product token, matched case-insensitively). */
export const ROBOTS_AGENT = 'dait-crm-research';
export const PAGE_MAX_BYTES = 1.5 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
const ROBOTS_MAX_BYTES = 512 * 1024;

export type ResolveFn = (host: string) => Promise<string[]>;

export type SafeFetchErrorCode = 'bad_url' | 'bad_scheme' | 'blocked_host' | 'timeout' | 'too_many_redirects' | 'network';

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  /** DNS resolver; default: the system resolver (all addresses). */
  resolve?: ResolveFn;
  /**
   * Test seam: a fetch to use instead of the built-in client. Honoured only when NODE_ENV is 'test' or 'e2e' (it
   * cannot pin the connection to the checked address); otherwise ignored and the pinned client is used. Every hop is
   * still checked (scheme, port, DNS answer) before it is requested.
   */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Environment for the test allow-list; default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SafeResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string;
  /** The body was cut at the size limit. */
  truncated: boolean;
}

/** Test seams (allow-list, injected fetch) exist only when NODE_ENV is 'test' or 'e2e'; never in production. */
function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' || env.NODE_ENV === 'e2e';
}

/** Hosts tests may reach although they resolve to loopback (and on any port): only under NODE_ENV test/e2e. */
export function allowedTestHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  if (!isTestEnv(env)) return new Set();
  return new Set((env.RESEARCH_TEST_ALLOW_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
}

// ---------------------------------------------------------------------------------------------------------------
// Address classification

function parseIPv4(s: string): number[] | null {
  if (isIP(s) !== 4) return null;
  return s.split('.').map(Number);
}

function isPublicIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // "this network", private, loopback
  if (a === 100 && b! >= 64 && b! <= 127) return false; // shared address space (CGNAT)
  if (a === 169 && b === 254) return false; // link-local (cloud metadata)
  if (a === 172 && b! >= 16 && b! <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a! >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups, or null. Handles `::`, an embedded dotted IPv4 tail and a zone id. */
function parseIPv6(input: string): number[] | null {
  let s = input.replace(/%.*$/, '');
  if (isIP(s) !== 6) return null;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseIPv4(dotted[1]!);
    if (!v4) return null;
    s = s.slice(0, -dotted[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  let groups: string[];
  if (s.includes('::')) {
    const [left, right] = s.split('::') as [string, string];
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    groups = [...l, ...Array<string>(8 - l.length - r.length).fill('0'), ...r];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isPublicIPv6(h: number[]): boolean {
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && h[5] === 0xffff) return isPublicIPv4(embeddedV4(h[6]!, h[7]!)); // ::ffff:a.b.c.d mapped
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return isPublicIPv4(embeddedV4(h[6]!, h[7]!)); // ::ffff:0:a.b.c.d
  if (zeros(0, 6)) return false; // ::, ::1, deprecated IPv4-compatible
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return isPublicIPv4(embeddedV4(h[6]!, h[7]!)); // NAT64
  if (h[0] === 0x2002) return isPublicIPv4(embeddedV4(h[1]!, h[2]!)); // 6to4
  if ((h[0]! & 0xe000) !== 0x2000) return false; // outside global unicast 2000::/3 (fc00::/7, fe80::/10, ff00::/8, …)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // documentation
  if (h[0] === 0x2001 && h[1] === 0) return false; // Teredo
  return true;
}

/** True only for a syntactically valid IP address in public unicast space. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  return v6 ? isPublicIPv6(v6) : false;
}

// ---------------------------------------------------------------------------------------------------------------
// Fetching

const defaultResolve: ResolveFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

const BLOCKED = 'Website is not on a public address';

interface Ctx {
  resolve: ResolveFn;
  allowed: Set<string>;
  maxBytes: number;
  signal: AbortSignal;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Scheme, credentials and IP-literal checks; returns the bare host. */
function checkUrl(url: URL, ctx: Ctx): string {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('bad_scheme', 'Only http and https addresses can be fetched');
  }
  if (url.username || url.password) throw new SafeFetchError('bad_url', 'Addresses with credentials are not fetched');
  const host = hostOf(url);
  if (!host) throw new SafeFetchError('bad_url', 'Address has no host');
  if (ctx.allowed.has(host)) return host;
  // Web ports only: url.port is '' for the scheme's default port.
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw new SafeFetchError('blocked_host', 'Only ports 80 and 443 are fetched');
  }
  if (isIP(host) && !isPublicAddress(host)) throw new SafeFetchError('blocked_host', BLOCKED);
  return host;
}

/** Resolves the host and refuses it if any address is not public (unless allow-listed in tests). */
async function resolveChecked(host: string, ctx: Ctx): Promise<string[]> {
  if (isIP(host)) return [host];
  let addresses: string[];
  try {
    addresses = await ctx.resolve(host);
  } catch {
    throw new SafeFetchError('network', `Could not resolve ${host}`);
  }
  if (addresses.length === 0) throw new SafeFetchError('network', `Could not resolve ${host}`);
  if (!ctx.allowed.has(host) && addresses.some((a) => !isPublicAddress(a))) {
    throw new SafeFetchError('blocked_host', BLOCKED);
  }
  return addresses;
}

function charsetOf(contentType: string | undefined): string {
  return contentType?.match(/charset="?([\w-]+)/i)?.[1] ?? 'utf-8';
}

function decode(buf: Buffer, contentType: string | undefined): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

const REQUEST_HEADERS = {
  'user-agent': RESEARCH_USER_AGENT,
  accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
};

/** One request with the built-in client; the socket connects to the address the lookup checked. */
function nodeRequest(url: URL, host: string, ctx: Ctx): Promise<RawResponse> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      resolveChecked(host, ctx).then(
        (addresses) => {
          if (options.all) callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
          else callback(null, addresses[0]!, isIP(addresses[0]!));
        },
        (err: Error) => {
          fail(err); // keep our SafeFetchError rather than however the socket wraps it
          callback(err as NodeJS.ErrnoException, '', 0);
        },
      );
    };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      headers: { ...REQUEST_HEADERS, 'accept-encoding': 'gzip, deflate, br', connection: 'close' },
      agent: false,
      lookup: pinnedLookup,
      signal: ctx.signal,
    }, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        settled = true;
        resolvePromise({ status, headers, body: '', truncated: false });
        return;
      }
      const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
      const decompressor = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
        : encoding === 'deflate' ? zlib.createInflate()
          : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      const stream: Readable = decompressor ? pipeline(res, decompressor, (err) => { if (err) fail(err); }) : res;
      const chunks: Buffer[] = [];
      let total = 0;
      const finish = (truncated: boolean) => {
        if (settled) return;
        settled = true;
        resolvePromise({ status, headers, body: decode(Buffer.concat(chunks), headers['content-type']), truncated });
      };
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = ctx.maxBytes - total;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          total += room;
          finish(true);
          res.destroy();
          decompressor?.destroy();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      stream.on('end', () => finish(false));
      stream.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

/** One request through an injected fetch (tests only): checked before it is sent, not pinned. */
async function injectedRequest(url: URL, host: string, ctx: Ctx, fetchImpl: typeof fetch): Promise<RawResponse> {
  await resolveChecked(host, ctx);
  const res = await fetchImpl(url.href, { redirect: 'manual', headers: REQUEST_HEADERS, signal: ctx.signal });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, headers, body: '', truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = ctx.maxBytes - total;
    if (value.length >= room) {
      chunks.push(value.subarray(0, room));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { status: res.status, headers, body: decode(Buffer.concat(chunks), headers['content-type']), truncated };
}

/** GET a public web page. Throws SafeFetchError. */
export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeFetchError('bad_url', 'Not a valid address');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PAGE_TIMEOUT_MS);
  const env = opts.env ?? process.env;
  const fetchImpl = isTestEnv(env) ? opts.fetchImpl : undefined;
  const ctx: Ctx = {
    resolve: opts.resolve ?? defaultResolve,
    allowed: allowedTestHosts(env),
    maxBytes: opts.maxBytes ?? PAGE_MAX_BYTES,
    signal: controller.signal,
  };
  // A DNS answer that never comes must not outlive the timeout either.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new SafeFetchError('timeout', 'Timeout fetching site')));
  });
  aborted.catch(() => {});
  try {
    for (let redirects = 0; ; redirects++) {
      const host = checkUrl(url, ctx);
      const raw = await Promise.race([
        fetchImpl ? injectedRequest(url, host, ctx, fetchImpl) : nodeRequest(url, host, ctx),
        aborted,
      ]);
      const location = raw.headers.location;
      if (raw.status >= 300 && raw.status < 400 && location) {
        if (redirects >= MAX_REDIRECTS) throw new SafeFetchError('too_many_redirects', 'Too many redirects');
        try {
          url = new URL(location, url);
        } catch {
          throw new SafeFetchError('bad_url', 'Redirect to an invalid address');
        }
        continue;
      }
      return { url: url.href, status: raw.status, headers: raw.headers, body: raw.body, truncated: raw.truncated };
    }
  } catch (err) {
    if (controller.signal.aborted) throw new SafeFetchError('timeout', 'Timeout fetching site');
    if (err instanceof SafeFetchError) throw err;
    throw new SafeFetchError('network', err instanceof Error ? err.message : 'Network error');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// robots.txt (RFC 9309)

export interface RobotsRules {
  /** Whether our agent may fetch this path (path + query). */
  allows(path: string): boolean;
}

interface Rule { allow: boolean; pattern: string }

/** Patterns longer than this are ignored. */
const ROBOTS_PATTERN_MAX = 512;
/** At most this many rules are kept across all the groups that apply to us (repeated groups are merged). */
const ROBOTS_RULES_MAX = 500;
/** Longer paths are treated as disallowed rather than matched. */
const ROBOTS_PATH_MAX = 2048;

/**
 * RFC 9309 path match: `*` matches any run of characters, a final `$` anchors the end (a `$` elsewhere is literal),
 * otherwise a prefix match. Segment matcher: the pattern is split on `*`; the first segment must be a prefix, each
 * middle segment is found leftmost from a forward-only cursor (never backtracking), and the last segment must end
 * the path (anchored) or occur after the cursor. Leftmost matching is always sufficient for `*`-only globs, and the
 * work per rule is a handful of indexOf scans over the path, so a hostile robots.txt can't stall the worker.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const segments = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = segments[0]!;
  if (segments.length === 1) return anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let cursor = first.length;
  for (let k = 1; k < segments.length - 1; k++) {
    const segment = segments[k]!;
    if (!segment) continue;
    const at = path.indexOf(segment, cursor);
    if (at < 0) return false;
    cursor = at + segment.length;
  }
  const last = segments[segments.length - 1]!;
  if (anchored) return path.length - last.length >= cursor && path.endsWith(last);
  return !last || path.indexOf(last, cursor) >= 0;
}

export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (key !== 'allow' && key !== 'disallow')) continue;
    if (!value || value.length > ROBOTS_PATTERN_MAX) continue; // "Disallow:" with no path disallows nothing
    current.rules.push({ allow: key === 'allow', pattern: value });
  }
  const ours = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).slice(0, ROBOTS_RULES_MAX);
  return {
    allows(path: string) {
      if (path.length > ROBOTS_PATH_MAX) return false;
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!robotsPatternMatches(rule.pattern, path)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

const ALLOW_ALL: RobotsRules = { allows: () => true };
const DISALLOW_ALL: RobotsRules = { allows: () => false };

/**
 * The robots.txt rules for an origin: 2xx → parsed; 4xx → everything allowed; 5xx → nothing allowed (RFC 9309).
 * Fetch errors (timeout, refused host, unreachable) are thrown, so the caller reports them like a page error.
 */
export async function fetchRobots(origin: URL, opts: SafeFetchOptions = {}): Promise<RobotsRules> {
  const res = await safeFetch(new URL('/robots.txt', origin).href, { ...opts, maxBytes: ROBOTS_MAX_BYTES });
  if (res.status >= 200 && res.status < 300) return parseRobots(res.body);
  if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
  return DISALLOW_ALL;
}
