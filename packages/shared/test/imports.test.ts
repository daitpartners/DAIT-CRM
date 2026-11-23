import { describe, expect, test } from 'vitest';
import {
  BATCH_NUMBER_RE, IMPORT_FILE_ERRORS, IMPORT_FIELDS, IMPORT_NO_CLAUDE, importNoClaudeText, IMPORT_TABLE_FIELDS, PROBLEM_CODES, importColumnLabel, importFileErrorText, importSource, problemText,
  importActivityText, importEngineText, importResearchNoteText, RESEARCH_CLAUDE_FAILURES,
  type ImportActivity, type ResearchNotePart, type RowProblem,
} from '../src/imports';
import {
  ImportBatchCreate, ImportBatchListQuery, ImportBatchUpdate, ImportColumnAnswer, ImportCommit, ImportIncludeAll,
  ImportRowUpdate, ImportRowsQuery,
} from '../src/schemas/imports';
import type { Lang } from '../src/i18n';

const LANGS: Lang[] = ['en', 'es', 'fr'];
const LABEL_KEYS = [...IMPORT_FIELDS, 'from', 'whatToFix', 'status', 'lead', 'company'] as const;

describe('import constants', () => {
  test('the step-2 columns are the first nine fields', () => {
    expect(IMPORT_TABLE_FIELDS).toEqual(IMPORT_FIELDS.slice(0, 9));
    expect(IMPORT_TABLE_FIELDS).not.toContain('notes');
  });

  test('batch numbers and the lead source text', () => {
    expect(BATCH_NUMBER_RE.test('IMPORT-2026-11-24')).toBe(true);
    expect(BATCH_NUMBER_RE.test('IMPORT-2026-11-24-2')).toBe(true);
    expect(BATCH_NUMBER_RE.test('IMPORT-2026-11-24-')).toBe(false);
    expect(BATCH_NUMBER_RE.test('CSV-20261124-1000')).toBe(false);
    expect(importSource('IMPORT-2026-11-24-2')).toBe('Import · IMPORT-2026-11-24-2');
  });
});

describe('problemText', () => {
  test('plain words, with the value where there is one', () => {
    expect(problemText({ code: 'country_unknown', field: 'country', level: 'questionable', value: 'Chile' }, 'en'))
      .toBe('Country not in the CRM: Chile');
    expect(problemText({ code: 'email_missing', field: 'email', level: 'missing' }, 'en')).toBe('Add an email');
    expect(problemText({ code: 'contact_missing', level: 'missing' }, 'en')).toBe('Add an email or phone');
    expect(problemText({ code: 'already_in_crm', level: 'info', value: 'CO-0211' }, 'en')).toBe('Already in the CRM as CO-0211');
  });

  test('every code has an en, es and fr text', () => {
    for (const code of PROBLEM_CODES) {
      const p: RowProblem = { code, level: 'missing', value: 'X' };
      for (const lang of LANGS) expect(problemText(p, lang), `${code} ${lang}`).not.toBe('');
      expect(problemText(p, 'es'), code).not.toBe(problemText(p, 'en'));
      expect(problemText(p, 'fr'), code).not.toBe(problemText(p, 'en'));
    }
  });
});

describe('importNoClaudeText', () => {
  test('why a document was read without Claude, in en, es and fr', () => {
    for (const lang of LANGS) {
      expect(new Set(IMPORT_NO_CLAUDE.map((c) => importNoClaudeText(c, lang))).size).toBe(IMPORT_NO_CLAUDE.length);
    }
    expect(importNoClaudeText('limit', 'en')).toBe('Long document: part read without Claude');
    expect(importNoClaudeText('limit', 'es')).toBe('Documento largo: parte leída sin Claude');
    expect(importNoClaudeText('limit', 'fr')).toBe('Document long : lu en partie sans Claude');
  });
});

describe('importFileErrorText', () => {
  test('every stored file error code reads in en, es and fr', () => {
    for (const lang of LANGS) {
      for (const code of IMPORT_FILE_ERRORS) expect(importFileErrorText(code, 'pdf', lang)).toMatch(/\S/);
    }
    expect(new Set(IMPORT_FILE_ERRORS.map((c) => importFileErrorText(c, 'pdf', 'es'))).size).toBe(IMPORT_FILE_ERRORS.length);
  });

  test('the English texts, with the extension for an invalid file', () => {
    expect(importFileErrorText('invalid', 'xlsx', 'en')).toBe('This file is not a valid .xlsx file');
    expect(importFileErrorText('too_large', 'pdf', 'en')).toBe('This file is too large to read');
    expect(importFileErrorText('password', 'pdf', 'en')).toBe('This file is password-protected');
    expect(importFileErrorText('old_doc', 'docx', 'en')).toBe("Old .doc files can't be read; save it as .docx");
    expect(importFileErrorText('unreadable', 'csv', 'en')).toBe('Could not read this file');
    expect(importFileErrorText('interrupted', 'csv', 'en')).toBe('Reading was interrupted; upload the file again');
    expect(importFileErrorText('too_many_rows', 'xlsx', 'en')).toBe('This import would have more than 5,000 rows');
    expect(importFileErrorText('invalid', 'docx', 'fr')).toContain('.docx');
    expect(importFileErrorText('invalid', 'xls', 'es')).toContain('.xls');
  });

  test('an unknown stored value falls back to "Could not read this file"', () => {
    expect(importFileErrorText('something else', 'pdf', 'en')).toBe('Could not read this file');
  });
});

