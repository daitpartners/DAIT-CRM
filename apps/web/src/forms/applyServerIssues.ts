import { ApiError } from '../api/client';
import { errorText } from '../i18n/labels';
import type { TFn } from '../i18n/useT';

/**
 * Maps a failed save onto a form: each server validation issue whose first path segment is one of
 * `fields` marks that field (type 'server'), and the returned `formMessage` is the text for the
 * error code ('unknown' for anything that is not an ApiError). Callers handle their own special
 * codes (e.g. `domain_taken`, `stale`) before calling this.
 */
export function applyServerIssues<F extends string>(
  err: unknown,
  fields: readonly F[],
  setError: (field: F, error: { type: string; message: string }) => void,
  t: TFn,
  message: (field: F) => string = () => t('Check this value'),
): { formMessage: string | null } {
  if (!(err instanceof ApiError)) return { formMessage: errorText(t, 'unknown') };
  for (const i of err.issues ?? []) {
    const field = String(i.path[0]) as F;
    if (fields.includes(field)) setError(field, { type: 'server', message: message(field) });
  }
  return { formMessage: errorText(t, err.code) };
}
