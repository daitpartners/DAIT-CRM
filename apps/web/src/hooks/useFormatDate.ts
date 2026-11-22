import { useCallback } from 'react';
import { formatDate, formatDateTime } from '@dait-crm/shared';
import { useCurrentUser } from '../api/useCurrentUser';
import { useT } from '../i18n/useT';

/** `YYYY-MM-DD` of a moment in a time zone. */
const ymdIn = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/**
 * Date formatters in the user's language and date format: `date` for a timestamp (shown in the
 * user's time zone), `day` for a calendar date `YYYY-MM-DD` (shown as is, no time-zone shift), `dateTime` for a
 * timestamp with its time (24-hour), `relative` for a timestamp as "Today, 09:05" / "Yesterday, 17:00" / the
 * date and time (prototype `rel`).
 */
export function useFormatDate() {
  const t = useT();
  const { language, timezone, dateFormat } = useCurrentUser();
  const date = useCallback((iso: string) => formatDate(iso, { locale: language, timezone, dateFormat }), [language, timezone, dateFormat]);
  const day = useCallback(
    (ymd: string) => formatDate(`${ymd}T00:00:00.000Z`, { locale: language, timezone: 'UTC', dateFormat }),
    [language, dateFormat],
  );
  const dateTime = useCallback((iso: string) => formatDateTime(iso, { locale: language, timezone, dateFormat }), [language, timezone, dateFormat]);
  const relative = useCallback(
    (iso: string) => {
      const at = new Date(iso);
      const d = ymdIn(at, timezone);
      const today = ymdIn(new Date(), timezone);
      const [y, m, dd] = today.split('-').map(Number);
      const yesterday = new Date(Date.UTC(y!, m! - 1, dd! - 1)).toISOString().slice(0, 10);
      if (d !== today && d !== yesterday) return formatDateTime(at, { locale: language, timezone, dateFormat });
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      return `${d === today ? t('Today') : t('Yesterday')}, ${time}`;
    },
    [t, language, timezone, dateFormat],
  );
  return { date, day, dateTime, relative };
}
