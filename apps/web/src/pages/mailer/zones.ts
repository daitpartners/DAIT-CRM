import { allZonesOf } from '@dait-crm/shared';
import type { TFn } from '../../i18n/useT';
import type { RecipientCheck } from '../../api/mailer';

/** A recipient's local time zone for display: one zone id, or "Country — all zones". */
export function zoneText(t: TFn, zones: string[]): string {
  const country = allZonesOf(zones);
  if (country) return t('{country} — all zones', { country: t(country) });
  return zones.join(', ');
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
