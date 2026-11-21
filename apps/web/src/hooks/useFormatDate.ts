import { useCallback } from 'react';
import { formatDate, formatDateTime } from '@dait-crm/shared';
import { useCurrentUser } from '../api/useCurrentUser';

/**
 * Date formatters in the user's language and date format: `date` for a timestamp (shown in the
 * user's time zone), `day` for a calendar date `YYYY-MM-DD` (shown as is, no time-zone shift), `dateTime` for a
 * timestamp with its time (24-hour).
 */
export function useFormatDate() {
  const { language, timezone, dateFormat } = useCurrentUser();
  const date = useCallback((iso: string) => formatDate(iso, { locale: language, timezone, dateFormat }), [language, timezone, dateFormat]);
  const day = useCallback(
    (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`, { locale: language, timezone: 'UTC', dateFormat }),
    [language, dateFormat],
  );
  const dateTime = useCallback((iso: string) => formatDateTime(iso, { locale: language, timezone, dateFormat }), [language, timezone, dateFormat]);
  return { date, day, dateTime };
}
