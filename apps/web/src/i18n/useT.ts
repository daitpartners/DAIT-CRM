import { useCallback, useContext } from 'react';
import { t as translate } from '@dait-crm/shared';
import { I18nContext } from './index';

export type TFn = (phrase: string, vars?: Record<string, string | number>) => string;

/**
 * Returns `t(phrase, vars?)`; the English phrase is the key. A phrase may carry a translation context after `|`
 * (`t('Active|company')`) when other languages need a different form (gender, number); English shows the part
 * before the `|`.
 */
export function useT(): TFn {
  const { dict } = useContext(I18nContext);
  return useCallback<TFn>(
    (phrase, vars) => translate(dict, Object.hasOwn(dict, phrase) ? phrase : phrase.replace(/\|[^|]*$/, ''), vars),
    [dict],
  );
}

export function useLang() {
  return useContext(I18nContext).lang;
}
