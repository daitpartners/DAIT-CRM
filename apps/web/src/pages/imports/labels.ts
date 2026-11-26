import { importFileErrorText, importNoClaudeText, type ImportField, type Lang } from '@dait-crm/shared';
import { Fragment, createElement, type ReactNode } from 'react';
import type { ImportFileRow } from '../../api/imports';
import type { TFn } from '../../i18n/useT';

/* Import leads: status → badge class, and the import screens' small texts. */

/** A staged row's status badge (step 2). */
export function rowStatusBadge(status: string): string {
  switch (status) {
    case 'Ready':
      return 'b-ok';
    case 'Missing details':
      return 'b-warn';
    case 'Already in CRM':
      return 'b-info';
    case 'Update':
      return 'b-purple';
    default:
      return 'b-grey';
  }
}

/** A batch's status badge class (Data manager). */
export function batchStatusBadge(status: string): string {
  switch (status) {
    case 'Researching':
    case 'Importing':
      return 'b-purple';
    case 'Imported':
      return 'b-ok';
    case 'Waiting for review':
      return 'b-warn';
    case 'Failed':
      return 'b-bad';
    default:
      return 'b-grey';
  }
}

/** A batch's status in words (Data manager); an Undone batch reads with its day when given ("Undone 19 Nov"). */
export function batchStatusText(t: TFn, status: string, undoneDay?: string): string {
  switch (status) {
    case 'Uploading':
      return t('Uploading|import');
    case 'Sorting':
      return t('Sorting|import');
    case 'Waiting for review':
      return t('Waiting for review|import');
    case 'Researching':
      return t('Researching|import');
    case 'Importing':
      return t('Importing|import');
    case 'Imported':
      return t('Imported|import');
    case 'Undone':
      return undoneDay ? t('Undone {date}|import', { date: undoneDay }) : t('Undone|import');
    case 'Failed':
      return t('Failed|import');
    default:
      return status;
  }
}

/** A batch not imported yet is still in the wizard (its "Open" goes back to its step). */
export const IN_WIZARD = new Set(['Uploading', 'Sorting', 'Waiting for review', 'Researching']);

/** A file's read status badge: class and words (step 1). */
export function fileBadge(t: TFn, status: string): { cls: string; text: string } {
  switch (status) {
    case 'Read':
      return { cls: 'b-ok', text: t('Read|file') };
    case 'Scan':
      return { cls: 'b-warn', text: t("Can't read scans yet") };
    case 'Failed':
      return { cls: 'b-bad', text: t('Not read') };
    default:
      return { cls: 'b-grey', text: t('Reading…') };
  }
}

/** A row's research badge (step 3): a failed row reads as "Found nothing" (its note says why). */
export function researchBadge(t: TFn, status: string | undefined): { cls: string; text: string } {
  switch (status) {
    case 'everything':
      return { cls: 'b-ok', text: t('Done') };
    case 'some':
      return { cls: 'b-warn', text: t('Found some') };
    case 'nothing':
    case 'failed':
      return { cls: 'b-grey', text: t('Found nothing') };
    case 'running':
      return { cls: 'b-purple', text: t('Researching') };
    default:
      return { cls: 'b-grey', text: t('Waiting') };
  }
}

/** The file list's logo: XLS, CSV, PDF, DOC or TXT. */
export function fileLogo(ext: string): string {
  switch (ext) {
    case 'xlsx':
    case 'xls':
      return 'XLS';
    case 'docx':
      return 'DOC';
    default:
      return ext.toUpperCase().slice(0, 3);
  }
}

/** "1.2 MB", "80 KB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * What the file list says about a file: "3 sheets · 412 rows · 1.2 MB", "412 rows · 80 KB", "18 pages · text found",
 * "120 lines · text found", "6 pages · images only, no text", or why it could not be read.
 */
