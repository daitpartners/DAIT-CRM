import { createContext, useEffect, useMemo, type ReactNode } from 'react';
import { useMe, type Lang } from '../api/queries';
import en from '../locales/en.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';

const DICTS: Record<Lang, Record<string, string>> = { en, es, fr };

export type I18nValue = { lang: Lang; dict: Record<string, string> };

export const I18nContext = createContext<I18nValue>({ lang: 'en', dict: {} });

/** Chooses the dictionary from the signed-in user's language; English (and signed-out) is a passthrough. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const lang: Lang = me && me.language in DICTS ? me.language : 'en';
  const value = useMemo(() => ({ lang, dict: DICTS[lang] }), [lang]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
