/**
 * Import leads, PDF / Word / text documents: the deterministic reader (used when Claude is off, out of runs, or a call
 * fails) and the check every Claude value must pass, that it is written in the document's own text.
 *
 * A document is split into blocks: groups of lines separated by blank lines, within a page. A Word file's text has a
 * blank line after every paragraph, so there a block ends at two or more blank lines (an empty paragraph). Each block
 * of a Word file is a card (numbered from 1), each block of a text file is known by its first line number.
 */
import { domainOf, isFreeMail, type ImportField, type RowFields } from '@dait-crm/shared';
import { squash } from './columns.js';
import { matchCountry } from './countries.js';
import type { TextExtract } from './read/index.js';

export type OriginKind = TextExtract['unit'];
export type DraftRow = { fields: RowFields; originKind: OriginKind; originN: number };
/** A block: its origin (page n, card n or first line n) and its lines (non-blank, trimmed) with their line numbers. */
export type Block = { kind: OriginKind; n: number; lines: { n: number; text: string }[] };

/** Longest value a staged cell keeps (the row edit's limit). */
export const MAX_VALUE = 500;

/** The document's blocks, in order. */
export function documentBlocks(extract: TextExtract): Block[] {
  const blocks: Block[] = [];
  let card = 0;
  for (const page of extract.pages) {
    const lines = page.text.replace(/\u0000/g, '').split('\n').map((t, i) => ({ n: i + 1, text: t.trim() }));
    // Paragraph-style text (no two non-blank lines in a row, as a Word file's): one blank line is a paragraph break.
    const paragraphs = !lines.some((l, i) => i > 0 && l.text !== '' && lines[i - 1]!.text !== '');
    const gap = paragraphs ? 2 : 1;
    let current: Block['lines'] = [];
    let blank = 0;
    const flush = () => {
      if (current.length === 0) return;
      const n = extract.unit === 'page' ? page.n : extract.unit === 'card' ? (card += 1) : current[0]!.n;
      blocks.push({ kind: extract.unit, n, lines: current });
      current = [];
    };
    for (const line of lines) {
      if (line.text === '') {
        blank += 1;
        continue;
      }
      if (blank >= gap) flush();
      blank = 0;
      current.push(line);
    }
    flush();
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// Values in a block

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()·•|,;]+/gi;
/** A bare domain: labels and a 2–24 letter top-level domain, not inside a word, an email or a longer name. */
const DOMAIN_RE = /(?<![\p{L}\p{N}@._-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])(?:\/[^\s<>"'·•|,;]*)?/giu;
/** File names are not websites. */
const FILE_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'zip']);
const PHONE_RE = /(?:\+\s?)?\(?\d[\d \t().\-/]{5,}\d/g;
const DATE_RE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;
const TRAILING = /[.,;:)\]]+$/;

const LEGAL_SUFFIX = new RegExp(
  `(?:^|[\\s,(])(?:${[
    'S\\.A\\. de C\\.V\\.', 'Ltd\\.?', 'LTD\\.?', 'Limited', 'LIMITED', 'LLC', 'L\\.L\\.C\\.', 'Inc\\.?', 'INC\\.?', 'Corp\\.?', 'CORP\\.?',
    'GmbH', 'AG', 'SA', 'S\\.A\\.', 'SL', 'S\\.L\\.', 'SAS', 'SARL', 'SRL', 'BV', 'B\\.V\\.', 'NV', 'N\\.V\\.', 'Pvt\\.?', 'PVT\\.?',
    'Pty\\.?', 'PTY\\.?', 'PLC', 'Plc', 'LLP', 'Co\\.',
  ].join('|')})(?=$|[\\s,)])`,
  'u',
);
const TITLE_WORD = new RegExp(
  `(?<![\\p{L}])(?:${[
    'CEO', 'CFO', 'CTO', 'COO', 'Founder', 'Co-Founder', 'Owner', 'Director', 'Directora', 'Manager', 'Head', 'President',
    'Partner', 'Gerente', 'Jefe', 'Jefa', 'Responsable', 'Directeur', 'Directrice', 'Chef', 'Président', 'Presidente',
  ].join('|')})(?![\\p{L}])`,
  'iu',
);
const HONORIFIC = /^(?:(?:Dr|Mr|Mrs|Ms|Sr|Sra|Mme)\.?|M\.)\s+/u;
const PARTICLE = '(?:de|del|da|das|do|dos|di|du|van|von|der|den|la|le|y|bin|al)';
const CAP_WORD = "\\p{Lu}[\\p{L}'’.-]*";
/** 2–4 capitalised words (lowercase name particles allowed between them), no digits, optional honorific. */
const NAME_RE = new RegExp(`^(?:(?:Dr|Mr|Mrs|Ms|Sr|Sra|Mme)\\.?\\s+|M\\.\\s+)?${CAP_WORD}(?:\\s+(?:${PARTICLE}\\s+)*${CAP_WORD}){1,3}$`, 'u');
/** What is left of a part that held only a contact value: field labels and separators. */
const ONLY_LABELS = /^[\s\W]*(?:(?:tel|tél|telephone|téléphone|teléfono|telefono|phone|ph|mob|mobile|móvil|movil|cell|fax|email|e-mail|mail|correo|courriel|web|website|site|url|t|m|p|f|e|w)\b[\s\W]*)*$/iu;
/** Splits a line into parts: " · ", " • ", " | ", tabs, or three or more spaces (a PDF's columns). */
const PART_SEP = /\s+[·•|]\s+|\t+| {3,}/;