describe('importColumnLabel', () => {
  test('every key has an en, es and fr label', () => {
    for (const key of LABEL_KEYS) for (const lang of LANGS) expect(importColumnLabel(key, lang), `${key} ${lang}`).not.toBe('');
    expect(importColumnLabel('whatToFix', 'en')).toBe('What to fix');
    expect(importColumnLabel('from', 'en')).toBe('From');
    expect(importColumnLabel('company', 'en')).toBe('Company number');
    expect(importColumnLabel('companyName', 'en')).toBe('Company');
    for (const lang of ['es', 'fr'] as const) {
      expect(importColumnLabel('whatToFix', lang)).not.toBe('What to fix');
      expect(importColumnLabel('from', lang)).not.toBe('From');
    }
  });

  test('the fixed es / fr labels', () => {
    expect(importColumnLabel('whatToFix', 'es')).toBe('Qué corregir');
    expect(importColumnLabel('whatToFix', 'fr')).toBe('À corriger');
    expect(importColumnLabel('from', 'es')).toBe('Origen');
    expect(importColumnLabel('from', 'fr')).toBe('Origine');
  });
});

describe('import schemas', () => {
  test('a batch needs a language and a type (no defaults)', () => {
    const empty = ImportBatchCreate.safeParse({});
    expect(empty.success).toBe(false);
    const paths = empty.error!.issues.map((i) => i.path[0]);
    expect(paths).toEqual(expect.arrayContaining(['language', 'leadType']));
    expect(ImportBatchCreate.safeParse({ language: 'en', leadType: 'Prospect' }).success).toBe(true);
    expect(ImportBatchCreate.safeParse({ language: 'fr', leadType: 'Prospect' }).success).toBe(false);
  });

  test('a batch update changes at least one of the two', () => {
    expect(ImportBatchUpdate.safeParse({}).success).toBe(false);
    expect(ImportBatchUpdate.safeParse({ leadType: 'Lead' }).success).toBe(true);
  });

  test('a row update is a field with its value, or include', () => {
    expect(ImportRowUpdate.safeParse({ field: 'email', value: '  a@b.com ' })).toMatchObject({ success: true, data: { value: 'a@b.com' } });
    expect(ImportRowUpdate.safeParse({ include: false }).success).toBe(true);
    expect(ImportRowUpdate.safeParse({ field: 'email' }).success).toBe(false);
    expect(ImportRowUpdate.safeParse({ value: 'x' }).success).toBe(false);
    expect(ImportRowUpdate.safeParse({}).success).toBe(false);
    expect(ImportRowUpdate.safeParse({ field: 'email', value: 'x'.repeat(501) }).success).toBe(false);
    expect(ImportRowUpdate.safeParse({ field: 'owner', value: 'x' }).success).toBe(false);
  });

  test('include all, column answers and paging queries', () => {
    expect(ImportIncludeAll.safeParse({ filter: 'missing', include: true }).success).toBe(true);
    expect(ImportIncludeAll.safeParse({ filter: 'imported', include: true }).success).toBe(false);
    expect(ImportColumnAnswer.safeParse({ sheet: 'Sheet1', col: 0, field: 'skip' }).success).toBe(true);
    expect(ImportColumnAnswer.safeParse({ sheet: 'Sheet1', col: -1, field: 'email' }).success).toBe(false);
    expect(ImportRowsQuery.parse({})).toMatchObject({ filter: 'all', pageSize: 100, page: 1 });
    expect(ImportRowsQuery.safeParse({ filter: 'errors' }).success).toBe(true);
    expect(ImportBatchListQuery.safeParse({ language: 'es', status: 'Imported' }).success).toBe(true);
    expect(ImportBatchListQuery.safeParse({ status: 'Done' }).success).toBe(false);
  });

  test('commit: noContactRows must be given and may be null', () => {
    expect(ImportCommit.safeParse({ acceptHigh: false, notify: false }).success).toBe(false);
    expect(ImportCommit.safeParse({ acceptHigh: false, noContactRows: null, notify: false }).success).toBe(true);
    expect(ImportCommit.safeParse({ acceptHigh: true, noContactRows: 'leave', notify: true }).success).toBe(true);
    expect(ImportCommit.safeParse({ noContactRows: 'import', notify: true }).success).toBe(false);
  });
});

