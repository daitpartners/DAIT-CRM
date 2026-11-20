const ALLOWED = ['http:', 'https:', 'mailto:', 'tel:'];
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_PORT = /^[^:/?#]+:\d+(?:[/?#]|$)/;

/** Returns a trimmed URL safe to render in an href, or null. Bare hosts get https://. */
export function safeUrl(input: string | null | undefined): string | null {
  const value = input?.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (ALLOWED.some((s) => lower.startsWith(s))) return value;
  if (HAS_SCHEME.test(value) && !HOST_PORT.test(value)) return null;
  return `https://${value}`;
}
