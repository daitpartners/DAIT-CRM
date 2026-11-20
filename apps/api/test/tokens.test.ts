import { afterEach, describe, expect, test, vi } from 'vitest';
import { decrypt, encrypt } from '../src/crypto/tokens';

afterEach(() => vi.unstubAllEnvs());

describe('token encryption', () => {
  test('round trip', () => {
    const enc = encrypt('refresh-token-value');
    expect(enc).not.toContain('refresh-token-value');
    expect(enc.split('.')).toHaveLength(3);
    expect(decrypt(enc)).toBe('refresh-token-value');
  });

  test('uses a fresh IV each time', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  test('tampered ciphertext throws', () => {
    const [iv, tag, ct] = encrypt('refresh-token-value').split('.');
    const bytes = Buffer.from(ct!, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => decrypt(`${iv}.${tag}.${bytes.toString('base64')}`)).toThrow();
    const badTag = Buffer.from(tag!, 'base64');
    badTag[0] = badTag[0]! ^ 0xff;
    expect(() => decrypt(`${iv}.${badTag.toString('base64')}.${ct}`)).toThrow();
    expect(() => decrypt('not-a-token')).toThrow();
  });

  test('missing or invalid key gives a clear error', () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', '');
    expect(() => encrypt('x')).toThrow(/TOKEN_ENCRYPTION_KEY/);
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', Buffer.alloc(16).toString('base64'));
    expect(() => encrypt('x')).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
