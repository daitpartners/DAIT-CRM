import type { Prisma, PrismaClient } from '@prisma/client';
import { domainOf, isFreeMail, isSharedHost } from '@dait-crm/shared';

type Db = Prisma.TransactionClient | PrismaClient;

/** The firm's own mail domain(s): never a lead domain, and exact addresses there never count. */
export const OWN_MAIL_DOMAINS: readonly string[] = ['daitpartners.com'];

/**
 * What makes a message lead mail (web-mail release 1): any participant is one of `addresses` (a lead's or contact's
 * address), or its domain is one of `domains` (a lead company's own domain).
 */
export interface LeadMailRules {
  addresses: ReadonlySet<string>;
  domains: ReadonlySet<string>;
}

/** An address as compared everywhere in mail: trimmed and lower-cased ('' for none). */
export function normaliseAddress(address: string | null | undefined): string {
  return address?.trim().toLowerCase() ?? '';
}

/** True when `domain` equals one of `list` or is a subdomain of one. */
function inDomains(list: Iterable<string>, domain: string): boolean {
  for (const d of list) {
    const own = d.trim().toLowerCase();
    if (own && (domain === own || domain.endsWith(`.${own}`))) return true;
  }
  return false;
}

/**
 * True for a domain that never makes mail lead mail: free mail, shared hosts, `OWN_MAIL_DOMAINS` and `ownDomains`
 * (the connected mailboxes' own domains), subdomains included.
 */
export function isExcludedDomain(domain: string, ownDomains: Iterable<string>): boolean {
  const d = domain.trim().toLowerCase();
  return !d || isFreeMail(d) || isSharedHost(d) || inDomains(OWN_MAIL_DOMAINS, d) || inDomains(ownDomains, d);
}

/**
 * The rules from every lead (archived and closed included) and every contact: their addresses, and the own domains
 * of companies with at least one lead (company domain, its leads' and contacts' address domains). Four queries.
 */
export async function loadLeadMailRules(db: Db): Promise<LeadMailRules> {
  const [leads, contacts, companies, accounts] = await Promise.all([
    db.lead.findMany({ select: { businessEmail: true, companyId: true } }),
    db.contact.findMany({ where: { businessEmail: { not: null } }, select: { businessEmail: true, companyId: true } }),
    db.company.findMany({ where: { domain: { not: null }, leads: { some: {} } }, select: { domain: true } }),
    db.emailAccount.findMany({ select: { address: true, sendAs: true } }),
  ]);

  const mailboxDomains = new Set<string>();
  for (const a of accounts) {
    for (const address of [a.address, a.sendAs]) {
      const d = domainOf(address);
      if (d) mailboxDomains.add(d);
    }
  }
  const excluded = (domain: string | null): boolean => !domain || isExcludedDomain(domain, mailboxDomains);

  const leadCompanies = new Set<number>();
  const addresses = new Set<string>();
  const domains = new Set<string>();
  const addAddress = (raw: string | null, isLeadCompany: boolean) => {
    const address = normaliseAddress(raw);
    if (!address) return;
    const domain = domainOf(address);
    // An address at our own or a mailbox's domain (a test lead with a colleague's address) never counts (F18).
    if (domain && (inDomains(OWN_MAIL_DOMAINS, domain) || inDomains(mailboxDomains, domain))) return;
    addresses.add(address);
    if (isLeadCompany && !excluded(domain)) domains.add(domain!);
  };

  for (const l of leads) {
    if (l.companyId !== null) leadCompanies.add(l.companyId);
    addAddress(l.businessEmail, true);
  }
  for (const c of contacts) addAddress(c.businessEmail, leadCompanies.has(c.companyId));
  for (const c of companies) if (!excluded(c.domain)) domains.add(c.domain!);

  return { addresses, domains };
}

/** Every address on a message (From, To, Cc, Bcc): normalised, unique, empty dropped. */
export function participantsOf(m: { from: string | null; to: string[]; cc: string[]; bcc: string[] }): string[] {
  const all = [m.from, ...m.to, ...m.cc, ...m.bcc].map(normaliseAddress).filter(Boolean);
  return [...new Set(all)];
}

/** True when any participant is a lead/contact address or at a lead company's own domain. */
export function isLeadMail(rules: LeadMailRules, participants: string[]): boolean {
  return participants.some((p) => {
    const address = normaliseAddress(p);
    if (rules.addresses.has(address)) return true;
    const domain = domainOf(address);
    return domain !== null && rules.domains.has(domain);
  });
}

/** True when the user already keeps a lead-linked message in this conversation ("a conversation counts"). */
export async function inLeadConversation(db: Db, userId: number, threadId: string | null): Promise<boolean> {
  if (!threadId) return false;
  const row = await db.emailMessage.findFirst({
    where: { userId, threadId, leadId: { not: null } },
    select: { id: true },
  });
  return row !== null;
}
