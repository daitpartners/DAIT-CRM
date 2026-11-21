import { domainOf, isFreeMail, isSharedHost, normaliseCompanyName, normalisePhone } from './normalise.js';
import type { DuplicateCheck } from './schemas/company.js';
import type { ContactDuplicateCheck } from './schemas/contact.js';

export type CompanyMatchHow = 'domain' | 'legal_name' | 'name_country';
export type CompanyCandidate = {
  id: number; number: string; name: string; legalName: string | null;
  domain: string | null; country: string | null; city: string | null;
};
export type CompanyMatches = {
  auto: CompanyCandidate | null;
  review: { candidate: CompanyCandidate; how: CompanyMatchHow }[];
};

export type ContactMatchHow = 'email' | 'phone' | 'name_company';
export type ContactCandidate = {
  id: number; companyId: number; firstName: string; lastName: string;
  businessEmail: string | null; phoneNormalised: string | null; mobileNormalised: string | null;
};
export type ContactMatches = {
  auto: ContactCandidate | null;
  review: { candidate: ContactCandidate; how: ContactMatchHow }[];
};

/** Lower-cased, trimmed text; '' for blank or missing (callers treat '' as no key). */
const key = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/**
 * Domain key for a duplicate check: the website's domain unless it is a shared host, else the
 * business email's unless it is free-mail or a shared host.
 */
export function checkDomain(input: Pick<DuplicateCheck, 'website' | 'businessEmail'>): string | null {
  const fromWebsite = domainOf(input.website);
  if (fromWebsite && !isSharedHost(fromWebsite)) return fromWebsite;
  const fromEmail = domainOf(input.businessEmail);
  return fromEmail && !isFreeMail(fromEmail) && !isSharedHost(fromEmail) ? fromEmail : null;
}

/** Builds the result: first `auto` hit wins, review entries keep rule order and each id appears once. */
function rank<C extends { id: number }, H extends string>(
  candidates: C[], excludeId: number | undefined, autoRule: (c: C) => boolean, reviewRules: [H, (c: C) => boolean][],
): { auto: C | null; review: { candidate: C; how: H }[] } {
  const pool = candidates.filter((c) => c.id !== excludeId);
  const auto = pool.find(autoRule) ?? null;
  const seen = new Set<number>(auto ? [auto.id] : []);
  const review: { candidate: C; how: H }[] = [];
  for (const [how, rule] of reviewRules) {
    for (const candidate of pool) {
      if (seen.has(candidate.id) || !rule(candidate)) continue;
      seen.add(candidate.id);
      review.push({ candidate, how });
    }
  }
  return { auto, review };
}

/**
 * Ranks possible duplicate companies. `auto` only on an exact domain hit; legal-name and
 * name+country hits go to `review`, in that order, de-duplicated by id.
 */
export function rankCompanyMatches(input: DuplicateCheck, candidates: CompanyCandidate[]): CompanyMatches {
  const domain = checkDomain(input);
  const legal = key(input.legalName);
  const name = normaliseCompanyName(input.name ?? '');
  const country = key(input.country);
  return rank<CompanyCandidate, CompanyMatchHow>(
    candidates, input.excludeId,
    (c) => !!domain && c.domain === domain,
    [
      ['legal_name', (c) => !!legal && key(c.legalName) === legal],
      ['name_country', (c) => !!name && !!country && normaliseCompanyName(c.name) === name && key(c.country) === country],
    ],
  );
}

/** Non-empty, distinct phone keys of a contact duplicate check (its phone and its mobile). */
export function contactPhoneKeys(input: Pick<ContactDuplicateCheck, 'phone' | 'mobile'>): string[] {
  return [...new Set([normalisePhone(input.phone), normalisePhone(input.mobile)].filter((p) => p !== ''))];
}

/**
 * Ranks possible duplicate contacts. `auto` only on an exact business email; phone (either input
 * phone or mobile against stored phone or mobile) and first name [+ last name] within the same company go to `review`.
 */
export function rankContactMatches(input: ContactDuplicateCheck, candidates: ContactCandidate[]): ContactMatches {
  const email = key(input.businessEmail);
  const phones = contactPhoneKeys(input);
  const first = key(input.firstName);
  const last = key(input.lastName);
  return rank<ContactCandidate, ContactMatchHow>(
    candidates, input.excludeId,
    (c) => !!email && key(c.businessEmail) === email,
    [
      ['phone', (c) => phones.some((p) => c.phoneNormalised === p || c.mobileNormalised === p)],
      ['name_company', (c) => !!first && input.companyId !== undefined && c.companyId === input.companyId
        && key(c.firstName) === first && (!last || key(c.lastName) === last)],
    ],
  );
}
