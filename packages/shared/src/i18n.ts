export type Lang = 'en' | 'es' | 'fr';

const LOCALES: Record<Lang, string> = { en: 'en-GB', es: 'es-ES', fr: 'fr-FR' };

export function t(
  dict: Record<string, string>,
  phrase: string,
  vars?: Record<string, string | number>,
): string {
  const text = Object.prototype.hasOwnProperty.call(dict, phrase) ? dict[phrase]! : phrase;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function formatDate(
  d: Date | string,
  opts: { locale: Lang; timezone: string; dateFormat: string },
): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const base = { timeZone: opts.timezone } as const;
  const o: Intl.DateTimeFormatOptions =
    opts.dateFormat === 'DD MMM YYYY'
      ? { ...base, day: 'numeric', month: 'short', year: 'numeric' }
      : { ...base, day: '2-digit', month: '2-digit', year: 'numeric' };
  if (opts.dateFormat === 'MM/DD/YYYY') {
    const parts = new Intl.DateTimeFormat('en-US', o).formatToParts(date);
    const p = (type: string) => parts.find((x) => x.type === type)!.value;
    return `${p('month')}/${p('day')}/${p('year')}`;
  }
  return new Intl.DateTimeFormat(LOCALES[opts.locale], o).format(date);
}

export function lookupLabel(
  v: { label: string; labelEs?: string | null; labelFr?: string | null },
  lang: Lang,
): string {
  if (lang === 'es') return v.labelEs || v.label;
  if (lang === 'fr') return v.labelFr || v.label;
  return v.label;
}