export function fileMetaText(t: TFn, f: ImportFileRow, lang: Lang): string {
  const m = f.meta ?? {};
  const size = sizeText(f.size);
  if (f.status === 'Failed') return f.error ? importFileErrorText(f.error, f.ext, lang) : size;
  if (f.status === 'Reading') return size;
  const parts: string[] = [];
  if (m.sheets !== undefined) parts.push(m.sheets === 1 ? t('1 sheet') : t('{n} sheets', { n: m.sheets }));
  if (f.ext === 'xlsx' || f.ext === 'xls' || f.ext === 'csv') {
    if (m.rows !== undefined) parts.push(m.rows === 1 ? t('1 row') : t('{n} rows', { n: m.rows }));
    parts.push(size);
    return parts.join(' · ');
  }
  if (m.pages !== undefined) parts.push(m.pages === 1 ? t('1 page') : t('{n} pages', { n: m.pages }));
  if (m.lines !== undefined) parts.push(m.lines === 1 ? t('1 line') : t('{n} lines', { n: m.lines }));
  if (f.status === 'Scan') parts.push(t('images only, no text'));
  else if (m.textFound !== false) parts.push(t('text found'));
  if (m.noClaude) parts.push(importNoClaudeText(m.noClaude, lang));
  return parts.join(' · ');
}

/** A field as the column question's select names it ("Company name", "Not needed (skip column)"). */
export function fieldOptionLabel(t: TFn, field: ImportField | 'skip'): string {
  switch (field) {
    case 'companyName':
      return t('Company name');
    case 'contactName':
      return t('Contact name');
    case 'designation':
      return t('Designation');
    case 'industry':
      return t('Industry');
    case 'city':
      return t('City');
    case 'country':
      return t('Country');
    case 'website':
      return t('Website');
    case 'email':
      return t('Email');
    case 'phone':
      return t('Phone');
    case 'notes':
      return t('Notes');
    default:
      return t('Not needed (skip column)');
  }
}

/** The column question's options, in the mockup's order. */
export const FIELD_OPTIONS: readonly (ImportField | 'skip')[] = [
  'companyName', 'contactName', 'designation', 'industry', 'city', 'country', 'website', 'email', 'phone', 'notes', 'skip',
];

/**
 * A research value's source label: the labels research writes itself ("website search", "AI analysis · <page>")
 * translate; a page address stays as it is.
 */
export function sourceLabelText(t: TFn, label: string): string {
  if (label === 'website search') return t('website search');
  const ai = /^AI analysis · (.+)$/.exec(label);
  return ai ? t('AI analysis · {source}', { source: ai[1]! }) : label;
}

/** Import API refusals in plain words. */
export function importErrorText(t: TFn, code: string): string {
  switch (code) {
    case 'files_reading':
      return t('Some files are still being read. Wait until every file is read.');
    case 'no_rows':
      return t('No rows were found in these files.');
    case 'batch_locked':
      return t('This import has already started and can no longer be changed.');
    case 'too_many_files':
      return t('Up to 10 files per import.');
    case 'file_size':
      return t('The file is larger than 20 MB.');
    case 'file_type':
      return t('Only .xlsx .xls .csv .pdf .docx .txt files can be imported.');
    case 'research_started':
      return t("Files can't be added once research has started.");
    case 'research_done':
      return t('Research has already run for this import. Review the rows in step 4.');
    case 'research_stopped':
      return t("Research stopped at Claude's monthly run cap. Resume it to research the remaining rows.");
    case 'claude_cap_reached':
      return t("Claude's monthly run cap is still reached. Raise the cap in Settings or switch Claude off, then resume.");
    case 'choice_required':
      return t('Choose Import them or Leave them out.');
    case 'nothing_to_import':
      return t('There is nothing to import with these choices.');
    case 'import_running':
      return t('This import is already running.');
    case 'cannot_continue':
      return t('This import cannot be continued. Reload to see its status.');
    case 'try_again':
      return t('Someone was changing these records at the same moment. Nothing was undone. Try again.');
    case 'file_deleted':
      return t('Deleted after 90 days');
    case 'file_remove_locked':
      return t("Files can't be removed once the data has been sorted. Start a new import to use other files.");
    case 'duplicate_value':
      return t('That value already exists in this list');
    case 'forbidden':
      return t('You do not have access');
    default:
      return t('Something went wrong. Try again.');
  }
}

/** Placeholders for `withNodes`: pass them as t() variables where a translated sentence holds markup (bold, a link). */
export const NODE = ['\u0001', '\u0002', '\u0003'] as const;

/** A translated sentence with its `NODE` placeholders replaced by `nodes` (in order: NODE[0] → nodes[0] …). */
export function withNodes(text: string, nodes: ReactNode[]): ReactNode[] {
  return text.split(/([\u0001-\u0003])/).map((part, i) => {
    const at = NODE.indexOf(part as (typeof NODE)[number]);
    return createElement(Fragment, { key: i }, at >= 0 ? nodes[at] : part);
  });
}
