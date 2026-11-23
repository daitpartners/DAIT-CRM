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
};

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