describe('research notes, engine and activity (step 3)', () => {
  const note: ResearchNotePart[] = [{ k: 'foundBySearch' }, { k: 'pagesRead', n: 3 }, { k: 'filled', n: 3 }];

  test('a row note in each language', () => {
    expect(importResearchNoteText(note, 'en')).toBe('website found by search, 3 pages read, 3 fields filled');
    expect(importResearchNoteText(note, 'es')).toBe('sitio web encontrado por búsqueda, 3 páginas leídas, 3 campos completados');
    expect(importResearchNoteText(note, 'fr')).toBe('site web trouvé par recherche, 3 pages lues, 3 champs remplis');
    expect(importResearchNoteText([{ k: 'pagesRead', n: 1 }, { k: 'filled', n: 1 }], 'en')).toBe('1 page read, 1 field filled');
    expect(importResearchNoteText([{ k: 'pagesRead', n: 1 }, { k: 'filled', n: 1 }], 'es')).toBe('1 página leída, 1 campo completado');
    expect(importResearchNoteText([{ k: 'pagesRead', n: 1 }, { k: 'filled', n: 1 }], 'fr')).toBe('1 page lue, 1 champ rempli');
    expect(importResearchNoteText([{ k: 'noWebsite' }], 'en')).toBe('No website to read');
    expect(importResearchNoteText([{ k: 'noWebsite' }], 'es')).toBe('No hay sitio web que leer');
    expect(importResearchNoteText([{ k: 'noWebsite' }], 'fr')).toBe('Aucun site web à lire');
    expect(importResearchNoteText([{ k: 'readError', error: 'Timeout fetching site' }, { k: 'capReached' }], 'en'))
      .toBe("could not read the website (Timeout fetching site), Claude's monthly run cap is reached");
    expect(importResearchNoteText(null, 'en')).toBe('');
  });

  test('every part and Claude failure has text in every language', () => {
    const all: ResearchNotePart[] = [
      { k: 'foundBySearch' }, { k: 'pagesRead', n: 2 }, { k: 'readError', error: 'x' }, { k: 'capReached' }, { k: 'filled', n: 2 },
      { k: 'noWebsite' }, { k: 'nothingToLookUp' }, { k: 'nothingFound' }, { k: 'researchFailed' },
      ...RESEARCH_CLAUDE_FAILURES.map((kind) => ({ k: 'claude', kind }) as ResearchNotePart),
    ];
    for (const lang of LANGS) {
      for (const p of all) expect(importResearchNoteText([p], lang)).not.toBe('');
    }
    expect(importResearchNoteText([{ k: 'claude', kind: 'timeout' }], 'en')).toBe('Claude took too long');
    expect(importResearchNoteText([{ k: 'claude', kind: 'timeout' }], 'es')).toBe('Claude tardó demasiado');
    expect(importResearchNoteText([{ k: 'claude', kind: 'timeout' }], 'fr')).toBe('Claude a mis trop de temps');
  });

  test('the engine in each language', () => {
    expect(importEngineText({ claude: null }, 'en')).toBe('Website reader');
    expect(importEngineText({ claude: 'sonnet' }, 'en')).toBe('Website reader + Claude Code sonnet');
    expect(importEngineText({ claude: 'sonnet' }, 'es')).toBe('Lector de sitios web + Claude Code sonnet');
    expect(importEngineText({ claude: null }, 'fr')).toBe('Lecteur de sites web');
    expect(importEngineText(null, 'en')).toBe('Website reader');
  });

  test('activity lines in each language', () => {
    const at = '2026-11-24T10:00:00.000Z';
    const started: ImportActivity = { at, code: 'started', params: { n: 2, engine: { claude: 'sonnet' } } };
    const row: ImportActivity = { at, code: 'row', params: { name: 'Fixture Freight', note: [{ k: 'pagesRead', n: 1 }, { k: 'filled', n: 2 }] } };
    expect(importActivityText(started, 'en')).toBe('Started research for 2 rows · Website reader + Claude Code sonnet');
    expect(importActivityText(started, 'es')).toBe('Investigación iniciada para 2 filas · Lector de sitios web + Claude Code sonnet');
    expect(importActivityText(started, 'fr')).toBe('Recherche lancée pour 2 lignes · Lecteur de sites web + Claude Code sonnet');
    expect(importActivityText(row, 'en')).toBe('Fixture Freight — 1 page read, 2 fields filled');
    expect(importActivityText(row, 'es')).toBe('Fixture Freight — 1 página leída, 2 campos completados');
    expect(importActivityText({ at, code: 'capStopped' }, 'en')).toBe("Claude's monthly run cap is reached; research stopped");
    expect(importActivityText({ at, code: 'capStopped' }, 'es')).toBe('Se alcanzó el límite mensual de usos de Claude; la investigación se detuvo');
    expect(importActivityText({ at, code: 'capStopped' }, 'fr')).toBe('Le plafond mensuel d’utilisations de Claude est atteint ; la recherche est arrêtée');
    for (const lang of LANGS) {
      for (const code of ['finished', 'paused', 'resumed'] as const) expect(importActivityText({ at, code }, lang)).not.toBe('');
    }
    expect(importActivityText({ at, code: 'finished' }, 'fr')).toBe('Recherche terminée');
  });
});
