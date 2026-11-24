/**
 * Sorting a spreadsheet's columns into lead fields (Import leads, step 2): header words in English, Spanish and
 * French, what the values look like, where the header row is, and which columns to ask about. There are no mapping
 * dropdowns: a column the CRM is unsure of gets its guess at once and one question.
 */
import {
  EXPORT_CONTEXT_COLUMNS, IMPORT_FIELDS, IMPORT_ID_FIELDS, importColumnLabel,
  type ColumnQuestion, type ImportColumnKey, type ImportField, type ImportIdField,
} from '@dait-crm/shared';
import { matchCountry } from './countries.js';

/** `leadId` / `companyId`: the record ids of a "Download all leads" file (an update row). */
export type ColumnTarget = ImportField | ImportIdField | 'firstName' | 'lastName' | 'ignore';
export type HeaderMatch = { target: ColumnTarget; strength: 'strong' | 'weak' };

/** Lower case, accents removed, everything but letters and digits removed ("Correo electrónico" → "correoelectronico"). */
export function squash(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const LANGS = ['en', 'es', 'fr'] as const;

/** Header words that settle a column (squashed); every step-2 column label in all three languages is added below. */
const STRONG: Record<ColumnTarget, string[]> = {
  companyName: [
    'company', 'companyname', 'organisation', 'organization', 'organisationname', 'organizationname', 'business',
    'businessname', 'empresa', 'nombredelaempresa', 'razonsocial', 'societe', 'entreprise', 'nomdelentreprise',
    'exhibitor', 'exhibitorname', 'expositor', 'exposant', 'account', 'accountname', 'nameofcompany', 'nameofthecompany',
    'nombreempresa', 'nombredeempresa', 'nomdelasociete', 'nomsociete',
  ],
  website: ['website', 'web', 'url', 'site', 'sitioweb', 'siteweb', 'paginaweb', 'siteinternet', 'websiteurl', 'companywebsite', 'homepage'],
  country: ['country', 'pais', 'pays', 'countryregion'],
  city: ['city', 'town', 'ciudad', 'ville', 'localidad'],
  contactName: [
    'contact', 'contactname', 'contactperson', 'fullname', 'nombrecompleto', 'nomcomplet', 'persona', 'contacto',
    'personadecontacto', 'personnecontact', 'nomducontact',
  ],
  firstName: ['firstname', 'forename', 'givenname', 'nombredepila', 'prenom'],
  lastName: ['lastname', 'surname', 'familyname', 'apellido', 'apellidos', 'nomdefamille'],
  designation: ['designation', 'title', 'jobtitle', 'position', 'role', 'cargo', 'puesto', 'poste', 'fonction'],
  email: [
    'email', 'mail', 'emailaddress', 'emailid', 'correo', 'correoelectronico', 'courriel', 'adressemail', 'adresseemail',
    'businessemail', 'workemail', 'contactemail', 'companyemail', 'emailempresa', 'correoempresa',
  ],
  phone: [
    'phone', 'phonenumber', 'telephone', 'telephonenumber', 'tel', 'mobile', 'mobilenumber', 'mobilephone', 'cell',
    'cellphone', 'movil', 'celular', 'telefono', 'portable', 'whatsapp', 'contactnumber', 'mobileno', 'phoneno',
    'contactno', 'telno', 'cellno', 'numerodetelefono', 'nodetelefono', 'numerodecelular', 'numerodemovil',
    'numerodetelephone', 'numerodeportable', 'telportable',
  ],
  industry: ['industry', 'sector', 'industria', 'secteur', 'secteurdactivite'],
  notes: ['notes', 'note', 'comments', 'comment', 'comentarios', 'remarques', 'remarks', 'notas', 'observaciones'],
  leadId: ['leadid', 'leadnumber', 'idlead', 'iddellead', 'iddulead', 'numerodelead', 'numerodulead'],
  companyId: ['companyid', 'idempresa', 'iddeempresa', 'iddelaempresa', 'iddelentreprise', 'identreprise', 'idsociete'],
  ignore: ['whattofix', 'from', 'status'],
};

/** Header words that are only a guess, always asked ("Name" could be the company or the person). */
const WEAK: Record<string, ColumnTarget> = { name: 'companyName', firma: 'companyName', nombre: 'contactName', nom: 'contactName' };

const HEADER_WORDS: ReadonlyMap<string, HeaderMatch> = (() => {
  const map = new Map<string, HeaderMatch>();
  const add = (word: string, target: ColumnTarget) => {
    const key = squash(word);
    if (key && !map.has(key)) map.set(key, { target, strength: 'strong' });
  };
  // The rows-to-fix and "Download all leads" files' own headers come first, so a re-import is always recognised; their
  // read-only columns (Status, Assigned to, Language, Lead type, Source, Lead page) are ignored.
  for (const lang of LANGS) {
    for (const field of IMPORT_FIELDS) add(importColumnLabel(field, lang), field);
    for (const id of IMPORT_ID_FIELDS) add(importColumnLabel(id, lang), id);
    const ignored: ImportColumnKey[] = ['whatToFix', 'from', ...EXPORT_CONTEXT_COLUMNS, 'leadPage'];
    for (const key of ignored) add(importColumnLabel(key, lang), 'ignore');
  }
  for (const [target, words] of Object.entries(STRONG) as [ColumnTarget, string[]][]) for (const w of words) add(w, target);
  for (const [word, target] of Object.entries(WEAK)) if (!map.has(word)) map.set(word, { target, strength: 'weak' });
  return map;
})();

/** What a header says: a strong match settles the column, a weak one is a guess; null when it means nothing. */
export function matchHeader(header: string): HeaderMatch | null {
  return HEADER_WORDS.get(squash(header)) ?? null;
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i;
const URL_RE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i;
const PHONE_CHARS_RE = /^[+\d\s().\-/]+$/;

export const looksLikeEmail = (v: string): boolean => EMAIL_RE.test(v.trim());
export const looksLikeWebsite = (v: string): boolean => !v.includes('@') && URL_RE.test(v.trim());
export const looksLikePhone = (v: string): boolean => PHONE_CHARS_RE.test(v.trim()) && v.replace(/\D/g, '').length >= 7;

/** Share of non-empty values that must look alike for a column to be recognised by its content. */
const SNIFF_SHARE = 0.6;

/** What a column's values are, when at least 60 % of its non-empty values look alike; null otherwise. */
export function sniffColumn(values: string[], knownCountries: readonly string[]): ImportField | null {
  const filled = values.map((v) => v.trim()).filter((v) => v !== '');
  if (filled.length === 0) return null;
  const share = (test: (v: string) => boolean) => filled.filter(test).length / filled.length >= SNIFF_SHARE;
  if (share(looksLikeEmail)) return 'email';
  if (share(looksLikeWebsite)) return 'website';
  if (share(looksLikePhone)) return 'phone';
  if (share((v) => matchCountry(v, knownCountries) !== null)) return 'country';
  return null;
}

/** Rows looked at for a header. */
const HEADER_SCAN = 10;
const NUMERIC_RE = /^[\d\s.,+\-()%$€£]+$/;

/** A cell that is a value, never a header word: a number, an email, a website, a phone or a country of the list. */
function isValueCell(c: string, knownCountries: readonly string[]): boolean {
  return NUMERIC_RE.test(c) || looksLikeEmail(c) || looksLikeWebsite(c) || looksLikePhone(c) || matchCountry(c, knownCountries) !== null;
}

/**
 * The header row: the first of the first 10 rows with at least two strong header words; else the first of them with
 * at least two filled cells, none of them a value (number, email, website, phone or known country), so a sheet that
 * starts straight with data keeps its first row; else -1 (no header: every column is decided by its values).
 */
export function findHeaderRow(rows: string[][], knownCountries: readonly string[] = []): number {
  const scan = rows.slice(0, HEADER_SCAN);
  const strong = scan.findIndex((r) => r.filter((c) => matchHeader(c)?.strength === 'strong').length >= 2);
  if (strong >= 0) return strong;
  return scan.findIndex((r) => {
    const filled = r.map((c) => c.trim()).filter((c) => c !== '');
    return filled.length >= 2 && filled.every((c) => !isValueCell(c, knownCountries));
  });
}

/** "Column A", "Column B" … "Column AA": the name of a column without a header. */
export function columnName(col: number): string {
  let n = col + 1;
  let letters = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `Column ${letters}`;
}

/** Targets several columns may share without a question: names join into the contact, notes are joined. */
const JOINS: ReadonlySet<ColumnTarget> = new Set(['firstName', 'lastName', 'notes']);
const SAMPLES = 3;

/**
 * Decides each column: a strong header its values agree with (or do not contradict) is mapped without a question; a
 * weak header, values alone, or a strong header its values contradict (60 % or more look like another field) is
 * mapped to the guess and asked; a second column for the same field (names and notes excepted) is asked too; a
 * column with neither a header word nor recognisable values is left out (null), with no question.
 */
export function classifyColumns(
  headers: string[], columns: string[][], knownCountries: readonly string[],
): { map: (ColumnTarget | null)[]; questions: Omit<ColumnQuestion, 'sheet'>[] } {
  const width = Math.max(headers.length, columns.length);
  const map: (ColumnTarget | null)[] = [];
  const questions: Omit<ColumnQuestion, 'sheet'>[] = [];
  const taken = new Set<ColumnTarget>();
  for (let col = 0; col < width; col += 1) {
    const header = (headers[col] ?? '').trim() || columnName(col);
    const values = columns[col] ?? [];
    const alias = matchHeader(header);
    const sniff = sniffColumn(values, knownCountries);
    let target: ColumnTarget | null;
    let ask: boolean;
    if (alias?.strength === 'strong') {
      // A country-looking column headed "City" (Singapore, Monaco) is still the city.
      const contradicted = sniff !== null && sniff !== alias.target && alias.target !== 'ignore'
        && !(sniff === 'country' && alias.target === 'city');
      target = contradicted ? sniff : alias.target;
      ask = contradicted;
    } else if (alias) {
      target = sniff ?? alias.target;
      ask = true;
    } else {
      target = sniff;
      ask = sniff !== null;
    }
    if (target !== null && target !== 'ignore' && !JOINS.has(target)) {
      if (taken.has(target)) ask = true;
      taken.add(target);
    }
    map.push(target);
    if (ask && target !== null && target !== 'ignore' && target !== 'firstName' && target !== 'lastName' && target !== 'leadId' && target !== 'companyId') {
      const samples = values.map((v) => v.trim()).filter((v) => v !== '').slice(0, SAMPLES);
      questions.push({ col, header, guess: target, samples });
    }
  }
  return { map, questions };
}
