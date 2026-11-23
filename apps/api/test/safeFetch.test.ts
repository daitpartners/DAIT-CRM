import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_REDIRECTS, PAGE_MAX_BYTES, RESEARCH_USER_AGENT, SafeFetchError, allowedTestHosts, fetchRobots,
  isPublicAddress, parseRobots, safeFetch,
} from '../src/research/safeFetch';
import { BIG_PAGE_BYTES, FIXTURE_HOSTS, fixtureResolver, startFixtureServer, type FixtureServer } from './fixtureSites';

let site: FixtureServer;
const resolve = fixtureResolver();

beforeAll(async () => {
  site = await startFixtureServer();
});
afterAll(async () => {
  await site.close();
});
beforeEach(() => {
  vi.stubEnv('RESEARCH_TEST_ALLOW_HOSTS', FIXTURE_HOSTS.join(','));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function failure(p: Promise<unknown>): Promise<SafeFetchError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SafeFetchError);
  return err as SafeFetchError;
}

describe('isPublicAddress', () => {
  test.each([
    '127.0.0.1', '127.255.0.9', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '0.1.2.3', '100.64.0.1', '224.0.0.1', '239.255.255.250', '255.255.255.255',
    '240.0.0.1', '192.0.2.10', '198.18.0.1', '198.51.100.7', '203.0.113.9', '192.0.0.8',
    '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:192.168.0.1',
    '::127.0.0.1', '64:ff9b::10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:c0a8:101::1', '2001:db8::1',
    '100::1', '::ffff:0:127.0.0.1', 'not-an-ip', '',
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  test.each([
    '93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.128.0.1', '11.0.0.1',
    '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
  ])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe('test allow-list', () => {
  test('honoured only when NODE_ENV is test or e2e', () => {
    expect([...allowedTestHosts({ NODE_ENV: 'test', RESEARCH_TEST_ALLOW_HOSTS: 'a.test, B.test' })]).toEqual(['a.test', 'b.test']);
    expect([...allowedTestHosts({ NODE_ENV: 'e2e', RESEARCH_TEST_ALLOW_HOSTS: 'a.test' })]).toEqual(['a.test']);
    expect(allowedTestHosts({ NODE_ENV: 'production', RESEARCH_TEST_ALLOW_HOSTS: 'a.test' }).size).toBe(0);
    expect(allowedTestHosts({ NODE_ENV: 'development', RESEARCH_TEST_ALLOW_HOSTS: 'a.test' }).size).toBe(0);
    expect(allowedTestHosts({ RESEARCH_TEST_ALLOW_HOSTS: 'a.test' }).size).toBe(0);
  });

  test('outside test/e2e the allow-listed fixture host is refused (it resolves to loopback)', async () => {
    const err = await failure(safeFetch(site.url('site.test'), {
      resolve, env: { NODE_ENV: 'production', RESEARCH_TEST_ALLOW_HOSTS: 'site.test' },
    }));
    expect(err.code).toBe('blocked_host');
    vi.stubEnv('NODE_ENV', 'production');
    const viaProcessEnv = await failure(safeFetch(site.url('site.test'), { resolve }));
    expect(viaProcessEnv.code).toBe('blocked_host');
  });

  test('a loopback IP literal not on the allow-list is refused', async () => {
    const err = await failure(safeFetch(`http://127.0.0.1:${site.port}/`, { resolve }));
    expect(err.code).toBe('blocked_host');
  });
});

describe('safeFetch', () => {
  test('fetches an allow-listed fixture page with the CRM user-agent', async () => {
    const res = await safeFetch(site.url('site.test'), { resolve });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Acme Widgets');
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.truncated).toBe(false);
    expect(site.userAgents.at(-1)).toBe(RESEARCH_USER_AGENT);
    expect(RESEARCH_USER_AGENT).toBe('DAIT-CRM-Research/1.0 (+https://crm.daitpartners.com)');
  });

  test('refuses non-http(s) schemes and URLs with credentials', async () => {
    for (const url of ['ftp://site.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://site.test/']) {
      expect((await failure(safeFetch(url, { resolve }))).code).toBe('bad_scheme');
    }
    expect((await failure(safeFetch(`http://user:pw@site.test:${site.port}/`, { resolve }))).code).toBe('bad_url');
    expect((await failure(safeFetch('not a url', { resolve }))).code).toBe('bad_url');
  });

  test('refuses a host whose DNS answer includes any private address', async () => {
    const r = fixtureResolver({
      'evil.test': ['127.0.0.1'],
      'mixed.test': ['93.184.216.34', '10.0.0.5'],
      'mapped.test': ['::ffff:127.0.0.1'],
      'linklocal6.test': ['fe80::1'],
    });
    for (const host of ['evil.test', 'mixed.test', 'mapped.test', 'linklocal6.test']) {
      expect((await failure(safeFetch(`http://${host}:${site.port}/`, { resolve: r }))).code).toBe('blocked_host');
    }
    expect(site.requests.some((x) => /^(evil|mixed|mapped|linklocal6)\.test/.test(x))).toBe(false);
  });

  test.each([
    ['127.0.0.1', (port: number) => `http://127.0.0.1:${port}/`],
    ['10.x', () => 'http://10.0.0.1/'],
    ['169.254.x', () => 'http://169.254.169.254/latest/meta-data/'],
    ['[::1]', (port: number) => `http://[::1]:${port}/`],
    ['decimal 127.0.0.1', (port: number) => `http://2130706433:${port}/`],
    ['a name resolving to loopback', (port: number) => `http://evil.test:${port}/`],
  ])('a redirect to %s is refused', async (_label, target) => {
    const r = fixtureResolver({ 'evil.test': ['127.0.0.1'] });
    const started = Date.now();
    const err = await failure(safeFetch(site.url('site.test', `/redirect?to=${encodeURIComponent(target(site.port))}`), { resolve: r }));
    expect(err.code).toBe('blocked_host');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a redirect to a non-http scheme is refused', async () => {
    const err = await failure(safeFetch(site.url('site.test', `/redirect?to=${encodeURIComponent('file:///etc/passwd')}`), { resolve }));
    expect(err.code).toBe('bad_scheme');
  });

  test(`follows up to ${MAX_REDIRECTS} redirects and no more`, async () => {
    const ok = await safeFetch(site.url('hop.test', `/hop/${MAX_REDIRECTS - 1}`), { resolve });
    expect(ok.status).toBe(200);
    expect(ok.url).toBe(site.url('hop.test', '/'));
    const err = await failure(safeFetch(site.url('hop.test', `/hop/${MAX_REDIRECTS}`), { resolve }));
    expect(err.code).toBe('too_many_redirects');
  });

  test('times out', async () => {
    const started = Date.now();
    const err = await failure(safeFetch(site.url('slow.test'), { resolve, timeoutMs: 300 }));
    expect(err.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a 2 MB page is cut off at the 1.5 MB limit', async () => {
    const res = await safeFetch(site.url('big.test'), { resolve });
    expect(PAGE_MAX_BYTES).toBe(1.5 * 1024 * 1024);
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    expect(res.body).toContain('A very big page.');
    await vi.waitFor(() => expect(site.bigBytesWritten()).toBeLessThan(BIG_PAGE_BYTES));
  });

  test('decompresses gzip responses', async () => {
    const res = await safeFetch(site.url('gzip.test'), { resolve });
    expect(res.body).toContain('Compressed page.');
  });

  test('connects to the address that was checked: DNS is asked once per hop (no rebinding window)', async () => {
    let calls = 0;
    const rebinding = async (host: string) => {
      calls += 1;
      // First answer is the checked one; a second lookup would get a private address.
      return calls === 1 ? resolve(host) : ['10.0.0.9'];
    };
    vi.stubEnv('RESEARCH_TEST_ALLOW_HOSTS', 'other.test');
    const res = await safeFetch(site.url('other.test'), { resolve: rebinding });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test('with an injected fetch every hop is still checked before it is requested', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    }) as typeof fetch;
    const err = await failure(safeFetch(site.url('site.test'), { resolve, fetchImpl }));
    expect(err.code).toBe('blocked_host');
    expect(seen).toEqual([site.url('site.test')]);
  });
});

describe('robots.txt', () => {
  test('parses groups, longest match wins, our agent group beats *', () => {
    const rules = parseRobots([
      'User-agent: *', 'Disallow: /private/', 'Allow: /private/press', 'Disallow: /*.pdf$', '',
      'User-agent: OtherBot', 'Disallow: /',
    ].join('\n'));
    expect(rules.allows('/')).toBe(true);
    expect(rules.allows('/about')).toBe(true);
    expect(rules.allows('/private/x')).toBe(false);
    expect(rules.allows('/private/press-kit')).toBe(true);
    expect(rules.allows('/files/brochure.pdf')).toBe(false);
    expect(rules.allows('/files/brochure.pdf?x=1')).toBe(true);
    const ours = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: dait-crm-research\nDisallow: /\n');
    expect(ours.allows('/')).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow:\n').allows('/anything')).toBe(true);
  });

  test('fetches robots.txt: rules apply, 404 allows everything', async () => {
    const acme = await fetchRobots(new URL(site.url('site.test')), { resolve });
    expect(acme.allows('/about-us')).toBe(true);
    expect(acme.allows('/private/company-history')).toBe(false);
    const none = await fetchRobots(new URL(site.url('other.test')), { resolve });
    expect(none.allows('/private/x')).toBe(true);
  });
});
