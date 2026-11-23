/*
 * Why a file could not be read. `import_files.error` stores the stable code (`IMPORT_FILE_ERRORS`, shared); the screen
 * shows it in the user's language with `importFileErrorText`.
 */
import type { ImportFileError } from '@dait-crm/shared';

/** A file the reader refuses; `code` is what is stored. */
export class ReadFailure extends Error {
  constructor(readonly code: ImportFileError) {
    super(code);
  }
}

/** An OLE compound file (legacy .xls / .doc, or an encrypted Office file). */
export const isOle = (data: Buffer) => data.length >= 4 && data.readUInt32BE(0) === 0xd0cf11e0;

/** An OLE container holding an encrypted Office Open XML package (a password-protected .xlsx / .docx). */
export const isEncryptedPackage = (data: Buffer) =>
  isOle(data) && data.includes(Buffer.from('EncryptionInfo', 'utf16le'));

/** Text a document may yield (characters); more is refused as too large. */
export const MAX_TEXT_CHARS = 5_000_000;
/** Cell text a spreadsheet or CSV may yield (characters, all sheets); more is refused as too large. */
export const MAX_TABLE_CHARS = 20_000_000;

/** Refuses an extract above its cap (`too_large`). */
export function assertTextSize(chars: number, cap: number): void {
  if (chars > cap) throw new ReadFailure('too_large');
}
