import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DATE_FORMATS, type PreferencesUpdate } from '@dait-crm/shared';
import { ApiError, api } from '../../api/client';
import { keys, type Lang, type Me } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Combobox } from '../../components/Combobox';
import { FormField } from '../../components/FormField';
import { useToast } from '../../components/Toast';
import { LANGUAGE_NAMES, errorText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { timezoneOptions } from './timezones';

export function MySettings() {
  const t = useT();
  const me = useCurrentUser();
  const qc = useQueryClient();
  const toast = useToast();
  const [language, setLanguage] = useState<Lang>(me.language);
  const [timezone, setTimezone] = useState(me.timezone);
  const [dateFormat, setDateFormat] = useState(me.dateFormat);

  // Toast after the re-render so "Saved" appears in the newly chosen language.
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    if (saved) toast(t('Saved'));
  }, [saved]);

  useEffect(() => {
    setLanguage(me.language);
    setTimezone(me.timezone);
    setDateFormat(me.dateFormat);
  }, [me.language, me.timezone, me.dateFormat]);

  const save = useMutation({
    mutationFn: (body: PreferencesUpdate) => api<Me>('/api/me/preferences', { method: 'PATCH', body }),
    onSuccess: (updated) => {
      qc.setQueryData(keys.me, updated);
      void qc.invalidateQueries({ queryKey: keys.me });
      setSaved((n) => n + 1);
    },
    onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ language, timezone, dateFormat: dateFormat as PreferencesUpdate['dateFormat'] });
  }

  return (
    <section className="card" aria-labelledby="prefs-title">
      <div className="card-title-row">
        <h2 id="prefs-title">{t('Preferences')}</h2>
        <span className="muted card-sub">{t('Saved per user. Language, date format and time zone apply immediately across the CRM.')}</span>
      </div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="grid3">
          <FormField id="pref-language" label={t('Language')}>
            <select id="pref-language" className="in" value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
              {(Object.keys(LANGUAGE_NAMES) as Lang[]).map((l) => (
                <option key={l} value={l} lang={l}>
                  {LANGUAGE_NAMES[l]}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="pref-date" label={t('Date format')}>
            <select id="pref-date" className="in" value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}>
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </FormField>
          <Combobox id="pref-timezone" label={t('Time zone')} options={timezoneOptions(timezone)} value={timezone} onChange={setTimezone} required />
        </div>
        <div>
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {save.isPending ? t('Saving…') : t('Save')}
          </button>
        </div>
      </form>
    </section>
  );
}
