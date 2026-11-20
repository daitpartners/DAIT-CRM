import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Reads the key on every use so a missing or bad key fails loudly where tokens are needed. */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? '';
  const buf = Buffer.from(raw, 'base64');
  if (!raw || buf.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be set to 32 random bytes, base64 encoded (openssl rand -base64 32)');
  }
  return buf;
}

/** AES-256-GCM; output is `base64(iv).base64(tag).base64(ciphertext)`. */
export function encrypt(plain: string): string {
  const k = key();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
}

/** Throws when the value is malformed or was tampered with (GCM tag mismatch). */
export function decrypt(enc: string): string {
  const k = key();
  const parts = enc.split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted token');
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed encrypted token');
  const decipher = createDecipheriv(ALGORITHM, k, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