const digits = (s: string) => s.replace(/\D/g, '');
const tidy = (s: string) => s.replace(/^[\s,;:·•|–—-]+|[\s,;:·•|–—-]+$/g, '').replace(/\s+/g, ' ');

function firstPhone(text: string): string | null {
  for (const m of text.matchAll(PHONE_RE)) {
    const v = m[0].trim().replace(/[\s(.\-/]+$/, '');
    const d = digits(v).length;
    if (d >= 8 && d <= 15 && !DATE_RE.test(v)) return v;
  }
  return null;
}

function firstWebsite(text: string): string | null {
  const url = text.match(URL_RE);
  if (url) return url[0].replace(TRAILING, '');
  for (const m of text.matchAll(DOMAIN_RE)) {
    const tld = m[1]!;
    // "Mr.Smith" is not a domain: the top-level domain is all lowercase or all capitals.
    if (tld !== tld.toLowerCase() && tld !== tld.toUpperCase()) continue;
    if (FILE_EXT.has(tld.toLowerCase())) continue;
    return m[0].replace(TRAILING, '');
  }
  return null;
}

type Part = { text: string; rest: string; contact: boolean };

/** A record's fields from the lines of a block (or of one line), or null when it has no email, phone or website. */
function recordOf(lines: string[], known: readonly string[]): RowFields | null {
  const all = lines.join('\n');
  const email = all.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;
  const noEmail = all.replace(EMAIL_RE, ' ');
  const website = firstWebsite(noEmail);
  const phone = firstPhone(noEmail.replace(URL_RE, ' ').replace(DOMAIN_RE, ' '));
  if (!email && !phone && !website) return null;

  // Each part without its contact values; a part that held only those (and labels) is no candidate for anything else.
  const parts: Part[] = lines.flatMap((l) => l.split(PART_SEP)).map((p) => p.trim()).filter((p) => p !== '').map((text) => {
    let rest = text.replace(EMAIL_RE, ' ').replace(URL_RE, ' ');
    if (website && !/^(?:https?:\/\/|www\.)/i.test(website)) rest = rest.split(website).join(' ');
    if (phone) rest = rest.split(phone).join(' ');
    const contact = rest !== text;
    rest = ONLY_LABELS.test(rest) ? '' : tidy(rest);
    return { text, rest, contact };
  });
  const free = parts.filter((p) => p.rest !== '');
  const used = new Set<Part>();
  const fields: RowFields = {};

  const countryOf = (p: Part) => {
    const whole = matchCountry(p.rest, known);
    if (whole) return whole;
    const last = p.rest.split(',').pop()!.trim();
    return p.rest.includes(',') ? matchCountry(last, known) : null;
  };
  const countryPart = free.find((p) => countryOf(p));
  if (countryPart) {
    fields.country = countryOf(countryPart)!;
    used.add(countryPart);
  }

  const suffixPart = free.find((p) => !used.has(p) && LEGAL_SUFFIX.test(p.rest));
  let company: Part | undefined = suffixPart;
  if (company) used.add(company);

  // Designation: a part with a title word; "Omar Haddad, Operations Manager" gives the title and a contact candidate.
  let contactCandidate: string | null = null;
  const designationPart = free.find((p) => !used.has(p) && TITLE_WORD.test(p.rest));
  if (designationPart) {
    used.add(designationPart);
    const pieces = designationPart.rest.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const title = pieces.find((s) => TITLE_WORD.test(s)) ?? designationPart.rest;
    fields.designation = title;
    const other = pieces.find((s) => s !== title && NAME_RE.test(s));
    if (other) contactCandidate = other;
  }

  const nameLike = (p: Part) => !used.has(p) && p !== company && !p.contact && NAME_RE.test(p.rest);
  let contact: Part | undefined = free.find((p) => nameLike(p) && HONORIFIC.test(p.rest));
  if (contact) used.add(contact);

  if (!company) {
    // The part holding the website's name (or, without a website, a company email's), e.g. brightlinedental.com.
    const domain = domainOf(website) ?? (email && !isFreeMail(domainOf(email) ?? '') ? domainOf(email) : null);
    const stem = domain ? squash(domain.split('.')[0]!) : '';
    if (stem.length >= 3) {
      company = free.find((p) => {
        if (used.has(p)) return false;
        const s = squash(p.rest);
        return s.length >= 3 && (s.includes(stem) || stem.includes(s));
      });
    }
  }
  if (company) used.add(company);
  // A name next to the title ("Tom Baker" under "Head of Procurement").
  if (!contact && !contactCandidate && designationPart) {
    const at = parts.indexOf(designationPart);
    contact = [parts[at - 1], parts[at + 1]].find((p): p is Part => p !== undefined && nameLike(p));
    if (contact) used.add(contact);
  }
  // Else the first part that is no other field, a part that reads as a person's name last.
  if (!company) company = free.find((p) => !used.has(p) && !nameLike(p)) ?? free.find((p) => !used.has(p));
  if (company) used.add(company);
  if (company) fields.companyName = company.rest;

  if (!contact && !contactCandidate) contact = free.find(nameLike);
  const contactName = contact?.rest ?? contactCandidate;
  if (contactName) fields.contactName = contactName;

  if (email) fields.email = email;
  if (phone) fields.phone = phone;
  if (website) fields.website = website;
  for (const k of Object.keys(fields) as ImportField[]) fields[k] = fields[k]!.slice(0, MAX_VALUE);
  return fields;
}

/** Rows of blocks: a block with an email, phone or website is one record; one with two or more emails, a row per line holding one. */
export function rowsFromBlocks(blocks: readonly Block[], known: readonly string[]): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const block of blocks) {
    const emails = block.lines.reduce((n, l) => n + (l.text.match(EMAIL_RE)?.length ?? 0), 0);
    if (emails >= 2) {
      for (const line of block.lines) {
        if (!line.text.match(EMAIL_RE)) continue;
        const fields = recordOf([line.text], known);
        if (fields) rows.push({ fields, originKind: block.kind, originN: block.kind === 'line' ? line.n : block.n });
      }
      continue;
    }
    const fields = recordOf(block.lines.map((l) => l.text), known);
    if (fields) rows.push({ fields, originKind: block.kind, originN: block.n });
  }
  return rows;
}

