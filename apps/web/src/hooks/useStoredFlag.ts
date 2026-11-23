import { useCallback, useState } from 'react';

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/**
 * A yes/no choice remembered in this browser (localStorage `key`, '1' / '0'), e.g. a folded panel. Blocked or
 * missing storage falls back to `fallback`, and the choice then lasts for this visit only.
 */
export function useStoredFlag(key: string, fallback = false): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => read(key, fallback));
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* storage blocked: the state lasts for this visit only */
      }
    },
    [key],
  );
  return [value, set];
}
