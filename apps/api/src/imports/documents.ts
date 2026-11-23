/**
 * Import leads, PDF / Word / text documents: the deterministic reader (used when Claude is off, out of runs, or a call
 * fails) and the check every Claude value must pass, that it is written in the document's own text.
 *
 * A document is split into blocks: groups of lines separated by blank lines, within a page. A Word file's text has a
 * blank line after every paragraph, so there a block ends at two or more blank lines (an empty paragraph). Each block
 * of a Word file is a card (numbered from 1), each block of a text file is known by its first line number.
 *
 * The text is untrusted and up to 5 M characters: every pattern here runs in linear time (bounded repetitions, a
 * match only starts at a token start, end trims are loops), lines are cut at 1,000 characters, and the job runs this
 * reader in the read child process (`draftDocument`, see read/child.ts), never on the worker's event loop.
 */
import { domainOf, isFreeMail, type ImportField, type RowFields } from '@dait-crm/shared';
import { squash } from './columns.js';
import { matchCountry } from './countries.js';
import type { TextExtract } from './read/index.js';

export type OriginKind = TextExtract['unit'];
export type DraftRow = { fields: RowFields; originKind: OriginKind; originN: number };
/**
 * A block: its index in the document, its origin (page n, card n or first line n) and its lines (non-blank, trimmed,
 * at most MAX_LINE characters) with their line numbers and their index `k` in the block.
 */
export type Block = { i: number; kind: OriginKind; n: number; lines: { n: number; k: number; text: string }[] };
/**
 * A deterministic row and where its record starts (block `block`, line index `start`): a chunk Claude could not read
 * falls back to exactly the rows that start on its own lines.
 */
export type BlockRow = DraftRow & { block: number; start: number };
/** What the read child sends back for a document: its blocks and the deterministic reader's rows. */
export type DocumentDraft = { blocks: Block[]; rows: BlockRow[] };

/** Longest value a staged cell keeps (the row edit's limit). */
export const MAX_VALUE = 500;
/** Longer lines are cut into pieces of this many characters: no record line is that long. */
export const MAX_LINE = 1000;

