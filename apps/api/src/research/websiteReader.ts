/**
 * The free website reader (release 4 AI research, provider 1). Reads the company's own public site — the home page
 * plus up to 3 same-site About / Contact / Company pages — and returns only what the site states about itself:
 *
 * - schema.org JSON-LD Organization / LocalBusiness: legal name, telephone, email, address, founding year, sameAs
 *   social links, description (confidence 90);
 * - meta description / og:description → description (75);
 * - same-domain mailto: → business email; LinkedIn / Facebook / Instagram / X / YouTube links (85);
 * - website technology from the generator meta tag, well-known markers and the Cloudflare header (inferred, 70).
 *
 * One finding per field (highest confidence, earliest page on a tie); every finding's source is the page URL.
 * The phone is returned on its own (no company phone column); the address country is not returned.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { domainOf } from '@dait-crm/shared';
import {
  PAGE_TIMEOUT_MS, SafeFetchError, fetchRobots, safeFetch, type ResolveFn, type RobotsRules, type SafeFetchErrorCode,
  type SafeFetchOptions, type SafeResponse,
} from './safeFetch.js';

export type Finding = {
  field: string;
  value: unknown;
  display?: string;
  confidence: number;
  sourceUrl: string;
  sourceLabel: string;
};

export type PageRead = {
  url: string;
  title: string;
  /** First 4,000 characters of visible text. */
  text: string;
  /** "Fields populated": the findings this page is the source of, plus 'phone' when the phone came from it. */
  fields: string[];
};

export type WebsiteRead = { findings: Finding[]; pages: PageRead[]; phone?: string; error?: string };

export interface ReadWebsiteOptions {
  fetchImpl?: typeof fetch;
  resolve?: ResolveFn;
  /** Per-page timeout; default 10 s. */
  timeoutMs?: number;
}

export const CONFIDENCE = { jsonLd: 90, meta: 75, link: 85, technology: 70 } as const;
const MAX_EXTRA_PAGES = 3;
const SNAPSHOT_CHARS = 4000;
const DESCRIPTION_MAX = 5000;
const TEXT_MAX = 300;
const EMAIL_MAX = 254;
/** Before decoding and stripping "?subject=…": a mailto href longer than this is not an address worth reading. */
const EMAIL_INPUT_MAX = 2048;
/** Raw text taken before whitespace is collapsed (the snapshot keeps 4,000 characters). */
const TEXT_SCAN_MAX = 20_000;

const ERRORS: Record<SafeFetchErrorCode, string> = {
  timeout: 'Timeout fetching site',
  blocked_host: 'Website is not on a public address',
  bad_scheme: 'Website address must start with http:// or https://',
  bad_url: 'Website address is not valid',
  too_many_redirects: 'Too many redirects',
  network: 'Could not reach site',
};
const ROBOTS_BLOCKED = 'Blocked by robots.txt';

// ---------------------------------------------------------------------------------------------------------------
// Extraction

type Candidate = { field: string; value: unknown; confidence: number };

const ORG_TYPES = new Set(['Organization', 'LocalBusiness', 'Corporation', 'ProfessionalService', 'OnlineBusiness', 'NGO']);

function isOrgType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string'
    && (ORG_TYPES.has(t.replace(/^(https?:\/\/schema\.org\/|schema:)/, '')) || /(Business|Organization)$/.test(t)));
}

function text(v: unknown, max = TEXT_MAX): string | null {
  if (Array.isArray(v)) return text(v[0], max);
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s && s.length <= max ? s : null;
}

function jsonLdNodes(root: HTMLElement): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    nodes.push(o);
    if (o['@graph']) visit(o['@graph']);
  };
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(script.rawText.trim().replace(/^<!--|-->$/g, '').replace(/^\/\/<!\[CDATA\[|\/\/\]\]>$/g, '')));
    } catch {
      // malformed JSON-LD says nothing
    }
  }
  return nodes;
}

