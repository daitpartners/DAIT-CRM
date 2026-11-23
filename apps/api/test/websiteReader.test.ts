import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { RESEARCH_FIELDS } from '@dait-crm/shared';
import { readWebsite, type Finding } from '../src/research/websiteReader';
import { FIXTURE_HOSTS, fixtureResolver, startFixtureServer, type FixtureServer } from './fixtureSites';

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
  site.requests.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const byField = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.field, f]));

describe('readWebsite · organisation page with JSON-LD', () => {
  test('reads the facts the site states, with confidence and the page as source', async () => {
    const home = site.url('site.test');
    const about = site.url('site.test', '/about-us');
    const contact = site.url('site.test', '/contact');
    const res = await readWebsite(home, { resolve });
    expect(res.error).toBeUndefined();
    const f = byField(res.findings);

    expect(f.legalName).toMatchObject({ value: 'Acme Widgets Ltd', confidence: 90, sourceUrl: home });
    expect(f.description).toMatchObject({
      value: 'Acme Widgets makes precision industrial widgets for packaging lines.', confidence: 90, sourceUrl: home,
    });
    expect(f.street).toMatchObject({ value: '12 Foundry Lane', confidence: 90, sourceUrl: home });
    expect(f.city).toMatchObject({ value: 'Sheffield', confidence: 90 });
    expect(f.state).toMatchObject({ value: 'South Yorkshire', confidence: 90 });
    expect(f.zip).toMatchObject({ value: 'S1 2AB', confidence: 90 });
    expect(f.yearEstablished).toMatchObject({ value: 1987, confidence: 90, sourceUrl: home });
    expect(f.businessEmail).toMatchObject({ value: 'hello@site.test', confidence: 90, sourceUrl: home });
    expect(f.linkedinUrl).toMatchObject({ value: 'https://www.linkedin.com/company/acme-widgets', confidence: 90 });
    expect(f.socialFacebook).toMatchObject({ value: 'https://www.facebook.com/acmewidgets', confidence: 90 });
    expect(f.socialX).toMatchObject({ value: 'https://x.com/acmewidgets', confidence: 90 });
    // From links on the pages read: 85, source = the page the link is on.
    expect(f.socialInstagram).toMatchObject({ value: 'https://www.instagram.com/acmewidgets/', confidence: 85, sourceUrl: home });
    expect(f.socialYoutube).toMatchObject({ value: 'https://www.youtube.com/@acmewidgets', confidence: 85, sourceUrl: about });
    expect(f.websiteTechnology).toMatchObject({ value: 'WordPress', confidence: 70, sourceUrl: home });
    expect(res.phone).toBe('+44 20 7946 0000');

    // Country is not a finding; phone is returned separately; every finding is a known research field.
    expect(f.country).toBeUndefined();
    expect(f.phone).toBeUndefined();
    const known = new Set<string>(RESEARCH_FIELDS.map((x) => x.field));
    for (const x of res.findings) {
      expect(known.has(x.field)).toBe(true);
      expect(x.sourceUrl).toMatch(/^http:\/\/site\.test:\d+\//);
      expect(x.sourceLabel).toBeTruthy();
    }
    expect(res.findings.filter((x) => x.field === 'linkedinUrl')).toHaveLength(1);

    // Pages: home first, then the About and Contact links; snapshot is visible text only.
    expect(res.pages.map((p) => p.url)).toEqual([home, about, contact]);
    expect(res.pages[0]).toMatchObject({ title: 'Acme Widgets | Industrial widgets since 1987' });
    expect(res.pages[0]!.text).toContain('We build widgets & parts for packaging lines across Europe.');
    expect(res.pages[0]!.text).not.toContain('script text must not appear');
    expect(res.pages[0]!.text).not.toContain('font-family');
    expect(res.pages[0]!.fields).toEqual(expect.arrayContaining(['legalName', 'phone', 'street', 'socialInstagram']));
    expect(res.pages[1]!.fields).toEqual(['socialYoutube']);
    expect(res.pages[2]!.fields).toEqual([]); // its mailto (85) loses to the JSON-LD email (90)
  });

  test('a business email from another domain is ignored; a same-domain mailto is read', async () => {
    const res = await readWebsite(site.url('meta.test'), { resolve });
    const f = byField(res.findings);
    expect(f.businessEmail).toMatchObject({ value: 'team@meta.test', confidence: 85 });
    const acme = await readWebsite(site.url('site.test'), { resolve });
    expect(acme.findings.map((x) => x.value)).not.toContain('sales@gmail.com');
  });

  test('follows same-site About/Contact links only, never external links, and respects robots.txt', async () => {
    await readWebsite(site.url('site.test'), { resolve });
    expect(site.requests).toEqual([
      'site.test /robots.txt', 'site.test /', 'site.test /about-us', 'site.test /contact',
    ]);
    expect(site.requests.some((r) => r.startsWith('other.test'))).toBe(false);
    expect(site.requests).not.toContain('site.test /private/company-history');
    expect(site.requests).not.toContain('site.test /blog');
    // Not a second visit to /contact?ref=nav; not /about-us/privacy; not a long sentence that mentions "company".
    expect(site.requests).not.toContain('site.test /about-us/privacy');
    expect(site.requests).not.toContain('site.test /news/award');
  });

  test('a site whose robots.txt disallows our agent is not read', async () => {
    const res = await readWebsite(site.url('blocked.test'), { resolve });
    expect(res).toMatchObject({ findings: [], pages: [], error: 'Blocked by robots.txt' });
    expect(site.requests).toEqual(['blocked.test /robots.txt']);
  });
});

describe('readWebsite · other pages', () => {
  test('meta-only page → description at 75, technology from markers and the Cloudflare header', async () => {
    const res = await readWebsite(site.url('meta.test'), { resolve });
    const f = byField(res.findings);
    expect(f.description).toMatchObject({
      value: 'Meta Only Co designs ergonomic office furniture.', confidence: 75, sourceUrl: site.url('meta.test'),
    });
    expect(f.websiteTechnology).toMatchObject({ value: 'Shopify, Cloudflare', confidence: 70 });
    expect(res.phone).toBeUndefined();
    expect(f.legalName).toBeUndefined();
  });

  test('a 2 MB page is cut at 1.5 MB and what was read is still used', async () => {
    const res = await readWebsite(site.url('big.test'), { resolve });
    expect(res.error).toBeUndefined();
    expect(byField(res.findings).description).toMatchObject({ value: 'A very big page.', confidence: 75 });
    expect(res.pages[0]!.text.length).toBeLessThanOrEqual(4000);
  });

  test('a 1M-character mailto is skipped quickly and the real address is still read', async () => {
    const started = Date.now();
    const res = await readWebsite(site.url('mailto.test'), { resolve });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(byField(res.findings).businessEmail).toMatchObject({ value: 'office@mailto.test', confidence: 85 });
  });

  test('timeout → "Timeout fetching site"', async () => {
    const res = await readWebsite(site.url('slow.test'), { resolve, timeoutMs: 300 });
    expect(res).toEqual({ findings: [], pages: [], error: 'Timeout fetching site' });
  });

  test('a redirect to a private address is refused', async () => {
    for (const to of [`http://127.0.0.1:${site.port}/`, 'http://10.1.2.3/', 'http://169.254.169.254/']) {
      const res = await readWebsite(site.url('hop.test', `/redirect?to=${encodeURIComponent(to)}`), { resolve });
      expect(res).toEqual({ findings: [], pages: [], error: 'Website is not on a public address' });
    }
  });

  test('non-http schemes are refused; a bare domain is read as https', async () => {
    for (const url of ['ftp://site.test/', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const res = await readWebsite(url, { resolve });
      expect(res).toEqual({ findings: [], pages: [], error: 'Website address must start with http:// or https://' });
    }
    // https://nowhere.invalid fails at DNS (no network): proves the scheme was added rather than refused.
    const bare = await readWebsite('nowhere.invalid', { resolve });
    expect(bare.error).toBe('Could not reach site');
  });
});
