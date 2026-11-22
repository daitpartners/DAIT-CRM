import { allZonesOf } from '@dait-crm/shared';
import type { TFn } from '../../i18n/useT';
import type { RecipientCheck } from '../../api/mailer';

/** A recipient's local time for display: "HH:mm · Zone" now in their one zone, or "Country — all zones". */
export function zoneText(t: TFn, zones: string[], now: Date = new Date()): string {
  const country = allZonesOf(zones);
  if (country) return t('{country} — all zones', { country: t(country) });
  if (zones.length !== 1) return zones.join(', ');
  try {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: zones[0], hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    return `${time} · ${zones[0]}`;
  } catch {
    return zones[0]!; // an id this browser does not know
  }
}

/** Where the zone came from (release 2C: company field, address, country, else the sender's). */
export function zoneSourceText(t: TFn, source: RecipientCheck['source']): string {
  switch (source) {
    case 'company': return t('from the company');
    case 'address': return t('from the address');
    case 'country': return t('from the country');
    case 'sender': return t('your time zone (country unknown)');
  }
}
