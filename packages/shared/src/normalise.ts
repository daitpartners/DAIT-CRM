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

export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com',
]);

/** True for consumer mailbox providers, whose domain says nothing about the company. */
export function isFreeMail(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase());
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