/** The deterministic reader: the document's records, without Claude. */
export function extractBlocks(extract: TextExtract, knownCountries: readonly string[]): DraftRow[] {
  return rowsFromBlocks(documentBlocks(extract), knownCountries);
}

// ---------------------------------------------------------------------------------------------------------------
// The check every Claude value must pass

/** Lowercase, accents and punctuation removed, whitespace collapsed, padded so a match is whole words. */
const normalise = (s: string) =>
  ` ${s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
/** The digits of each phone-like run of the text (digits with spaces, brackets, dots, dashes, slashes, "+"; no line breaks). */
const digitRuns = (text: string) => (text.match(/\d[\d \t().\-/+]*/g) ?? []).map(digits);

/**
 * Whether a value is written in the text: email by lowercase substring, website by its domain, phone by its digits
 * (7 or more) within one number of the text, anything else by whole words after normalising.
 */
export function valueInText(value: string, field: ImportField, text: string): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (field === 'email') return text.toLowerCase().includes(v.toLowerCase());
  if (field === 'website') {
    const domain = domainOf(v);
    return domain !== null && text.toLowerCase().includes(domain);
  }
  if (field === 'phone') {
    const d = digits(v);
    return d.length >= 7 && digitRuns(text).some((run) => run.includes(d));
  }
  const n = normalise(v);
  return n.trim() !== '' && normalise(text).includes(n);
}
