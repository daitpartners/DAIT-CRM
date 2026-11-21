import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/**
 * Lead page error handling shared by every action: a `stale` refusal is always toasted (the
 * mutation hooks have already refetched the lead, so a retry carries the fresh `updatedAt`);
 * `toastAll` also toasts every other error (actions without a form to show it in). Returns the code.
 */
export function useActionError() {
  const t = useT();
  const toast = useToast();
  return (err: unknown, toastAll = false): string => {
    const code = err instanceof ApiError ? err.code : 'unknown';
    if (code === 'stale' || toastAll) toast(errorText(t, code), 'warn');
    return code;
  };
}
