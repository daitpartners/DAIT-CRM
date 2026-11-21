const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * Lower-case registrable host for matching: strips scheme, `www.`, path, query and port.
 * From an email address it takes the part after `@`. Returns null when nothing host-like is left.
 */
export function domainOf(input: string | null | undefined): string | null {
  let v = input?.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^mailto:/, '').replace(SCHEME, '');
  v = v.split(/[/?#]/, 1)[0]!;
  const at = v.lastIndexOf('@');
  if (at >= 0) v = v.slice(at + 1);
  v = v.replace(/:\d*$/, '').replace(/\.$/, '').replace(/^www\./, '');
  return HOSTNAME.test(v) ? v : null;
}

/** Consumer mailbox providers: an address on one of these says nothing about the company. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'yahoo.in', 'ymail.com', 'rocketmail.com',
  'rediffmail.com', 'rediff.com',
  'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk', 'hotmail.co.in', 'live.com', 'live.in', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com',
  'zoho.com', 'zohomail.in', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
  'sify.com', 'in.com', 'indiatimes.com', 'fastmail.com', 'hey.com', 'tutanota.com',
]);

/**
 * Hosts shared by many unrelated businesses (social profiles, site builders, marketplaces,
 * directories): a website or email there says nothing about which company it is.
 */
export const SHARED_HOST_DOMAINS: ReadonlySet<string> = new Set([
  'facebook.com', 'fb.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'youtube.com',
  'tiktok.com', 'pinterest.com', 'sites.google.com', 'google.com', 'business.site', 'linktr.ee',
  'wa.me', 'whatsapp.com', 'justdial.com', 'indiamart.com', 'tradeindia.com', 'sulekha.com',
  'wixsite.com', 'weebly.com', 'blogspot.com', 'wordpress.com', 'medium.com', 'github.io',
  'notion.site', 'carrd.co', 'godaddysites.com', 'square.site', 'shopify.com', 'myshopify.com',
  'amazon.in', 'amazon.com', 'flipkart.com', 'etsy.com',
]);

/** True when `domain` equals a listed domain or is a subdomain of one (e.g. acme.wixsite.com). */
function inList(list: ReadonlySet<string>, domain: string): boolean {
  let d = domain.trim().toLowerCase();
  if (!d) return false;
  for (;;) {
    if (list.has(d)) return true;
    const dot = d.indexOf('.');
    if (dot < 0) return false;
    d = d.slice(dot + 1);
  }
}

/** True for consumer mailbox providers (and their subdomains), whose domain says nothing about the company. */
export function isFreeMail(domain: string): boolean {
  return inList(FREE_MAIL_DOMAINS, domain);
}

/** True for shared hosts (and their subdomains), whose domain says nothing about the company. */
export function isSharedHost(domain: string): boolean {
  return inList(SHARED_HOST_DOMAINS, domain);
}

const LEGAL_SUFFIX = /\b(pvt|private|ltd|limited|llc|inc|gmbh|plc|spa|sl|pty|co|corp|corporation|company|group)\b\.?/g;

/**
 * Company name key for duplicate matching: lower-case, legal suffixes removed, punctuation collapsed.
 * Can be '' (e.g. "Company Group Ltd"); callers must treat '' as no key.
 */
export function normaliseCompanyName(name: string): string {
  return name.toLowerCase().replace(LEGAL_SUFFIX, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Phone key for matching: the last 10 digits, so numbers with and without a country code
 * compare equal. '' when fewer than 8 digits (too short to match on).
 */
export function normalisePhone(input: string | null | undefined): string {
  const digits = (input ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-10) : '';
}
