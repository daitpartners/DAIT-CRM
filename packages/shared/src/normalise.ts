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
  // National ISPs' mailboxes (Spain, France, Latin America, and the other common ones).
  'orange.fr', 'wanadoo.fr', 'wanadoo.es', 'free.fr', 'sfr.fr', 'neuf.fr', 'laposte.net', 'club-internet.fr', 'bbox.fr',
  'numericable.fr', 'aliceadsl.fr', 'telefonica.net', 'movistar.es', 'ono.com', 'prodigy.net.mx', 'infinitummail.com',
  'uol.com.br', 'bol.com.br', 'ig.com.br', 'latinmail.com', 'cantv.net', 'arnet.com.ar', 'fibertel.com.ar',
  'speedy.com.ar', 'vtr.net', 'entelchile.net', 'une.net.co', 'etb.net.co',
  'bigpond.com', 'bigpond.net.au', 't-online.de', 'freenet.de', 'arcor.de', 'btinternet.com', 'sky.com',
  'virginmedia.com', 'talktalk.net', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'shaw.ca',
  'rogers.com', 'sympatico.ca', 'videotron.ca', 'inbox.ru', 'list.ru', 'bk.ru', 'rambler.ru', 'seznam.cz', 'wp.pl',
  'o2.pl', 'interia.pl', 'libero.it', 'virgilio.it', 'alice.it', 'tiscali.it', 'tin.it', 'aim.com', 'tutanota.de', 'tuta.io',
]);

/**
 * Mailbox providers whose every country domain is free mail (hotmail.es, yahoo.com.mx, outlook.fr …): the name followed
 * by a country or generic suffix of one or two labels.
 */
const FREE_MAIL_FAMILIES: ReadonlySet<string> = new Set([
  'hotmail', 'outlook', 'live', 'msn', 'windowslive', 'yahoo', 'ymail', 'rocketmail', 'gmail', 'googlemail', 'aol',
  'gmx', 'proton', 'protonmail', 'yandex', 'terra', 'icloud',
]);
const SUFFIX_WORDS: ReadonlySet<string> = new Set(['com', 'net', 'org', 'co']);
const isSuffixLabel = (label: string) => label.length <= 3 || SUFFIX_WORDS.has(label);

/** True when `domain` (or a parent of it) is a free-mail family name on a public suffix ("mail.hotmail.es"). */
function inFamily(domain: string): boolean {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const rest = labels.slice(i + 1);
    if (FREE_MAIL_FAMILIES.has(labels[i]!) && rest.length <= 2 && rest.every(isSuffixLabel)) return true;
  }
  return false;
}

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

/**
 * True for consumer mailbox providers (and their subdomains), whose domain says nothing about the company: the listed
 * domains, national ISPs, and every country domain of the big providers (hotmail.es, yahoo.com.mx, outlook.fr …).
 */
export function isFreeMail(domain: string): boolean {
  return inList(FREE_MAIL_DOMAINS, domain) || inFamily(domain.trim().toLowerCase());
}

/** True for shared hosts (and their subdomains), whose domain says nothing about the company. */
export function isSharedHost(domain: string): boolean {
  return inList(SHARED_HOST_DOMAINS, domain);
}

const LEGAL_SUFFIX = new RegExp(
  '\\b(pvt|private|ltd|limited|llc|llp|lp|inc|gmbh|ag|kg|plc|spa|sl|slu|sa|sau|sas|sasu|sarl|eurl|srl|bv|nv|ltda|lda|'
  + 'sapi|pty|co|corp|corporation|company|group)\\b\\.?', 'g',
);

/**
 * Company name key for duplicate matching: accents folded, lower-case, dotted initials joined ("S.A." → "sa"), legal
 * forms removed (Ltd, GmbH, S.L., S.A. de C.V., SARL, SAS, S.r.l., AG, B.V. …), punctuation collapsed.
 * Can be '' (e.g. "Company Group Ltd"); callers must treat '' as no key.
 * Migration 20 holds the same steps in SQL (`normalise_company_name`) to back-fill `companies.name_normalised`; a test
 * keeps the two equal, so change both together.
 */
export function normaliseCompanyName(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\b([a-z])\. (?=[a-z]\.)/g, '$1.')
    .replace(/\b([a-z])\.(?=[a-z]\.| |$)/g, '$1')
    .replace(/\bde (cv|rl)\b/g, ' ')
    .replace(LEGAL_SUFFIX, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Phone key for matching: the last 10 digits, so numbers with and without a country code
 * compare equal. '' when fewer than 8 digits (too short to match on).
 */
export function normalisePhone(input: string | null | undefined): string {
  const digits = (input ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-10) : '';
}