/** The document's blocks, in order. */
export function documentBlocks(extract: TextExtract): Block[] {
  const blocks: Block[] = [];
  let card = 0;
  for (const page of extract.pages) {
    const lines: { n: number; text: string }[] = [];
    page.text.replace(/\u0000/g, '').split('\n').forEach((t, i) => {
      const text = t.trim();
      if (text.length <= MAX_LINE) lines.push({ n: i + 1, text });
      else for (let at = 0; at < text.length; at += MAX_LINE) lines.push({ n: i + 1, text: text.slice(at, at + MAX_LINE).trim() });
    });
    // Paragraph-style text (no two non-blank lines in a row, as a Word file's): one blank line is a paragraph break.
    const paragraphs = !lines.some((l, i) => i > 0 && l.text !== '' && lines[i - 1]!.text !== '');
    const gap = paragraphs ? 2 : 1;
    let current: Block['lines'] = [];
    let blank = 0;
    const flush = () => {
      if (current.length === 0) return;
      const n = extract.unit === 'page' ? page.n : extract.unit === 'card' ? (card += 1) : current[0]!.n;
      blocks.push({ i: blocks.length, kind: extract.unit, n, lines: current });
      current = [];
    };
    for (const line of lines) {
      if (line.text === '') {
        blank += 1;
        continue;
      }
      if (blank >= gap) flush();
      blank = 0;
      current.push({ n: line.n, k: current.length, text: line.text });
    }
    flush();
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// Values in a block

/** Starts only where a token starts; every part is bounded, so each start costs a bounded amount of work. */
export const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const URL_RE = /(?<![\p{L}\p{N}])(?:https?:\/\/|www\.)[^\s<>"'()·•|,;]{1,500}/giu;
/** A bare domain: labels and a 2–24 letter top-level domain, starting at a token start, not inside an email or a longer name. */
const DOMAIN_RE = /(?<![\p{L}\p{N}@._-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}([a-z]{2,24})(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])(?:\/[^\s<>"'·•|,;]{0,300})?/giu;
/** File names are not websites. */
const FILE_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'zip']);
/** A phone as written: at most 32 characters, so a failed match never scans far. */
const PHONE_RE = /(?:\+ ?)?\(?\d[\d \t().\-/]{5,30}\d/g;
const DATE_RE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/;
/** A number that is a reference, not a phone ("ref 12345678", "VAT: 123…", "Invoice #…"): the words just before it. */
const NUMBER_LABEL = /(?:^|[^\p{L}])(?:ref|reference|réf|référence|referencia|invoice|factura|facture|order|pedido|commande|vat|tva|iva|tax|id|gst|gstin|cif|nif|rfc|siret|siren|account|acct|iban|po|ruc|rut|cuit|abn|ein|reg|registration|registro|cr)\.?\s?[:#]?\s?$|#\s?$/iu;

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
/** Words that make a name a business, not a person ("Northgate Retail Group" before "Sarah Lim"). */
const COMPANY_WORD = new RegExp(
  `(?<![\\p{L}])(?:${[
    'Group', 'Groupe', 'Grupo', 'Retail', 'Trading', 'Clinic', 'Clinics', 'Clínica', 'Clinique', 'Solutions', 'Soluciones', 'Services',
    'Servicios', 'Industries', 'Industrial', 'Holdings', 'Technologies', 'Technology', 'Tech', 'International', 'Internacional',
    'Consulting', 'Consultores', 'Logistics', 'Logística', 'Engineering', 'Ingeniería', 'Partners', 'Systems', 'Studio', 'Studios',
    'Agency', 'Agencia', 'Bank', 'Banco', 'Hotel', 'Hotels', 'Hospital', 'Foundation', 'Fundación', 'Institute', 'Instituto',
    'University', 'Universidad', 'Company', 'Compañía', 'Enterprises', 'Labs', 'Media', 'Marketing', 'Design', 'Dental',
    'Medical', 'Pharma', 'Foods', 'Motors', 'Energy', 'Capital', 'Ventures', 'Associates', 'Société', 'Corporation',
  ].join('|')})(?![\\p{L}])`,
  'iu',
);
/** A document's own heading or the organiser's notice, not a record ("Exhibitor Directory 2026", "For enquiries: …"). */
const HEADING_WORD = /(?<![\p{L}])(?:directory|exhibitors?|visitors?|delegates?|attendees?|participants?|catalogue|catalog|programme|program|agenda|contents|directorio|expositores|visitantes|participantes|asistentes|catálogo|annuaire|exposants|visiteurs|sommaire)(?![\p{L}])/iu;
const ENQUIRY = /(?<![\p{L}])(?:for (?:more |further )?(?:enquiries|inquiries|information|info|details)|enquiries|inquiries|contact us|get in touch|para (?:más )?información|informes|renseignements)(?![\p{L}])/iu;
const HONORIFIC = /^(?:(?:Dr|Mr|Mrs|Ms|Sr|Sra|Mme)\.?|M\.)\s/u;
const PARTICLE = '(?:de|del|da|das|do|dos|di|du|van|von|der|den|la|le|y|bin|al)';
const CAP_WORD = "\\p{Lu}[\\p{L}'’.-]{0,40}";
/** 2–4 capitalised words (lowercase name particles allowed between them), no digits, optional honorific. */
const NAME_RE = new RegExp(`^(?:(?:Dr|Mr|Mrs|Ms|Sr|Sra|Mme)\\.?\\s|M\\.\\s)?${CAP_WORD}(?:\\s(?:${PARTICLE}\\s){0,3}${CAP_WORD}){1,3}$`, 'u');
/** Field labels: a part left with only these (after its email, website or phone) held only that value. */
const LABELS = new Set([
  'tel', 'tél', 'telephone', 'téléphone', 'teléfono', 'telefono', 'phone', 'ph', 'mob', 'mobile', 'móvil', 'movil', 'cell', 'fax',
  'email', 'e', 'mail', 'correo', 'courriel', 'web', 'website', 'site', 'url', 't', 'm', 'p', 'f', 'w',
]);
/** Splits a line into parts: " · ", " • ", " | ", tabs, or three or more spaces (a PDF's columns). */
const PART_SEP = /[ \t]+[·•|][ \t]+|\t+| {3,}/;
const EDGE = new Set([...' \t\n,;:·•|–—-']);

const digits = (s: string) => s.replace(/\D/g, '');

/** Trims separators and dashes from both ends (a loop, not a regex: linear on any input) and collapses whitespace. */
function tidy(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && EDGE.has(s[a]!)) a += 1;
  while (b > a && EDGE.has(s[b - 1]!)) b -= 1;
  return s.slice(a, b).replace(/\s+/g, ' ');
}

/** Drops trailing characters in `set` (a loop: linear). */
function trimEnd(s: string, set: string): string {
  let b = s.length;
  while (b > 0 && set.includes(s[b - 1]!)) b -= 1;
  return s.slice(0, b);
}

const onlyLabels = (s: string) => s.split(/[^\p{L}]+/u).every((w) => w === '' || LABELS.has(w.toLowerCase()));

function firstPhone(text: string): string | null {
  for (const m of text.matchAll(PHONE_RE)) {
    const v = trimEnd(m[0].trim(), ' \t(.-/');
    const d = digits(v).length;
    if (d < 8 || d > 15 || DATE_RE.test(v)) continue;
    // Part of a longer number (an account or ID number): never a phone.
    const before = text[m.index! - 1] ?? '';
    const after = text[m.index! + m[0].length] ?? '';
    if (/\d/.test(before) || /\d/.test(after)) continue;
    if (NUMBER_LABEL.test(text.slice(Math.max(0, m.index! - 24), m.index!))) continue;
    return v;
  }
  return null;
}

function firstWebsite(text: string): string | null {
  for (const m of text.matchAll(URL_RE)) return trimEnd(m[0], '.,;:)]');
  for (const m of text.matchAll(DOMAIN_RE)) {
    const tld = m[1]!;
    // "Mr.Smith" is not a domain: the top-level domain is all lowercase or all capitals.
    if (tld !== tld.toLowerCase() && tld !== tld.toUpperCase()) continue;
    if (FILE_EXT.has(tld.toLowerCase())) continue;
    return trimEnd(m[0], '.,;:)]');
  }
  return null;
}

type Part = { text: string; rest: string; contact: boolean };

/** A line's parts, each without its email, website and phone (`rest`); `contact` = it held one of them. */
function partsOf(lines: string[], website: string | null, phone: string | null): Part[] {
  return lines.flatMap((l) => l.split(PART_SEP)).map((p) => p.trim()).filter((p) => p !== '').map((text) => {
    let rest = text.replace(EMAIL_RE, ' ').replace(URL_RE, ' ');
    if (website && !/^(?:https?:\/\/|www\.)/i.test(website)) rest = rest.split(website).join(' ');
    if (phone) rest = rest.split(phone).join(' ');
    const contact = rest !== text;
    rest = onlyLabels(rest) ? '' : tidy(rest);
    return { text, rest, contact };
  });
}

/** A record's fields from the lines of a block (or of one segment), or null when it has no email, phone or website. */
function recordOf(lines: string[], known: readonly string[]): RowFields | null {
  const all = lines.join('\n');
  const email = all.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;
  const noEmail = all.replace(EMAIL_RE, ' ');
  const found = firstWebsite(noEmail);
  // A free-mail domain written on its own ("gmail.com") is no company's website.
  const website = found && !isFreeMail(domainOf(found) ?? '') ? found : null;
  const phone = firstPhone(noEmail.replace(URL_RE, ' ').replace(DOMAIN_RE, ' '));
  if (!email && !phone && !website) return null;

  // A part that held only contact values (and labels) is no candidate for anything else.
  const parts = partsOf(lines, website, phone);
  const free = parts.filter((p) => p.rest !== '');
  const used = new Set<Part>();
  const fields: RowFields = {};

  const countryOf = (p: Part) => {
    const whole = matchCountry(p.rest, known);
    if (whole) return whole;
    return p.rest.includes(',') ? matchCountry(p.rest.slice(p.rest.lastIndexOf(',') + 1).trim(), known) : null;
  };
  const countryPart = free.find((p) => countryOf(p));
  if (countryPart) {
    fields.country = countryOf(countryPart)!;
    used.add(countryPart);
  }

  let company: Part | undefined = free.find((p) => !used.has(p) && LEGAL_SUFFIX.test(p.rest));
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
  const businessLike = (p: Part) => COMPANY_WORD.test(p.rest) || p.rest.split(' ').length >= 3;
  let contact: Part | undefined = free.find((p) => nameLike(p) && HONORIFIC.test(p.rest));
  if (contact) used.add(contact);

  if (!company) {
    // The part holding the website's name (or, without a website, a company email's), e.g. brightlinedental.com.
    const emailDomain = email ? domainOf(email) : null;
    const domain = domainOf(website) ?? (emailDomain && !isFreeMail(emailDomain) ? emailDomain : null);
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
    contact = [parts[at - 1], parts[at + 1]].find((p): p is Part => p !== undefined && nameLike(p) && !businessLike(p))
      ?? [parts[at - 1], parts[at + 1]].find((p): p is Part => p !== undefined && nameLike(p));
    if (contact) used.add(contact);
  }
  // Else the first part that is no other field: one that reads as a person's name only after one that reads as a business.
  if (!company) {
    const open = free.filter((p) => !used.has(p) && !(HEADING_WORD.test(p.rest) && !p.contact));
    company = open.find((p) => !nameLike(p)) ?? open.find(businessLike) ?? open[0];
  }
  if (company) {
    used.add(company);
    fields.companyName = company.rest;
  }

  if (!contact && !contactCandidate) contact = free.find((p) => nameLike(p) && !businessLike(p)) ?? free.find(nameLike);
  const contactName = contact?.rest ?? contactCandidate;
  if (contactName) fields.contactName = contactName;

  if (email) fields.email = email;
  if (phone) fields.phone = phone;
  if (website) fields.website = website;
  for (const k of Object.keys(fields) as ImportField[]) fields[k] = fields[k]!.slice(0, MAX_VALUE);
  return fields;
}

const hasEmail = (text: string) => text.search(EMAIL_RE) >= 0;
/** The line holds an email, a phone or a website. */
const hasContact = (text: string) => {
  if (hasEmail(text)) return true;
  const rest = text.replace(EMAIL_RE, ' ');
  return firstWebsite(rest) !== null || firstPhone(rest.replace(URL_RE, ' ').replace(DOMAIN_RE, ' ')) !== null;
};

/**
 * A heading segment: the document's title or the organiser's notice ("Exhibitor Directory 2026 / For enquiries: …"):
 * every line is a heading line (a heading word, no contact value), an enquiry line or contact values only, and at
 * least one is a heading line. A heading word on a line with a contact value ("Exhibitor Services · …"), or a heading
 * line holding the website's name, is a company.
 */
function isHeadingSegment(lines: string[]): boolean {
  let heading = false;
  const website = firstWebsite(lines.join('\n').replace(EMAIL_RE, ' '));
  const stem = website ? squash((domainOf(website) ?? '').split('.')[0] ?? '') : '';
  for (const line of lines) {
    if (LEGAL_SUFFIX.test(line)) return false;
    const contact = hasContact(line);
    if (ENQUIRY.test(line)) continue;
    if (HEADING_WORD.test(line)) {
      if (contact || (stem.length >= 3 && squash(line).includes(stem))) return false;
      heading = true;
    } else if (partsOf([line], firstWebsite(line.replace(EMAIL_RE, ' ')), null).some((p) => p.rest !== '' && !/^\d/.test(p.rest))) {
      return false;
    }
  }
  return heading;
}

/**
 * Where a record starts in a list: a line with a legal suffix or a business word, or a line with no contact value that
 * is no title, country or heading.
 */
function startsRecord(text: string, known: readonly string[]): boolean {
  if (LEGAL_SUFFIX.test(text) || COMPANY_WORD.test(text)) return true;
  if (hasContact(text) || TITLE_WORD.test(text) || HEADING_WORD.test(text)) return false;
  const last = text.includes(',') ? text.slice(text.lastIndexOf(',') + 1).trim() : text;
  return !matchCountry(text, known) && !matchCountry(last, known);
}

/**
 * Rows of blocks: a block with an email, phone or website is one record. One with two or more email lines (a list) is
 * split where each record starts (a company-like line, or a line with no contact value, once the record so far holds
 * a contact value); when no such line is found, after each email line (what follows the last one is a record when it
 * holds a phone or website). Heading segments are no leads.
 */
export function rowsFromBlocks(blocks: readonly Block[], known: readonly string[]): BlockRow[] {
  const rows: BlockRow[] = [];
  for (const block of blocks) {
    const add = (lines: Block['lines']) => {
      if (lines.length === 0 || isHeadingSegment(lines.map((l) => l.text))) return;
      const fields = recordOf(lines.map((l) => l.text), known);
      if (fields) {
        rows.push({ fields, originKind: block.kind, originN: block.kind === 'line' ? lines[0]!.n : block.n, block: block.i, start: lines[0]!.k });
      }
    };
    if (block.lines.filter((l) => hasEmail(l.text)).length < 2) {
      add(block.lines);
      continue;
    }
    const segments: Block['lines'][] = [];
    let segment: Block['lines'] = [];
    let withContact = false;
    for (const line of block.lines) {
      if (withContact && startsRecord(line.text, known)) {
        segments.push(segment);
        segment = [];
        withContact = false;
      }
      segment.push(line);
      if (hasContact(line.text)) withContact = true;
    }
    segments.push(segment);
    if (segments.length > 1) {
      for (const seg of segments) add(seg);
      continue;
    }
    segment = [];
    for (const line of block.lines) {
      segment.push(line);
      if (hasEmail(line.text)) {
        add(segment);
        segment = [];
      }
    }
    add(segment);
  }
  return rows;
}

/** The deterministic reader: the document's records, without Claude. */
export function extractBlocks(extract: TextExtract, knownCountries: readonly string[]): DraftRow[] {
  return rowsFromBlocks(documentBlocks(extract), knownCountries).map(({ block: _block, start: _start, ...row }) => row);
}

/** The document's blocks and deterministic rows (run in the read child process). */
export function draftDocument(extract: TextExtract, knownCountries: readonly string[]): DocumentDraft {
  const blocks = documentBlocks(extract);
  return { blocks, rows: rowsFromBlocks(blocks, knownCountries) };
}

// ---------------------------------------------------------------------------------------------------------------
// The check every Claude value must pass

/** Letters NFD does not take apart. */
const FOLD: Record<string, string> = { ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/**
 * Lowercase; a word hyphenated across a line break joined; accents and ø/ß/æ… folded; dotted acronyms closed up
 * ("A.B.C." → "abc"); punctuation removed and whitespace collapsed; padded so a match is whole words.
 */
function normalise(s: string, joinHyphens = true): string {
  const t = (joinHyphens ? s.replace(/(?<=\p{L})-[ \t]*\r?\n[ \t]*(?=\p{L})/gu, '') : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[øßæœłđðþı]/g, (c) => FOLD[c]!)
    .replace(/(?<![\p{L}\p{N}])(?:\p{L}\.){2,}/gu, (m) => m.replace(/\./g, ''))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return ` ${t} `;
}

/**
 * Each phone-like run of the text (digits with single spaces, brackets, dots, dashes; no line breaks, tabs or "/") as
 * the digits of its space-separated groups.
 */
const phoneRuns = (text: string): string[][] =>
  (text.match(/\+?\(?\d(?:[\d().-]| (?=[\d(]))*/g) ?? []).map((run) => run.split(' ').map(digits).filter((g) => g !== ''))
    .filter((groups) => groups.join('').length >= 7);

/** A text prepared once for many `valueInText` checks. */
export type PreparedText = { lower: string; normal: string; hyphenated: string; emails: Set<string>; phones: string[][] };

export function prepareText(text: string): PreparedText {
  return {
    lower: text.toLowerCase(), normal: normalise(text), hyphenated: normalise(text, false),
    emails: new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())), phones: phoneRuns(text),
  };
}

/** The domain occurs in the text as a whole domain (`www.acme.com` holds `acme.com`; `logistics.ae` is not in `alnoorlogistics.ae`). */
function domainIn(domain: string, lower: string): boolean {
  for (let at = lower.indexOf(domain); at >= 0; at = lower.indexOf(domain, at + 1)) {
    const before = at > 0 ? lower[at - 1]! : '';
    const after = lower.slice(at + domain.length, at + domain.length + 2);
    if (/[a-z0-9-]/.test(before) || /^[a-z0-9-]/.test(after) || /^\.[a-z0-9]/.test(after)) continue;
    return true;
  }
  return false;
}

/** `valueInText` against a prepared text. */
export function valueInPrepared(value: string, field: ImportField, t: PreparedText): boolean {
  const v = value.trim();
  if (v === '') return false;
  if (field === 'email') return t.emails.has(v.toLowerCase());
  if (field === 'website') {
    const domain = domainOf(v);
    return domain !== null && domainIn(domain, t.lower);
  }
  if (field === 'phone') {
    // One number of the text, whole, or its last space-separated groups (without a country code or a postcode
    // before it) when 9+ digits are left; never digits from inside a group (the tail of a longer ID).
    const d = digits(v);
    if (d.length < 7) return false;
    return t.phones.some((groups) => {
      if (groups.join('') === d) return true;
      if (d.length < 9) return false;
      for (let i = 1; i < groups.length; i += 1) if (groups.slice(i).join('') === d) return true;
      return false;
    });
  }
  const n = normalise(v);
  // A word hyphenated at a line break reads either way: "Bright-\nline" is "Brightline", "Al-\nNoor" is "Al Noor".
  return n.trim() !== '' && (t.normal.includes(n) || t.hyphenated.includes(n));
}

/**
 * Whether a value is written in the text: an email equal to one of the text's emails, a website's domain as a whole
 * domain, a phone as one whole number of the text (7+ digits; a short country / trunk prefix may be missing), anything
 * else as whole words after normalising.
 */
export function valueInText(value: string, field: ImportField, text: string): boolean {
  return valueInPrepared(value, field, prepareText(text));
}
