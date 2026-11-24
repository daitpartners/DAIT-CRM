/**
 * The one company-matching rule of Import leads (staging, the step-4 plan and the import itself): a row is the same
 * company as another, or as a company in the CRM, by website / business email domain, else by normalised name in the
 * same country. Not `findCompanyMatches`: that one sends name hits to a person's review; an import decides on its own.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { checkDomain, isFreeMail, normaliseCompanyName, type RowFields } from '@dait-crm/shared';

export type Db = Prisma.TransactionClient | PrismaClient;
export type CompanyRef = { id: number; number: string };

const lower = (s: string | undefined): string => (s ?? '').trim().toLowerCase();
/**
 * The row's company domain: website, else a business email. A free-mail domain is never one, not even as a website
 * ("hotmail.es"), so it never groups rows and never meets a CRM company that was given one by mistake.
 */
function domainKey(f: RowFields): string | null {
  const domain = checkDomain({ website: f.website, businessEmail: f.email });
  if (domain && !isFreeMail(domain)) return domain;
  if (!domain) return null;
  // The website was free mail: the business email may still name the company.
  const fromEmail = checkDomain({ businessEmail: f.email });
  return fromEmail && !isFreeMail(fromEmail) ? fromEmail : null;
}

/**
 * The key that makes two rows one company: `d:<domain>` (website, else a business email that is not free mail), else
 * `n:<normalised name>|<country, lower case>`; null when the row has neither a domain nor a usable name.
 */
export function companyKeyOf(fields: RowFields): string | null {
  const domain = domainKey(fields);
  if (domain) return `d:${domain}`;
  const name = normaliseCompanyName(fields.companyName ?? '');
  return name ? `n:${name}|${lower(fields.country)}` : null;
}

/**
 * The CRM company each item is, in the list's order (null = none). Two queries: by domain, then by normalised name;
 * a name counts in the item's country (ignoring case) or, when the item has no country, only when exactly one
 * company has that name. A domain hit wins over a name hit.
 */
export async function findExistingCompanies(db: Db, list: RowFields[]): Promise<(CompanyRef | null)[]> {
  const domains = list.map(domainKey);
  const names = list.map((f) => normaliseCompanyName(f.companyName ?? ''));
  const wantedDomains = [...new Set(domains.filter((d): d is string => d !== null))];
  const byDomain = new Map<string, CompanyRef>();
  if (wantedDomains.length > 0) {
    const hits = await db.company.findMany({ where: { domain: { in: wantedDomains } }, select: { id: true, number: true, domain: true } });
    for (const c of hits) byDomain.set(c.domain!, { id: c.id, number: c.number });
  }
  const wantedNames = [...new Set(list.map((_, i) => (domains[i] && byDomain.has(domains[i]!) ? '' : names[i]!)).filter((n) => n !== ''))];
  const byName = new Map<string, { id: number; number: string; country: string }[]>();
  if (wantedNames.length > 0) {
    const hits = await db.company.findMany({
      where: { nameNormalised: { in: wantedNames } },
      select: { id: true, number: true, nameNormalised: true, country: true },
      orderBy: { id: 'asc' },
    });
    for (const c of hits) {
      const same = byName.get(c.nameNormalised) ?? [];
      same.push({ id: c.id, number: c.number, country: c.country });
      byName.set(c.nameNormalised, same);
    }
  }
  return list.map((f, i) => {
    const domain = domains[i];
    if (domain && byDomain.has(domain)) return byDomain.get(domain)!;
    const same = names[i] ? byName.get(names[i]!) ?? [] : [];
    const country = lower(f.country);
    const hit = country ? same.find((c) => lower(c.country) === country) : same.length === 1 ? same[0] : undefined;
    return hit ? { id: hit.id, number: hit.number } : null;
  });
}