function year(v: unknown): number | null {
  const m = (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '').trim().match(/^(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1800 && y <= new Date().getFullYear() ? y : null;
}

/** An address on the site's own domain (or a subdomain of it). */
function sameDomainEmail(raw: unknown, siteDomain: string | null): string | null {
  if (typeof raw !== 'string' || !siteDomain) return null;
  let v = raw.trim().replace(/^mailto:/i, '');
  // RFC 5321 caps an address at 254 characters; checking length first keeps every step below cheap.
  if (v.length > EMAIL_INPUT_MAX) return null;
  try { v = decodeURIComponent(v); } catch { /* keep as is */ }
  v = v.split('?')[0]!.split(',')[0]!.trim();
  if (v.length > EMAIL_MAX || /[\s<>()]/.test(v)) return null;
  const parts = v.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  const dot = domain.lastIndexOf('.');
  if (!local || dot <= 0 || dot === domain.length - 1) return null;
  const d = domainOf(v);
  return d && (d === siteDomain || d.endsWith('.' + siteDomain)) ? v : null;
}

const SOCIAL_SKIP = /^\/(sharer|share|intent|dialog|plugins|embed|watch|hashtag|search|login|home|p|reel|reels|stories|tr)(\/|\.php|$)/i;

/** The research field a social profile link belongs to, or null (share buttons, posts, personal pages). */
function socialField(href: string): string | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  if (!path || SOCIAL_SKIP.test(u.pathname)) return null;
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    return /^\/(company|school|showcase)\/[^/]+/.test(path) ? 'linkedinUrl' : null;
  }
  if (host === 'facebook.com' || host === 'fb.com') return 'socialFacebook';
  if (host === 'instagram.com') return 'socialInstagram';
  if (host === 'x.com' || host === 'twitter.com') return 'socialX';
  if (host === 'youtube.com') return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(path) ? 'socialYoutube' : null;
  return null;
}

