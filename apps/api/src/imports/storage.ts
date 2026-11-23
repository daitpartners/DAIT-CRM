/**
 * Import uploads on disk: `<storage>/imports/<batchId>/<fileId>` (no user text in the path), folders 0700, files 0600.
 * `<storage>` is STORAGE_DIR (on the server `<env>/shared/storage`, kept across releases); outside production it
 * falls back to `<repo>/.storage`. Every path is resolved and must stay inside `<storage>/imports`.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, from `apps/api/src/imports` or `apps/api/dist/imports`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const IMPORTS = 'imports';

/** The shared storage folder. */
export function storageDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.STORAGE_DIR?.trim();
  if (dir) return dir;
  if (env.NODE_ENV === 'production') throw new Error('STORAGE_DIR is required in production');
  return path.join(REPO_ROOT, '.storage');
}

/** The absolute path of a stored import file; refuses anything that would leave `<storage>/imports`. */
function resolveInside(rel: string): string {
  const root = path.resolve(storageDir(), IMPORTS);
  const full = path.resolve(storageDir(), rel);
  if (!full.startsWith(root + path.sep)) throw new Error('import file path outside storage');
  return full;
}

const batchFolder = (batchId: number) => `${IMPORTS}/${batchId}`;

/** Saves an uploaded file and returns its storage path (relative to the storage folder). */
export async function saveImportFile(batchId: number, fileId: number, data: Buffer): Promise<string> {
  const rel = `${batchFolder(batchId)}/${fileId}`;
  const full = resolveInside(rel);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, data, { mode: 0o600 });
  return rel;
}

export async function readImportFile(rel: string): Promise<Buffer> {
  return readFile(resolveInside(rel));
}

export function importFileStream(rel: string): NodeJS.ReadableStream {
  return createReadStream(resolveInside(rel));
}

/** Removes one stored file (nothing happens when it is already gone). */
export async function removeImportFile(rel: string): Promise<void> {
  await rm(resolveInside(rel), { force: true });
}

/** Removes a batch's folder and every file in it. */
export async function removeBatchFiles(batchId: number): Promise<void> {
  await rm(resolveInside(batchFolder(batchId)), { recursive: true, force: true });
}
