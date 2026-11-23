import { useEffect, useId, useState } from 'react';
import type { EnrichmentSettingsUpdate } from '@dait-crm/shared';
import { useEnrichmentSettings, useSaveEnrichmentSettings, type EnrichmentView } from '../../api/research';
import { useToast } from '../../components/Toast';
import { errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { ApiError } from '../../api/client';

const settingsOf = (v: EnrichmentView): EnrichmentSettingsUpdate => ({
  dailyRunLimit: v.dailyRunLimit,
  claudeEnabled: v.claudeEnabled,
  claudeMonthlyCapUsd: v.claudeMonthlyCapUsd,
  placesEnabled: v.placesEnabled,
  placesMonthlyCallCap: v.placesMonthlyCallCap,
  webSearchEnabled: v.webSearchEnabled,
});

/**
 * "Enrichment engine" (prototype engineCard, Administrators only). The website reader is built in and always on;
 * Claude API and Google Places can be chosen only when their key is set on the server, each with a monthly cap;
 * Ollama and Apollo.io are shown but not available (deviation from the prototype, recorded for the owner).
 * Each change saves at once; number fields save when they lose focus.
 */
export function EngineCard() {
  const t = useT();
  const lang = useLang();
  const toast = useToast();
  const headingId = useId();
  const { data } = useEnrichmentSettings(true);
  const save = useSaveEnrichmentSettings();

  const put = (patch: Partial<EnrichmentSettingsUpdate>, done?: string) => {
    if (!data) return;
    save.mutate(
      { ...settingsOf(data), ...patch },
      {
        onSuccess: () => (done ? toast(done) : undefined),
        onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
      },
    );
  };

  const claudeOn = Boolean(data?.claudeKeyPresent && data.claudeEnabled);
  const usd = data ? new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(data.claudeSpentThisMonthUsd) : '';

  return (
    <section className="card engine-card" aria-labelledby={headingId}>
      <h2>
        <span id={headingId}>{t('Enrichment engine')}</span> <span className="badge b-grey">{t('admin')}</span>
      </h2>
      <div className="engine-hint">{t('Modular providers. Switching never changes the data model.')}</div>
      {!data ? (
        <div className="engine-hint">{t('Loading…')}</div>
      ) : (
        <div className="engine-list">
          <label className="sw">
            <input type="radio" name="engine" checked={!claudeOn} disabled={save.isPending} onChange={() => put({ claudeEnabled: false }, t('Engine set to Website reader'))} />
            <span>
              <strong>{t('Website reader')}</strong> · {t('built in, free')}
            </span>
          </label>
          <label className="sw">
            <input
              type="radio"
              name="engine"
              checked={claudeOn}
              disabled={!data.claudeKeyPresent || save.isPending}
              aria-describedby={data.claudeKeyPresent ? undefined : 'engine-claude-hint'}
              onChange={() => put({ claudeEnabled: true }, t('Engine set to Claude API'))}
            />
            <span>
              <strong>{t('Claude API')}</strong> · {t('intelligence + web search')}
            </span>
          </label>
          {data.claudeKeyPresent ? (
            <div className="engine-sub">
              <NumberField
                label={t('Monthly cap (USD)')}
                value={data.claudeMonthlyCapUsd}
                step="0.01"
                onSave={(n) => put({ claudeMonthlyCapUsd: n }, t('Saved'))}
              />
              <span>{t('spent this month USD {n}', { n: usd })}</span>
            </div>
          ) : (
            <div id="engine-claude-hint" className="engine-sub">
              {t('Add ANTHROPIC_API_KEY on the server to enable')}
            </div>
          )}
          <label className="sw">
            <input type="radio" name="engine" checked={false} disabled readOnly />
            <span>
              <strong>{t('Ollama')}</strong> · {t('not installed on this server')}
            </span>
          </label>
          <div className="engine-sep" />
          <label className="sw">
            <input type="checkbox" checked disabled readOnly />
            {t('Public company website')}
          </label>
          <label className="sw">
            <input
              type="checkbox"
              checked={claudeOn && data.webSearchEnabled}
              disabled={!claudeOn || save.isPending}
              onChange={(e) => put({ webSearchEnabled: e.target.checked })}
            />
            <span>
              {t('Web search')}
              {claudeOn ? null : <span className="engine-muted"> · {t('needs Claude API')}</span>}
            </span>
          </label>
          <label className="sw">
            <input
              type="checkbox"
              checked={data.placesKeyPresent && data.placesEnabled}
              disabled={!data.placesKeyPresent || save.isPending}
              aria-describedby={data.placesKeyPresent ? undefined : 'engine-places-hint'}
              onChange={(e) => put({ placesEnabled: e.target.checked })}
            />
            {t('Google Places API (approved)')}
          </label>
          {data.placesKeyPresent ? (
            <div className="engine-sub">
              <NumberField label={t('Monthly call cap')} value={data.placesMonthlyCallCap} onSave={(n) => put({ placesMonthlyCallCap: n }, t('Saved'))} />
              <span>{t('{n} calls this month', { n: data.placesCallsThisMonth })}</span>
            </div>
          ) : (
            <div id="engine-places-hint" className="engine-sub">
              {t('Add GOOGLE_PLACES_API_KEY on the server to enable')}
            </div>
          )}
          <label className="sw">
            <input type="checkbox" checked={false} disabled readOnly />
            <span>
              {t('Apollo.io organisation enrichment')}
              <span className="engine-muted"> · {t('not connected')}</span>
            </span>
          </label>
          <div className="engine-sep" />
          <NumberField label={t('Daily run limit')} value={data.dailyRunLimit} onSave={(n) => put({ dailyRunLimit: n }, t('Saved'))} />
        </div>
      )}
      <div className="engine-note">{t('Credentials live in server environment variables, never in the browser or public site.')}</div>
    </section>
  );
}

/** A small number input that saves on blur (or Enter) when it holds a valid, changed value; otherwise it resets. */
function NumberField({ label, value, step = '1', onSave }: { label: string; value: number; step?: string; onSave: (n: number) => void }) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    const whole = step === '1';
    if (text.trim() === '' || !Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) {
      setText(String(value));
      return;
    }
    if (n !== value) onSave(n);
  };
  return (
    <span className="engine-num">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="in"
        type="number"
        min={0}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </span>
  );
}