const TECH_MARKERS: { name: string; generator: RegExp; html?: RegExp }[] = [
  { name: 'WordPress', generator: /wordpress/i, html: /\/wp-(content|includes)\//i },
  { name: 'Shopify', generator: /shopify/i, html: /cdn\.shopify\.com|Shopify\.theme/ },
  { name: 'Wix', generator: /wix\.com/i, html: /static\.wixstatic\.com|static\.parastorage\.com/i },
  { name: 'Squarespace', generator: /squarespace/i, html: /static1?\.squarespace\.com/i },
  { name: 'Webflow', generator: /webflow/i, html: /data-wf-(page|site)=/i },
  { name: 'Drupal', generator: /drupal/i, html: /\/sites\/default\/files\/|drupal-settings-json/i },
  { name: 'Joomla', generator: /joomla/i, html: /\/media\/jui\//i },
  { name: 'HubSpot', generator: /hubspot/i, html: /js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics/i },
];

function technologies(root: HTMLElement, html: string, headers: Record<string, string>): string[] {
  const generator = root.querySelectorAll('meta[name="generator" i]').map((m) => m.getAttribute('content') ?? '').join(' ');
  const found = TECH_MARKERS.filter((t) => t.generator.test(generator) || (t.html?.test(html) ?? false)).map((t) => t.name);
  if (/cloudflare/i.test(headers.server ?? '') || headers['cf-ray']) found.push('Cloudflare');
  return found;
}

function metaContent(root: HTMLElement, selector: string): string | null {
  for (const m of root.querySelectorAll(selector)) {
    const v = text(m.getAttribute('content'), DESCRIPTION_MAX);
    if (v) return v;
  }
  return null;
}

function visibleText(root: HTMLElement): string {
  const body = root.querySelector('body') ?? root;
  for (const el of body.querySelectorAll('script, style, noscript, template, svg, iframe')) el.remove();
  return body.structuredText.slice(0, TEXT_SCAN_MAX)
    .split('\n')
    .map((line) => line.replace(/[\s\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, SNAPSHOT_CHARS);
}

interface Extracted {
  title: string;
  text: string;
  candidates: Candidate[];
  phone?: string;
  links: { url: URL; label: string }[];
}

function extract(page: SafeResponse, siteDomain: string | null): Extracted {
  const html = page.body;
  const root = parse(html);
  const candidates: Candidate[] = [];
  const add = (field: string, value: unknown, confidence: number) => {
    if (value !== null && value !== undefined && value !== '') candidates.push({ field, value, confidence });
  };
  let phone: string | undefined;

  for (const node of jsonLdNodes(root).filter((n) => isOrgType(n['@type']))) {
    add('legalName', text(node.legalName), CONFIDENCE.jsonLd);
    add('description', text(node.description, DESCRIPTION_MAX), CONFIDENCE.jsonLd);
    add('businessEmail', sameDomainEmail(text(node.email), siteDomain), CONFIDENCE.jsonLd);
    add('yearEstablished', year(node.foundingDate), CONFIDENCE.jsonLd);
    phone ??= text(node.telephone) ?? undefined;
    const address = Array.isArray(node.address) ? node.address[0] : node.address;
    if (address && typeof address === 'object') {
      const a = address as Record<string, unknown>;
      add('street', text(a.streetAddress), CONFIDENCE.jsonLd);
      add('city', text(a.addressLocality), CONFIDENCE.jsonLd);
      add('state', text(a.addressRegion), CONFIDENCE.jsonLd);
      add('zip', text(a.postalCode), CONFIDENCE.jsonLd);
    }
    const sameAs = Array.isArray(node.sameAs) ? node.sameAs : [node.sameAs];
    for (const href of sameAs) {
      const field = typeof href === 'string' ? socialField(href.trim()) : null;
      if (field) add(field, href.trim(), CONFIDENCE.jsonLd);
    }
  }

  add('description', metaContent(root, 'meta[name="description" i]') ?? metaContent(root, 'meta[property="og:description" i]'),
    CONFIDENCE.meta);

  const links: { url: URL; label: string }[] = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (/^mailto:/i.test(href)) {
      add('businessEmail', sameDomainEmail(href, siteDomain), CONFIDENCE.link);
      continue;
    }
    let url: URL;
    try { url = new URL(href, page.url); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const field = socialField(url.href);
    if (field) add(field, url.href, CONFIDENCE.link);
    links.push({ url, label: a.text.replace(/\s+/g, ' ').trim() });
  }

  const tech = technologies(root, html, page.headers);
  if (tech.length) add('websiteTechnology', tech.join(', '), CONFIDENCE.technology);

  const title = text(root.querySelector('title')?.text) ?? metaContent(root, 'meta[property="og:title" i]') ?? page.url;
  return { title, text: visibleText(root), candidates, phone, links };
}

// ---------------------------------------------------------------------------------------------------------------
// Pages

const PAGE_HINT = /\b(about|contact|company|nosotros|contacto|empresa|qui[eé]nes|[aà][ -]propos|qui[- ]sommes|soci[eé]t[eé])\b/i;
const LABEL_MAX = 30;
const URL_INPUT_MAX = 2048;
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3)$/i;

function siteHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** Pages are told apart by path: "/contact" and "/contact?ref=nav#form" are the same page. */
function pageKey(url: URL): string {
  return url.origin + (url.pathname.replace(/\/+$/, '') || '/');
}

/** Up to 3 same-site links whose text or path looks like About / Contact / Company, in page order. */
function extraPages(links: { url: URL; label: string }[], home: URL): URL[] {
  const seen = new Set([pageKey(home)]);
  const out: URL[] = [];
  for (const { url, label } of links) {
    if (out.length >= MAX_EXTRA_PAGES) break;
    if (siteHost(url) !== siteHost(home) || FILE_EXT.test(url.pathname)) continue;
    const key = pageKey(url);
    if (seen.has(key)) continue;
    // A short link label (navigation, not a sentence that mentions a company), or the last path segment.
    const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
    const byLabel = label.length <= LABEL_MAX && PAGE_HINT.test(label);
    if (!byLabel && !PAGE_HINT.test(lastSegment.replace(/[-_.]+/g, ' '))) continue;
    seen.add(key);
    const page = new URL(url.href);
    page.hash = '';
    out.push(page);
  }
  return out;
}

function sourceLabel(url: URL): string {
  return siteHost(url) + url.pathname.replace(/\/+$/, '');
}

function isHtml(res: SafeResponse): boolean {
  const type = (res.headers['content-type'] ?? '').toLowerCase();
  return !type || type.includes('text/html') || type.includes('application/xhtml');
}

function startUrl(input: string): string {
  const v = input.trim();
  if (v.length > URL_INPUT_MAX) throw new TypeError('Website address too long');
  // "example.com" or "example.com/about" → https://; anything with its own scheme is left for safeFetch to judge.
  return /^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[^:/]*\.[^:/]*:\d/.test(v) ? v : 'https://' + v;
}

function errorMessage(err: unknown): string {
  return err instanceof SafeFetchError ? ERRORS[err.code] : ERRORS.network;
}

export async function readWebsite(url: string, opts: ReadWebsiteOptions = {}): Promise<WebsiteRead> {
  const fetchOpts: SafeFetchOptions = {
    resolve: opts.resolve, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? PAGE_TIMEOUT_MS,
  };
  const robotsByOrigin = new Map<string, RobotsRules>();
  const robotsAllow = async (u: URL) => {
    let rules = robotsByOrigin.get(u.origin);
    if (!rules) {
      rules = await fetchRobots(u, fetchOpts);
      robotsByOrigin.set(u.origin, rules);
    }
    return rules.allows(u.pathname + u.search);
  };
  const fail = (error: string): WebsiteRead => ({ findings: [], pages: [], error });

  let home: SafeResponse;
  let homeUrl: URL;
  try {
    const start = new URL(startUrl(url));
    if (start.protocol !== 'http:' && start.protocol !== 'https:') return fail(ERRORS.bad_scheme);
    if (!(await robotsAllow(start))) return fail(ROBOTS_BLOCKED);
    home = await safeFetch(start.href, fetchOpts);
    homeUrl = new URL(home.url);
    if (homeUrl.origin !== start.origin && !(await robotsAllow(homeUrl))) return fail(ROBOTS_BLOCKED);
  } catch (err) {
    return fail(err instanceof TypeError ? ERRORS.bad_url : errorMessage(err));
  }
  if (home.status < 200 || home.status >= 300) return fail(`Site returned HTTP ${home.status}`);
  if (!isHtml(home)) return fail('Site did not return a web page');

  const siteDomain = domainOf(homeUrl.hostname);
  const read: { url: URL; extracted: Extracted }[] = [{ url: homeUrl, extracted: extract(home, siteDomain) }];
  for (const next of extraPages(read[0]!.extracted.links, homeUrl)) {
    try {
      if (!(await robotsAllow(next))) continue;
      const res = await safeFetch(next.href, fetchOpts);
      const finalUrl = new URL(res.url);
      if (res.status < 200 || res.status >= 300 || !isHtml(res) || siteHost(finalUrl) !== siteHost(homeUrl)) continue;
      if (read.some((r) => pageKey(r.url) === pageKey(finalUrl))) continue;
      if (finalUrl.origin !== homeUrl.origin && !(await robotsAllow(finalUrl))) continue;
      read.push({ url: finalUrl, extracted: extract(res, siteDomain) });
    } catch {
      // an extra page that can't be read is skipped
    }
  }

  const best = new Map<string, Finding>();
  let phone: { value: string; page: string } | undefined;
  for (const { url: pageUrl, extracted } of read) {
    for (const c of extracted.candidates) {
      const current = best.get(c.field);
      if (!current || c.confidence > current.confidence) {
        best.set(c.field, {
          field: c.field, value: c.value, confidence: c.confidence, sourceUrl: pageUrl.href, sourceLabel: sourceLabel(pageUrl),
        });
      }
    }
    if (extracted.phone && !phone) phone = { value: extracted.phone, page: pageUrl.href };
  }
  // "Fields populated" per page: the findings it is the source of, plus the phone.
  const pages: PageRead[] = read.map(({ url: pageUrl, extracted }) => ({
    url: pageUrl.href,
    title: extracted.title,
    text: extracted.text,
    fields: [
      ...[...best.values()].filter((f) => f.sourceUrl === pageUrl.href).map((f) => f.field),
      ...(phone?.page === pageUrl.href ? ['phone'] : []),
    ],
  }));
  return { findings: [...best.values()], pages, ...(phone ? { phone: phone.value } : {}) };
}
