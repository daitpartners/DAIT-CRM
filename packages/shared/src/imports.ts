/* Import leads + Data manager: limits, the fields a file is sorted into, statuses, row problems and their plain words. */
import type { Lang } from './i18n.js';

export const IMPORT_MAX_FILES = 10;
export const IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_EXTENSIONS = ['xlsx', 'xls', 'csv', 'pdf', 'docx', 'txt'] as const;
export type ImportExt = (typeof IMPORT_EXTENSIONS)[number];
/** "Accept research values with confidence 80% or higher". */
export const ACCEPT_CONFIDENCE = 80;
/** Original files are deleted this many days after upload; a batch never imported, this many days after its last change. */
export const IMPORT_RETENTION_DAYS = 90;
/** The lead_source lookup value of every lead an import creates (with `import_batch` = the batch number). */
export const IMPORT_LEAD_SOURCE = 'Import';

/** The fields a staged row holds (and the rows-to-fix columns, plus From and What to fix). */
export const IMPORT_FIELDS = [
  'companyName', 'website', 'country', 'city', 'contactName', 'designation', 'email', 'phone', 'industry', 'notes',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/**
 * The two record ids a "Download all leads" file carries (Lead ID LD-n, Company ID CO-n): a row with one the uploader can
 * see updates that lead / company (fills its blanks) instead of creating a new lead. Kept in the row's fields.
 */
export const IMPORT_ID_FIELDS = ['leadId', 'companyId'] as const;
export type ImportIdField = (typeof IMPORT_ID_FIELDS)[number];
/** "Download all leads": at most this many leads in one file (narrow the filter for more). */
export const LEADS_EXPORT_MAX = 20000;
/** The step-2 table columns, in the mockup's order (every field but notes). */
export const IMPORT_TABLE_FIELDS = IMPORT_FIELDS.slice(0, 9) as readonly Exclude<ImportField, 'notes'>[];

/** `ImportBatch.status`. */
export const BATCH_STATUSES = [
  'Uploading', 'Sorting', 'Waiting for review', 'Researching', 'Importing', 'Imported', 'Undone', 'Failed',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * `ImportRow.status`, decided on the row's own fields ("Ready" = company + country + email). "Update" = the row carries a
 * Lead ID / Company ID the uploader can see: it fills that record's blanks instead of creating a lead.
 */
export const ROW_STATUSES = ['Ready', 'Missing details', 'Already in CRM', 'Not a lead', 'Update'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

/** `ImportFile.status`; "Scan" = an image-only PDF (not read: no OCR). */
export const FILE_STATUSES = ['Reading', 'Read', 'Scan', 'Failed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** `ImportRow.researchStatus`: everything / some / nothing = what research found for the row's missing fields. */
export const RESEARCH_ROW_STATUSES = ['waiting', 'running', 'everything', 'some', 'nothing', 'failed'] as const;
export type ResearchRowStatus = (typeof RESEARCH_ROW_STATUSES)[number];

export type RowFields = Partial<Record<ImportField | ImportIdField, string>>;
/** A value research found for one field: never without the page it came from and how sure it is (0–100). */
export type ResearchValue = { value: string; sourceUrl: string; sourceLabel: string; confidence: number };

export const PROBLEM_CODES = [
  'company_missing', 'country_missing', 'email_missing', 'contact_missing', 'country_unknown', 'email_invalid',
  'website_invalid', 'not_a_lead', 'unticked', 'already_in_crm', 'no_contact_left_out', 'import_error',
  'lead_not_found', 'company_not_found', 'company_mismatch', 'lead_archived', 'update_conflict', 'industry_unknown',
  'update_contact_differs', 'update_company_differs', 'update_ignored', 'update_verified', 'update_not_applied',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
/** An update row's id problems: the row is an error at import, never a new lead. */
export const UPDATE_ERROR_CODES = ['lead_not_found', 'company_not_found', 'company_mismatch', 'lead_archived'] as const;
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];
export const isUpdateErrorCode = (code: string | null | undefined): code is UpdateErrorCode =>
  (UPDATE_ERROR_CODES as readonly string[]).includes(code ?? '');
/**
 * `level`: missing = red cell (required), questionable = amber cell (unknown or doubtful value), info = no cell colour.
 * `crm` = what the CRM holds (an update row's conflict: "CRM has {crm}, file has {value}").
 */
export type RowProblem = {
  code: ProblemCode; field?: ImportField; level: 'missing' | 'questionable' | 'info'; value?: string; crm?: string;
};

/**
 * Why an update row's value was not applied (the owner checks it and changes it on the lead page if correct):
 * `differs` the CRM holds another value; `unknown` an industry not on the CRM's list; `contact` / `company` the row names
 * another contact / company than the lead's (its contact / company fields are not applied); `invalid` an email or website
 * that is not one; `country` a country the CRM does not know; `ignored` a Company ID row (company fields only);
 * `verified` an empty field verified in the CRM; `not_applied` no record to put it on (inactive contact, no company).
 */
export const CONFLICT_REASONS = ['differs', 'unknown', 'contact', 'company', 'invalid', 'country', 'ignored', 'verified', 'not_applied'] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];
/** An update row's value that was not applied; no `reason` = `differs`. */
export type UpdateConflict = { field: ImportField; crm: string; file: string; reason?: ConflictReason };

/** Longest value a conflict shows in "What to fix" (a long note is cut with "…"). */
const CONFLICT_SHOWN = 120;
const shown = (v: string) => (v.length > CONFLICT_SHOWN ? `${v.slice(0, CONFLICT_SHOWN)}…` : v);

/** A not-applied value as a row problem (amber cell, "What to fix"). */
export function conflictProblem(c: UpdateConflict): RowProblem {
  const base = { field: c.field, level: 'questionable' as const, value: shown(c.file) };
  switch (c.reason ?? 'differs') {
    case 'unknown': return { ...base, code: 'industry_unknown' };
    case 'contact': return { ...base, code: 'update_contact_differs' };
    case 'company': return { ...base, code: 'update_company_differs' };
    case 'invalid': return { ...base, code: c.field === 'website' ? 'website_invalid' : 'email_invalid' };
    case 'country': return { ...base, code: 'country_unknown' };
    case 'ignored': return { ...base, code: 'update_ignored' };
    case 'verified': return { ...base, code: 'update_verified' };
    case 'not_applied': return { ...base, code: 'update_not_applied' };
    default: return { ...base, code: 'update_conflict', crm: shown(c.crm) };
  }
}
/** One blank an update row filled (Undo puts it back while it still holds this value). */
export type UpdateFill = { entity: 'lead' | 'company' | 'contact'; id: number; field: string; value: string | number };
/** `ImportRow.changes`: what an update row did at import (a contact it created, with its stamp, for Undo). */
export type RowChanges = { filled: UpdateFill[]; conflicts: UpdateConflict[]; createdContact?: { id: number; stamp: string } | null };

/**
 * `ImportFile.meta`: what the file list says about a read file; `noClaude` = (part) read without Claude: switched off,
 * the month's run cap reached, or a long document past its per-file Claude limit (`importNoClaudeText`).
 * `rows` of a spreadsheet = its staged rows; `headers` = each sheet's header row cells (null when the sheet has none),
 * kept so a repeated header row stays "Not a lead" when the file's columns are re-sorted.
 */
export type FileMeta = {
  sheets?: number; rows?: number; pages?: number; lines?: number; textFound?: boolean; noClaude?: ImportNoClaude;
  headers?: Record<string, string[] | null>;
  /** Column keys (sheet, U+001F, index) a person answered: never asked about again as a duplicate. */
  answered?: string[];
};
/** An unsure column: the guess is applied at once; a person may confirm another field or skip it. */
export type ColumnQuestion = { sheet: string; col: number; header: string; guess: ImportField; samples: string[] };

const PROBLEM_TEXT: Record<Lang, Record<ProblemCode, string>> = {
  en: {
    company_missing: 'Add the company name',
    country_missing: 'Add the country',
    email_missing: 'Add an email',
    contact_missing: 'Add an email or phone',
    country_unknown: 'Country not in the CRM: {value}',
    email_invalid: 'Check the email: {value}',
    website_invalid: 'Check the website: {value}',
    not_a_lead: 'Not a lead (header, total or blank line)',
    unticked: 'Not ticked for import',
    already_in_crm: 'Already in the CRM as {value}',
    no_contact_left_out: 'Left out: no email or phone',
    import_error: 'Could not import: {value}',
    lead_not_found: 'Lead {value} not found or not yours',
    company_not_found: 'Company {value} not found or not yours',
    company_mismatch: 'Company ID {value} does not match the lead (its company is {crm})',
    update_conflict: '{field}: CRM has {crm}, file has {value} — update on the lead page if correct',
    industry_unknown: 'Industry not in the CRM list: {value} — update on the lead page if correct',
    lead_archived: 'Lead {value} is archived: unarchive it first',
    update_contact_differs: '{field}: {value} not applied — the contact in the file is not the lead’s contact',
    update_company_differs: '{field}: {value} not applied — the company in the file is not the lead’s company',
    update_ignored: '{field}: {value} not applied — a Company ID row updates company fields only',
    update_verified: '{field}: {value} not applied — the field is verified in the CRM',
    update_not_applied: '{field}: {value} not applied — update on the lead page if correct',
  },
  es: {
    company_missing: 'Añade el nombre de la empresa',
    country_missing: 'Añade el país',
    email_missing: 'Añade un correo',
    contact_missing: 'Añade un correo o teléfono',
    country_unknown: 'País que no está en el CRM: {value}',
    email_invalid: 'Revisa el correo: {value}',
    website_invalid: 'Revisa el sitio web: {value}',
    not_a_lead: 'No es un lead (encabezado, total o línea en blanco)',
    unticked: 'No marcada para importar',
    already_in_crm: 'Ya está en el CRM como {value}',
    no_contact_left_out: 'Excluida: sin correo ni teléfono',
    import_error: 'No se pudo importar: {value}',
    lead_not_found: 'Lead {value} no encontrado o no es tuyo',
    company_not_found: 'Empresa {value} no encontrada o no es tuya',
    company_mismatch: 'El ID de empresa {value} no coincide con el lead (su empresa es {crm})',
    update_conflict: '{field}: el CRM tiene {crm}, el archivo tiene {value} — actualízalo en la página del lead si es correcto',
    industry_unknown: 'Sector que no está en la lista del CRM: {value} — actualízalo en la página del lead si es correcto',
    lead_archived: 'El lead {value} está archivado: desarchívalo primero',
    update_contact_differs: '{field}: {value} no aplicado — el contacto del archivo no es el contacto del lead',
    update_company_differs: '{field}: {value} no aplicado — la empresa del archivo no es la empresa del lead',
    update_ignored: '{field}: {value} no aplicado — una fila con ID de empresa solo actualiza campos de la empresa',
    update_verified: '{field}: {value} no aplicado — el campo está verificado en el CRM',
    update_not_applied: '{field}: {value} no aplicado — actualízalo en la página del lead si es correcto',
  },
  fr: {
    company_missing: 'Ajoutez le nom de l’entreprise',
    country_missing: 'Ajoutez le pays',
    email_missing: 'Ajoutez un e-mail',
    contact_missing: 'Ajoutez un e-mail ou un téléphone',
    country_unknown: 'Pays absent du CRM : {value}',
    email_invalid: 'Vérifiez l’e-mail : {value}',
    website_invalid: 'Vérifiez le site web : {value}',
    not_a_lead: 'Pas un lead (en-tête, total ou ligne vide)',
    unticked: 'Non cochée pour l’import',
    already_in_crm: 'Déjà dans le CRM sous {value}',
    no_contact_left_out: 'Exclue : ni e-mail ni téléphone',
    import_error: 'Import impossible : {value}',
    lead_not_found: 'Lead {value} introuvable ou pas le vôtre',
    company_not_found: 'Entreprise {value} introuvable ou pas la vôtre',
    company_mismatch: 'L’ID d’entreprise {value} ne correspond pas au lead (son entreprise est {crm})',
    update_conflict: '{field} : le CRM a {crm}, le fichier a {value} — mettez à jour sur la page du lead si c’est correct',
    industry_unknown: 'Secteur absent de la liste du CRM : {value} — mettez à jour sur la page du lead si c’est correct',
    lead_archived: 'Le lead {value} est archivé : désarchivez-le d’abord',
    update_contact_differs: '{field} : {value} non appliqué — le contact du fichier n’est pas celui du lead',
    update_company_differs: '{field} : {value} non appliqué — l’entreprise du fichier n’est pas celle du lead',
    update_ignored: '{field} : {value} non appliqué — une ligne avec ID d’entreprise ne met à jour que l’entreprise',
    update_verified: '{field} : {value} non appliqué — le champ est vérifié dans le CRM',
    update_not_applied: '{field} : {value} non appliqué — mettez à jour sur la page du lead si c’est correct',
  },
};

/** A row problem in plain words ("What to fix"), in `lang`. */
export function problemText(p: RowProblem, lang: Lang): string {
  const text = (PROBLEM_TEXT[lang] ?? PROBLEM_TEXT.en)[p.code] ?? p.code;
  // Replaced in one pass, so a value containing "{crm}" is never read as a placeholder.
  return text.replace(/\{(value|crm|field)\}/g, (_, k: string) =>
    k === 'value' ? p.value ?? '' : k === 'crm' ? p.crm ?? '' : p.field ? importColumnLabel(p.field, lang) : '');
}

/**
 * Column keys of the import tables and downloads. `leadId` / `companyId` (record ids), then the "Download all leads"
 * read-only context columns (ignored on upload) and the rows-to-fix lead page link.
 */
export type ImportColumnKey = ImportField | ImportIdField | 'from' | 'whatToFix' | 'status' | 'lead' | 'company'
  | 'assignedTo' | 'language' | 'leadType' | 'source' | 'leadPage';
/** "Download all leads" read-only columns: shown for context, ignored when the file comes back. */
export const EXPORT_CONTEXT_COLUMNS = ['status', 'assignedTo', 'language', 'leadType', 'source'] as const satisfies readonly ImportColumnKey[];

const COLUMN_LABELS: Record<Lang, Record<ImportColumnKey, string>> = {
  en: {
    companyName: 'Company', website: 'Website', country: 'Country', city: 'City', contactName: 'Contact',
    designation: 'Designation', email: 'Email', phone: 'Phone', industry: 'Industry', notes: 'Notes',
    from: 'From', whatToFix: 'What to fix', status: 'Status', lead: 'Lead', company: 'Company number',
    leadId: 'Lead ID', companyId: 'Company ID', assignedTo: 'Assigned to', language: 'Language', leadType: 'Lead type',
    source: 'Source', leadPage: 'Lead page',
  },
  es: {
    companyName: 'Empresa', website: 'Sitio web', country: 'País', city: 'Ciudad', contactName: 'Contacto',
    designation: 'Cargo', email: 'Correo electrónico', phone: 'Teléfono', industry: 'Sector', notes: 'Notas',
    from: 'Origen', whatToFix: 'Qué corregir', status: 'Estado', lead: 'Lead', company: 'Número de empresa',
    leadId: 'ID del lead', companyId: 'ID de empresa', assignedTo: 'Asignado a', language: 'Idioma', leadType: 'Tipo de lead',
    source: 'Fuente', leadPage: 'Página del lead',
  },
  fr: {
    companyName: 'Entreprise', website: 'Site web', country: 'Pays', city: 'Ville', contactName: 'Contact',
    designation: 'Fonction', email: 'E-mail', phone: 'Téléphone', industry: 'Secteur', notes: 'Notes',
    from: 'Origine', whatToFix: 'À corriger', status: 'Statut', lead: 'Lead', company: 'Numéro d’entreprise',
    leadId: 'ID du lead', companyId: 'ID de l’entreprise', assignedTo: 'Assigné à', language: 'Langue', leadType: 'Type de lead',
    source: 'Source', leadPage: 'Page du lead',
  },
};

/** A column header of the import tables and downloads, in `lang` (the header matcher knows all three). */
export function importColumnLabel(key: ImportColumnKey, lang: Lang): string {
  return (COLUMN_LABELS[lang] ?? COLUMN_LABELS.en)[key];
}

/**
 * Step 4 ("Review and import") totals for the current choices: rows that will be imported, the new companies they make
 * (distinct), rows going onto companies already in the CRM, the rows left out by reason, the rows with no email or phone
 * (Import them / Leave them out), rows whose country came only from research (Q2: not importable while "Accept" is
 * unticked) and the countries the CRM does not know yet.
 */
export type ReviewSummary = {
  willImport: number;
  newCompanies: number;
  existingCompanies: number;
  skipped: { total: number; alreadyInCrm: number; notLead: number; unticked: number; other: number };
  noContactRows: number;
  researchOnlyCountry: number;
  unknownCountries: { value: string; count: number }[];
  /**
   * Update rows (Lead ID / Company ID): `rows` that will fill `fields` empty fields, `conflicts` values that differ from
   * the CRM (not changed: listed in the rows-to-fix download), `errors` rows whose id is unknown, not visible or mismatched.
   */
  updates: { rows: number; fields: number; conflicts: number; errors: number };
};

/**
 * Why an import job gave up (`import_batches.import_error`; the batch is Failed and can be continued): `job_failed` = it
 * failed on every attempt, `interrupted` = the worker stopped during its last attempt.
 */
export const IMPORT_FAILURES = ['job_failed', 'interrupted'] as const;
export type ImportFailure = (typeof IMPORT_FAILURES)[number];

const IMPORT_FAILURE_TEXT: Record<Lang, Record<ImportFailure, string>> = {
  en: {
    job_failed: 'The import stopped after repeated errors. Continue it to import the remaining rows.',
    interrupted: 'The import was interrupted. Continue it to import the remaining rows.',
  },
  es: {
    job_failed: 'La importación se detuvo tras varios errores. Continúala para importar las filas restantes.',
    interrupted: 'La importación se interrumpió. Continúala para importar las filas restantes.',
  },
  fr: {
    job_failed: "L'import s'est arrêté après plusieurs erreurs. Reprenez-le pour importer les lignes restantes.",
    interrupted: "L'import a été interrompu. Reprenez-le pour importer les lignes restantes.",
  },
};

/** An import failure in `lang` (an unknown code reads as `job_failed`). */
export function importFailureText(code: string, lang: Lang): string {
  const t = IMPORT_FAILURE_TEXT[lang] ?? IMPORT_FAILURE_TEXT.en;
  return t[(IMPORT_FAILURES as readonly string[]).includes(code) ? (code as ImportFailure) : 'job_failed'];
}

/** How an imported lead's source reads: "Import · IMPORT-2026-11-24-2". */
export function importSource(number: string): string {
  return `Import · ${number}`;
}

/**
 * Why a file could not be read: the stable code stored in `import_files.error` (the screen shows it in the user's
 * language with `importFileErrorText`). `invalid` reads with the file's extension.
 */
export const IMPORT_FILE_ERRORS = [
  'invalid', 'too_large', 'password', 'old_doc', 'timeout', 'unreadable', 'interrupted', 'too_many_rows',
] as const;
export type ImportFileError = (typeof IMPORT_FILE_ERRORS)[number];

const FILE_ERROR_TEXT: Record<Lang, Record<ImportFileError, string>> = {
  en: {
    invalid: 'This file is not a valid .{ext} file',
    too_large: 'This file is too large to read',
    password: 'This file is password-protected',
    old_doc: "Old .doc files can't be read; save it as .docx",
    timeout: 'This file took too long to read',
    unreadable: 'Could not read this file',
    interrupted: 'Reading was interrupted; upload the file again',
    too_many_rows: 'This import would have more than 5,000 rows',
  },
  es: {
    invalid: 'Este archivo no es un archivo .{ext} válido',
    too_large: 'Este archivo es demasiado grande para leerlo',
    password: 'Este archivo está protegido con contraseña',
    old_doc: 'Los archivos .doc antiguos no se pueden leer; guárdalo como .docx',
    timeout: 'Este archivo tardó demasiado en leerse',
    unreadable: 'No se pudo leer este archivo',
    interrupted: 'La lectura se interrumpió; vuelve a subir el archivo',
    too_many_rows: 'Esta importación tendría más de 5.000 filas',
  },
  fr: {
    invalid: 'Ce fichier n’est pas un fichier .{ext} valide',
    too_large: 'Ce fichier est trop volumineux pour être lu',
    password: 'Ce fichier est protégé par un mot de passe',
    old_doc: 'Les anciens fichiers .doc ne peuvent pas être lus ; enregistrez-le au format .docx',
    timeout: 'La lecture de ce fichier a pris trop de temps',
    unreadable: 'Impossible de lire ce fichier',
    interrupted: 'La lecture a été interrompue ; importez à nouveau le fichier',
    too_many_rows: 'Cette importation dépasserait 5 000 lignes',
  },
};

/** A stored file error code in plain words, in `lang`; an unknown value reads as "Could not read this file". */
export function importFileErrorText(code: string, ext: string, lang: Lang): string {
  const texts = FILE_ERROR_TEXT[lang] ?? FILE_ERROR_TEXT.en;
  const known = (IMPORT_FILE_ERRORS as readonly string[]).includes(code) ? (code as ImportFileError) : 'unreadable';
  return texts[known].replace('{ext}', ext);
}

/** Why a document was read (in part) without Claude: switched off, the monthly run cap reached, or the per-file limit. */
export const IMPORT_NO_CLAUDE = ['off', 'cap', 'limit'] as const;
export type ImportNoClaude = (typeof IMPORT_NO_CLAUDE)[number];

const NO_CLAUDE_TEXT: Record<Lang, Record<ImportNoClaude, string>> = {
  en: {
    off: 'Read without Claude (Claude is switched off)',
    cap: 'Part read without Claude: this month\'s Claude runs are used up',
    limit: 'Long document: part read without Claude',
  },
  es: {
    off: 'Leído sin Claude (Claude está desactivado)',
    cap: 'Parte leída sin Claude: se agotaron los usos de Claude de este mes',
    limit: 'Documento largo: parte leída sin Claude',
  },
  fr: {
    off: 'Lu sans Claude (Claude est désactivé)',
    cap: 'Lu en partie sans Claude : les utilisations de Claude de ce mois sont épuisées',
    limit: 'Document long : lu en partie sans Claude',
  },
};

/** A file's `noClaude` in plain words, in `lang`. */
export function importNoClaudeText(code: ImportNoClaude, lang: Lang): string {
  return (NO_CLAUDE_TEXT[lang] ?? NO_CLAUDE_TEXT.en)[code];
}

/** A batch number: IMPORT-YYYY-MM-DD, then -2, -3 … for later batches the same day. */
export const BATCH_NUMBER_RE = /^IMPORT-\d{4}-\d{2}-\d{2}(-\d+)?$/i;

// ---------------------------------------------------------------------------------------------------------------
// Step 3 (AI research): what is stored is data; these render it in the reader's language.

/** Why a row's Claude call gave nothing: `ClaudeRunError.kind`, or an answer that did not fit the schema. */
export const RESEARCH_CLAUDE_FAILURES = ['not_logged_in', 'failed', 'timeout', 'unexpected'] as const;
export type ResearchClaudeFailure = (typeof RESEARCH_CLAUDE_FAILURES)[number];

/**
 * One part of `ImportRow.researchNote` (stored as a list, rendered with `importResearchNoteText`). `readError` carries
 * the website reader's own message (English, as release 4 shows it).
 */
export type ResearchNotePart =
  | { k: 'foundBySearch' }
  | { k: 'pagesRead'; n: number }
  | { k: 'readError'; error: string }
  | { k: 'claude'; kind: ResearchClaudeFailure }
  | { k: 'capReached' }
  | { k: 'filled'; n: number }
  | { k: 'noWebsite' }
  | { k: 'nothingToLookUp' }
  | { k: 'nothingFound' }
  | { k: 'researchFailed' };

/** `ImportBatch.researchEngine`: the website reader, plus Claude Code with this model when `claude` is set. */
export type ResearchEngine = { claude: string | null };

/** One `ImportBatch.activity` entry (newest first, at most 50). */
export type ImportActivity =
  | { at: string; code: 'started'; params: { n: number; engine: ResearchEngine } }
  | { at: string; code: 'row'; params: { name: string; note: ResearchNotePart[] } }
  | { at: string; code: 'finished' | 'capStopped' | 'paused' | 'resumed' };
export type ImportActivityCode = ImportActivity['code'];

type NoteTexts = {
  foundBySearch: string; pagesRead: (n: number) => string; readError: (e: string) => string;
  claude: Record<ResearchClaudeFailure, string>; capReached: string; filled: (n: number) => string;
  noWebsite: string; nothingToLookUp: string; nothingFound: string; researchFailed: string;
};

const NOTE_TEXT: Record<Lang, NoteTexts> = {
  en: {
    foundBySearch: 'website found by search',
    pagesRead: (n) => `${n} ${n === 1 ? 'page' : 'pages'} read`,
    readError: (e) => `could not read the website (${e})`,
    claude: {
      not_logged_in: 'Claude Code is not logged in on the server', failed: 'Claude Code failed', timeout: 'Claude took too long',
      unexpected: 'Claude returned an unexpected answer',
    },
    capReached: "Claude's monthly run cap is reached",
    filled: (n) => `${n} ${n === 1 ? 'field' : 'fields'} filled`,
    noWebsite: 'No website to read',
    nothingToLookUp: 'Nothing to look up',
    nothingFound: 'nothing found',
    researchFailed: 'Research failed',
  },
  es: {
    foundBySearch: 'sitio web encontrado por búsqueda',
    pagesRead: (n) => `${n} ${n === 1 ? 'página leída' : 'páginas leídas'}`,
    readError: (e) => `no se pudo leer el sitio web (${e})`,
    claude: {
      not_logged_in: 'Claude Code no tiene la sesión iniciada en el servidor', failed: 'Claude Code falló',
      timeout: 'Claude tardó demasiado', unexpected: 'Claude dio una respuesta inesperada',
    },
    capReached: 'se alcanzó el límite mensual de usos de Claude',
    filled: (n) => `${n} ${n === 1 ? 'campo completado' : 'campos completados'}`,
    noWebsite: 'No hay sitio web que leer',
    nothingToLookUp: 'Nada que buscar',
    nothingFound: 'no se encontró nada',
    researchFailed: 'La investigación falló',
  },
  fr: {
    foundBySearch: 'site web trouvé par recherche',
    pagesRead: (n) => `${n} ${n === 1 ? 'page lue' : 'pages lues'}`,
    readError: (e) => `impossible de lire le site web (${e})`,
    claude: {
      not_logged_in: 'Claude Code n’est pas connecté sur le serveur', failed: 'Claude Code a échoué',
      timeout: 'Claude a mis trop de temps', unexpected: 'Claude a donné une réponse inattendue',
    },
    capReached: 'le plafond mensuel d’utilisations de Claude est atteint',
    filled: (n) => `${n} ${n === 1 ? 'champ rempli' : 'champs remplis'}`,
    noWebsite: 'Aucun site web à lire',
    nothingToLookUp: 'Rien à rechercher',
    nothingFound: 'rien trouvé',
    researchFailed: 'La recherche a échoué',
  },
};

/** A row's research note in `lang` ("website found by search, 3 pages read, 3 fields filled"); unknown parts are skipped. */
export function importResearchNoteText(parts: readonly ResearchNotePart[] | null | undefined, lang: Lang): string {
  const t = NOTE_TEXT[lang] ?? NOTE_TEXT.en;
  const out: string[] = [];
  const list: readonly ResearchNotePart[] = Array.isArray(parts) ? parts : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    switch (p.k) {
      case 'foundBySearch': out.push(t.foundBySearch); break;
      case 'pagesRead': out.push(t.pagesRead(p.n)); break;
      case 'readError': out.push(t.readError(p.error)); break;
      case 'claude': out.push(t.claude[p.kind] ?? t.claude.failed); break;
      case 'capReached': out.push(t.capReached); break;
      case 'filled': out.push(t.filled(p.n)); break;
      case 'noWebsite': out.push(t.noWebsite); break;
      case 'nothingToLookUp': out.push(t.nothingToLookUp); break;
      case 'nothingFound': out.push(t.nothingFound); break;
      case 'researchFailed': out.push(t.researchFailed); break;
      default: break;
    }
  }
  return out.join(', ');
}

const ENGINE_TEXT: Record<Lang, { reader: string; claude: (model: string) => string }> = {
  en: { reader: 'Website reader', claude: (m) => `Website reader + Claude Code ${m}` },
  es: { reader: 'Lector de sitios web', claude: (m) => `Lector de sitios web + Claude Code ${m}` },
  fr: { reader: 'Lecteur de sites web', claude: (m) => `Lecteur de sites web + Claude Code ${m}` },
};

/** The research engine in `lang`: "Website reader" or "Website reader + Claude Code sonnet". */
export function importEngineText(engine: ResearchEngine | null | undefined, lang: Lang): string {
  const t = ENGINE_TEXT[lang] ?? ENGINE_TEXT.en;
  return engine?.claude ? t.claude(engine.claude) : t.reader;
}

const ACTIVITY_TEXT: Record<Lang, {
  started: (n: number, engine: string) => string; finished: string; capStopped: string; paused: string; resumed: string;
}> = {
  en: {
    started: (n, e) => `Started research for ${n} ${n === 1 ? 'row' : 'rows'} · ${e}`,
    finished: 'Research finished',
    capStopped: "Claude's monthly run cap is reached; research stopped",
    paused: 'Research paused',
    resumed: 'Research resumed',
  },
  es: {
    started: (n, e) => `Investigación iniciada para ${n} ${n === 1 ? 'fila' : 'filas'} · ${e}`,
    finished: 'Investigación terminada',
    capStopped: 'Se alcanzó el límite mensual de usos de Claude; la investigación se detuvo',
    paused: 'Investigación en pausa',
    resumed: 'Investigación reanudada',
  },
  fr: {
    started: (n, e) => `Recherche lancée pour ${n} ${n === 1 ? 'ligne' : 'lignes'} · ${e}`,
    finished: 'Recherche terminée',
    capStopped: 'Le plafond mensuel d’utilisations de Claude est atteint ; la recherche est arrêtée',
    paused: 'Recherche en pause',
    resumed: 'Recherche reprise',
  },
};

/** One activity line in `lang` ("Fixture Freight — 1 page read, 2 fields filled"); an unknown entry reads as ''. */
export function importActivityText(entry: ImportActivity, lang: Lang): string {
  const t = ACTIVITY_TEXT[lang] ?? ACTIVITY_TEXT.en;
  if (!entry || typeof entry !== 'object') return '';
  switch (entry.code) {
    case 'started': return t.started(entry.params.n, importEngineText(entry.params.engine, lang));
    case 'row': return `${entry.params.name} — ${importResearchNoteText(entry.params.note, lang)}`;
    case 'finished': return t.finished;
    case 'capStopped': return t.capStopped;
    case 'paused': return t.paused;
    case 'resumed': return t.resumed;
    default: return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Data manager: Undo (Administrators, `undo_imports`) and the copy around a long import.

/** Why Undo keeps a record the batch created (someone worked on it, or it holds records Undo must not remove). */
/**
 * Why Undo keeps a record. `activity` is one neutral reason for emails, notes, tasks, calendar events and research, so
 * an Administrator's preview never shows that someone emailed a lead or contact (mail is private to its owner).
 */
export const UNDO_REASONS = [
  'edited', 'status', 'activity', 'quotations', 'projects', 'mailer', 'reassigned', 'other_leads', 'other_contacts',
] as const;
export type UndoReason = (typeof UNDO_REASONS)[number];

/**
 * What Undo removes and keeps (`GET /imports/batches/:id/undo` lists it first; `POST` does it and saves it as
 * `ImportBatch.undo`). `reverted`: CRM companies that existed before the batch whose research values the import
 * accepted (and AI industry it wrote) go back, untouched since.
 */
export type UndoPreview = {
  remove: { leads: { id: number; number: string }[]; contacts: number; companies: number };
  keep: { kind: 'lead' | 'contact' | 'company'; id: number; label: string; reason: UndoReason }[];
  reverted?: { id: number; label: string }[];
  /** Update rows: blanks the batch filled that go back to empty (`revert`), and those changed since (`keep`). */
  filled?: { revert: number; keep: number };
};

const UNDO_REASON_TEXT: Record<Lang, Record<UndoReason, string>> = {
  en: {
    edited: 'Edited after the import', status: 'Status changed', activity: 'Has activity',
    quotations: 'Has quotations', projects: 'Has projects', mailer: 'In a Mailer campaign', reassigned: 'Reassigned', other_leads: 'Linked to leads that stay',
    other_contacts: 'Has contacts that stay',
  },
  es: {
    edited: 'Editado después de la importación', status: 'Estado cambiado', activity: 'Tiene actividad',
    quotations: 'Tiene cotizaciones', projects: 'Tiene proyectos', mailer: 'En una campaña de Mailer', reassigned: 'Reasignado',
    other_leads: 'Vinculado a leads que se quedan', other_contacts: 'Tiene contactos que se quedan',
  },
  fr: {
    edited: 'Modifié après l’import', status: 'Statut modifié', activity: 'A de l’activité',
    quotations: 'A des devis', projects: 'A des projets', mailer: 'Dans une campagne Mailer', reassigned: 'Réattribué', other_leads: 'Lié à des leads conservés',
    other_contacts: 'A des contacts conservés',
  },
};

/** The detailed reasons of earlier builds, now all `activity`. */
const ACTIVITY_REASONS = new Set(['emails', 'notes', 'tasks', 'calendar']);

/** Why Undo keeps a record, in `lang` (an unknown reason reads as `edited`). */
export function undoReasonText(reason: string, lang: Lang): string {
  const t = UNDO_REASON_TEXT[lang] ?? UNDO_REASON_TEXT.en;
  const r = ACTIVITY_REASONS.has(reason) ? 'activity' : reason;
  return t[(UNDO_REASONS as readonly string[]).includes(r) ? (r as UndoReason) : 'edited'];
}

const CONTINUE_HINT_TEXT: Record<Lang, string> = {
  en: 'A long import can be stopped by a deploy or a restart of the server. If an import shows Failed, use Continue: it imports only the rows that are not in the CRM yet.',
  es: 'Un despliegue o un reinicio del servidor puede detener una importación larga. Si una importación aparece como Fallida, usa Continuar: solo importa las filas que aún no están en el CRM.',
  fr: 'Un déploiement ou un redémarrage du serveur peut arrêter un import long. Si un import est en échec, utilisez Reprendre : seules les lignes absentes du CRM sont importées.',
};

/** Data manager copy: a deploy or restart during a long import may need "Continue" (Task 6 R5), in `lang`. */
export function importContinueHintText(lang: Lang): string {
  return CONTINUE_HINT_TEXT[lang] ?? CONTINUE_HINT_TEXT.en;
}

/** What a staged row became at import (`ImportRow.outcome`). */
export const ROW_OUTCOMES = ['Imported', 'Updated', 'Skipped', 'Error'] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];

const ROW_STATUS_TEXT: Record<Lang, Record<RowStatus | RowOutcome, string>> = {
  en: {
    Ready: 'Ready', 'Missing details': 'Missing details', 'Already in CRM': 'Already in CRM', 'Not a lead': 'Not a lead',
    Update: 'Update', Imported: 'Imported', Updated: 'Updated', Skipped: 'Skipped', Error: 'Error',
  },
  es: {
    Ready: 'Lista', 'Missing details': 'Faltan datos', 'Already in CRM': 'Ya está en el CRM', 'Not a lead': 'No es un lead',
    Update: 'Actualización', Imported: 'Importada', Updated: 'Actualizada', Skipped: 'Omitida', Error: 'Error',
  },
  fr: {
    Ready: 'Prête', 'Missing details': 'Informations manquantes', 'Already in CRM': 'Déjà dans le CRM', 'Not a lead': 'Pas un lead',
    Update: 'À mettre à jour', Imported: 'Importée', Updated: 'Mise à jour', Skipped: 'Ignorée', Error: 'Erreur',
  },
};

/** A row's status or outcome in `lang` (an unknown value is returned as it is). */
export function importRowStatusText(status: string, lang: Lang): string {
  const t = ROW_STATUS_TEXT[lang] ?? ROW_STATUS_TEXT.en;
  return (t as Record<string, string>)[status] ?? status;
}

/**
 * What `import_rows.error` holds when a row could not be imported: a rule code (`invalid_status` …) or one of the
 * import's fixed English messages. Any other stored text (a field check, "contactId: …") is shown as it is.
 */
export const IMPORT_ROW_ERRORS = [
  'invalid_status', 'unknown_user', 'cannot_assign_hidden', 'forbidden', 'Not found', 'Domain already belongs to another company',
  'Unexpected error importing this row', 'lead_not_found', 'company_not_found', 'company_mismatch', 'lead_archived',
] as const;
export type ImportRowError = (typeof IMPORT_ROW_ERRORS)[number];

const ROW_ERROR_TEXT: Record<Lang, Record<ImportRowError, string>> = {
  en: {
    invalid_status: 'The lead status is not available', unknown_user: 'The assignee is not an active user',
    cannot_assign_hidden: 'The lead cannot be assigned to that person', forbidden: 'The importer does not have access',
    'Not found': 'A record it needs was not found', 'Domain already belongs to another company': 'The website domain already belongs to another company',
    'Unexpected error importing this row': 'Unexpected error importing this row',
    lead_not_found: 'The Lead ID is not in the CRM or not yours', company_not_found: 'The Company ID is not in the CRM or not yours',
    company_mismatch: 'The Company ID does not match the lead', lead_archived: 'The lead is archived (unarchive it first)',
  },
  es: {
    invalid_status: 'El estado del lead no está disponible', unknown_user: 'La persona asignada no es un usuario activo',
    cannot_assign_hidden: 'El lead no se puede asignar a esa persona', forbidden: 'Quien importa no tiene acceso',
    'Not found': 'No se encontró un registro necesario', 'Domain already belongs to another company': 'El dominio del sitio web ya pertenece a otra empresa',
    'Unexpected error importing this row': 'Error inesperado al importar esta fila',
    lead_not_found: 'El ID del lead no está en el CRM o no es tuyo', company_not_found: 'El ID de empresa no está en el CRM o no es tuyo',
    company_mismatch: 'El ID de empresa no coincide con el lead', lead_archived: 'El lead está archivado (desarchívalo primero)',
  },
  fr: {
    invalid_status: 'Le statut du lead n’est pas disponible', unknown_user: 'La personne assignée n’est pas un utilisateur actif',
    cannot_assign_hidden: 'Le lead ne peut pas être attribué à cette personne', forbidden: 'La personne qui importe n’a pas accès',
    'Not found': 'Un enregistrement nécessaire est introuvable', 'Domain already belongs to another company': 'Ce domaine appartient déjà à une autre entreprise',
    'Unexpected error importing this row': 'Erreur inattendue lors de l’import de cette ligne',
    lead_not_found: 'L’ID du lead n’est pas dans le CRM ou pas le vôtre', company_not_found: 'L’ID d’entreprise n’est pas dans le CRM ou pas le vôtre',
    company_mismatch: 'L’ID d’entreprise ne correspond pas au lead', lead_archived: 'Le lead est archivé (désarchivez-le d’abord)',
  },
};

/** Why a row could not be imported, in `lang`: a known code or message is translated, any other text shown as it is. */
export function importRowErrorText(error: string | null | undefined, lang: Lang): string {
  if (!error) return '';
  const t = ROW_ERROR_TEXT[lang] ?? ROW_ERROR_TEXT.en;
  return (IMPORT_ROW_ERRORS as readonly string[]).includes(error) ? t[error as ImportRowError] : error;
}
