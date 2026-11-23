import { describe, expect, test } from 'vitest';
import {
  BATCH_NUMBER_RE, IMPORT_FILE_ERRORS, IMPORT_FIELDS, IMPORT_TABLE_FIELDS, PROBLEM_CODES, importColumnLabel, importFileErrorText, importSource, problemText,
  type RowProblem,
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
