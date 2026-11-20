import type { ComboOption } from '../../components/Combobox';

let cache: string[] | null = null;

const ALIASES = ['Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Ho_Chi_Minh', 'Asia/Yangon', 'Europe/Kyiv', 'America/Nuuk', 'Atlantic/Faroe', 'Pacific/Kanton'];

function valid(z: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

function zones(): string[] {
  if (!cache) {
    try {
      cache = Intl.supportedValuesOf('timeZone');
    } catch {
      cache = ['UTC'];
    }
    // Browsers list canonical IDs only (e.g. Asia/Calcutta), so add the current names people search for.
    const extra = [...ALIASES, 'UTC'].filter((z) => !cache!.includes(z) && valid(z));
    cache = [...cache, ...extra].sort();
  }
  return cache;
}

/** IANA zones for the timezone combobox; `current` is kept even if it is an alias not in the canonical list. */
export function timezoneOptions(current?: string | null): ComboOption[] {
  const list = zones();
  const all = current && !list.includes(current) ? [current, ...list] : list;
  return all.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
}
