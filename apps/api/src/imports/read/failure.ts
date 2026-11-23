/* Why a file could not be read: the texts stored in `import_files.error` and shown in the file list. */

export type ReadFailureKind = 'invalid' | 'too_large' | 'password' | 'old_doc';

/** The stored failure texts (English; the screen translates them by their exact text). */
export const READ_FAILURE_TEXT = {
  invalid: (ext: string) => `This file is not a valid .${ext} file`,
  too_large: 'This file is too large to read',
  password: 'This file is password-protected',
  old_doc: "Old .doc files can't be read; save it as .docx",
  /** Anything else the reader threw (the job's catch-all). */
  unreadable: 'Could not read this file',
  /** A file left Reading after its job was lost (worker stopped, host asleep). */
  interrupted: 'Reading was interrupted; upload the file again',
} as const;

/** A file the reader refuses; `text(ext)` is the stored failure text. */
export class ReadFailure extends Error {
  constructor(readonly kind: ReadFailureKind) {
    super(kind === 'invalid' ? 'This file is not a valid file' : READ_FAILURE_TEXT[kind]);
  }

  text(ext: string): string {
    return this.kind === 'invalid' ? READ_FAILURE_TEXT.invalid(ext) : READ_FAILURE_TEXT[this.kind];
  }
}

/** An OLE compound file (legacy .xls / .doc, or an encrypted Office file). */
export const isOle = (data: Buffer) => data.length >= 4 && data.readUInt32BE(0) === 0xd0cf11e0;

/** An OLE container holding an encrypted Office Open XML package (a password-protected .xlsx / .docx). */
export const isEncryptedPackage = (data: Buffer) =>
  isOle(data) && data.includes(Buffer.from('EncryptionInfo', 'utf16le'));
