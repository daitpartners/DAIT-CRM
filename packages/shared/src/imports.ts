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
/** The step-2 table columns, in the mockup's order (every field but notes). */
export const IMPORT_TABLE_FIELDS = IMPORT_FIELDS.slice(0, 9) as readonly Exclude<ImportField, 'notes'>[];

/** `ImportBatch.status`. */
export const BATCH_STATUSES = [
  'Uploading', 'Sorting', 'Waiting for review', 'Researching', 'Importing', 'Imported', 'Undone', 'Failed',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** `ImportRow.status`, decided on the row's own fields ("Ready" = company + country + email). */
export const ROW_STATUSES = ['Ready', 'Missing details', 'Already in CRM', 'Not a lead'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

/** `ImportFile.status`; "Scan" = an image-only PDF (not read: no OCR). */
export const FILE_STATUSES = ['Reading', 'Read', 'Scan', 'Failed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** `ImportRow.researchStatus`: everything / some / nothing = what research found for the row's missing fields. */
export const RESEARCH_ROW_STATUSES = ['waiting', 'running', 'everything', 'some', 'nothing', 'failed'] as const;
export type ResearchRowStatus = (typeof RESEARCH_ROW_STATUSES)[number];

export type RowFields = Partial<Record<ImportField, string>>;
/** A value research found for one field: never without the page it came from and how sure it is (0–100). */
export type ResearchValue = { value: string; sourceUrl: string; sourceLabel: string; confidence: number };

export const PROBLEM_CODES = [
  'company_missing', 'country_missing', 'email_missing', 'contact_missing', 'country_unknown', 'email_invalid',
  'website_invalid', 'not_a_lead', 'unticked', 'already_in_crm', 'no_contact_left_out', 'import_error',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
/** `level`: missing = red cell (required), questionable = amber cell (unknown or doubtful value), info = no cell colour. */
export type RowProblem = { code: ProblemCode; field?: ImportField; level: 'missing' | 'questionable' | 'info'; value?: string };

/** `ImportFile.meta`: what the file list says about a read file; `noClaude` = read without Claude (switched off / cap). */
export type FileMeta = {
  sheets?: number; rows?: number; pages?: number; lines?: number; textFound?: boolean; noClaude?: 'off' | 'cap';
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
  },
};

/** A row problem in plain words ("What to fix"), in `lang`. */
export function problemText(p: RowProblem, lang: Lang): string {
  const text = (PROBLEM_TEXT[lang] ?? PROBLEM_TEXT.en)[p.code];
  return text.replace('{value}', p.value ?? '');
}

export type ImportColumnKey = ImportField | 'from' | 'whatToFix' | 'status' | 'lead' | 'company';

const COLUMN_LABELS: Record<Lang, Record<ImportColumnKey, string>> = {
  en: {
    companyName: 'Company', website: 'Website', country: 'Country', city: 'City', contactName: 'Contact',
    designation: 'Designation', email: 'Email', phone: 'Phone', industry: 'Industry', notes: 'Notes',
    from: 'From', whatToFix: 'What to fix', status: 'Status', lead: 'Lead', company: 'Company number',
  },
  es: {
    companyName: 'Empresa', website: 'Sitio web', country: 'País', city: 'Ciudad', contactName: 'Contacto',
    designation: 'Cargo', email: 'Correo electrónico', phone: 'Teléfono', industry: 'Sector', notes: 'Notas',
    from: 'Origen', whatToFix: 'Qué corregir', status: 'Estado', lead: 'Lead', company: 'Número de empresa',
  },
  fr: {
    companyName: 'Entreprise', website: 'Site web', country: 'Pays', city: 'Ville', contactName: 'Contact',
    designation: 'Fonction', email: 'E-mail', phone: 'Téléphone', industry: 'Secteur', notes: 'Notes',
    from: 'Origine', whatToFix: 'À corriger', status: 'Statut', lead: 'Lead', company: 'Numéro d’entreprise',
  },
};

/** A column header of the import tables and downloads, in `lang` (the header matcher knows all three). */
export function importColumnLabel(key: ImportColumnKey, lang: Lang): string {
  return (COLUMN_LABELS[lang] ?? COLUMN_LABELS.en)[key];
}

/** How an imported lead's source reads: "Import · IMPORT-2026-11-24-2". */
export function importSource(number: string): string {
  return `Import · ${number}`;
}

/** A batch number: IMPORT-YYYY-MM-DD, then -2, -3 … for later batches the same day. */
export const BATCH_NUMBER_RE = /^IMPORT-\d{4}-\d{2}-\d{2}(-\d+)?$/i;
