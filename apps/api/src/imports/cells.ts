/**
 * The formula guard of the import downloads and its undoing on upload: a downloaded cell that would start a formula
 * gets one leading `'`; when such a file comes back through step 1, that one `'` is dropped again, so "@Home Realty"
 * round-trips as itself.
 */

/** A cell that would start a formula: = + - @, tab or CR, and their full-width forms (Excel reads those too). */
export const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;
/** A phone number such as "+971 4 555 0192" (the workbook writes it as a string cell, which cannot evaluate). */
const PHONE = /^\+?[\d\s().-]{7,}$/;

/** A workbook cell value: a leading `'` when it would start a formula, a phone number excepted (string cells). */
export function safeCell(v: string): string {
  return FORMULA_START.test(v) && !PHONE.test(v) ? `'${v}` : v;
}

/** A CSV value (no cell types in CSV): a leading `'` for every value that would start a formula, phones included. */
export function safeCsvCell(v: string): string {
  return FORMULA_START.test(v) ? `'${v}` : v;
}

/** Step 1: drops the one `'` a download put before a value that would start a formula; any other value is unchanged. */
export function unguardCell(v: string): string {
  return v.startsWith("'") && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v;
}
