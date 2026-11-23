import { useId, useState } from 'react';
import { safeUrl } from '@dait-crm/shared';
import type { CompanyDetail } from '../../../api/companies';
import { useAcceptHigh, useDecideSuggestion, useSources, type ResearchSuggestion } from '../../../api/research';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { ScrollBox } from '../../../components/Table';
import { useToast } from '../../../components/Toast';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { researchFieldText, researchSourcesText, researchStatusBadge, researchStatusText, sourceTypeText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { AddSourceModal } from '../AddSourceModal';
import { AiCard, researchErrorText, type ResearchRunner } from '../AiCard';
import { EngineCard } from '../EngineCard';
import { systemDetail, systemText } from '../../../i18n/systemText';

/** A stored value as text: arrays joined, empty → null (shown as NULL). */
function asText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  return String(v);
}

/** The page a suggestion came from: its label (or the URL without the scheme), linked when the URL is safe. */
function SourceLink({ url, label }: { url: string; label: string | null }) {
  const text = label || url.replace(/^https?:\/\//i, '');
  const href = safeUrl(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  ) : (
    <>{text}</>
  );
}

/**
 * AI Intelligence tab (prototype views-companies.js tab "ai"): the AI business intelligence card (big), Suggestions
 * awaiting review, Enrichment history; side column AI classification and, for Administrators, the Enrichment engine.
 */
export function AiTab({ company, research }: { company: CompanyDetail; research: ResearchRunner }) {
  const t = useT();
  const me = useCurrentUser();
  const { dateTime } = useFormatDate();
  const view = research.query.data;
  const c = view?.company;
  const pending = view?.pending ?? [];
  const runs = view?.runs ?? [];
  const canEdit = view?.canEdit ?? false;
  const isAdmin = me.can('view_admin_settings') && me.can('manage_users');
  const toast = useToast();
  // Decisions live here, not in the rows or the button: a decided row (and the button, once nothing is left) leaves
  // the table when the view refreshes, and a mutation's callbacks do not run after its component unmounts.
  const decide = useDecideSuggestion(company.id);
  const acceptHigh = useAcceptHigh(company.id);
  const onDecide = (s: ResearchSuggestion, accept: boolean) =>
    decide.mutate(
      { id: s.id, accept },
      {
        onSuccess: () =>
          toast(accept ? t('Accepted · {label} updated (marked AI-sourced)', { label: researchFieldText(t, s.field, s.label) }) : t('Rejected')),
        onError: (err) => toast(researchErrorText(t, err), 'warn'),
      },
    );
  const onAcceptHigh = () =>
    acceptHigh.mutate(undefined, {
      onSuccess: ({ accepted }) => toast(accepted === 1 ? t('1 suggestion accepted') : t('{n} suggestions accepted', { n: accepted })),
      onError: (err) => toast(researchErrorText(t, err), 'warn'),
    });
  const sugId = useId();
  const histId = useId();
  const clsId = useId();

  return (
    <div className="cols">
      <div className="col-main">
        <AiCard companyId={company.id} research={research} big />
        <section className="card flush" aria-labelledby={sugId}>
          <div className="head">
            <h2 id={sugId}>
              {t('Suggestions awaiting review')} <span className="badge b-warn">{pending.length}</span>
            </h2>
            <span className="head-note">{t('Accepting writes the value. Verified fields are locked and never overwritten.')}</span>
            <div className="grow" />
            {pending.length && canEdit ? (
              <button type="button" className="btn sm" disabled={acceptHigh.isPending} onClick={onAcceptHigh}>
                {t('Accept all ≥ 80%')}
              </button>
            ) : null}
          </div>
          <ScrollBox>
            <table>
              <thead>
                <tr>
                  <th>{t('Field')}</th>
                  <th>{t('Current value')}</th>
                  <th>{t('AI suggestion')}</th>
                  <th>{t('Confidence')}</th>
                  <th>{t('Source')}</th>
                  <th className="num">{t('Decision')}</th>
                </tr>
              </thead>
              <tbody>
                {pending.length ? (
                  pending.map((s) => (
                    <SuggestionRow
                      key={s.id}
                      s={s}
                      verified={c?.verifiedFields?.[s.field] === true}
                      canEdit={canEdit}
                      busy={decide.isPending || acceptHigh.isPending}
                      onDecide={(accept) => onDecide(s, accept)}
                    />
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="empty">
                      {view ? t('Nothing waiting. Run AI research to generate suggestions for unverified fields.') : t('Loading…')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollBox>
        </section>
        <section className="card flush" aria-labelledby={histId}>
          <div className="head">
            <h2 id={histId}>
              {t('Enrichment history')} <span className="sec-note">enrichment_history</span>
            </h2>
          </div>
          <ScrollBox>
            <table>
              <thead>
                <tr>
                  <th>{t('Run')}</th>
                  <th>{t('Trigger')}</th>
                  <th>{t('Engine')}</th>
                  <th>{t('Sources')}</th>
                  <th>{t('Result')}</th>
                  <th>{t('Applied')}</th>
                  <th>{t('Status')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.length ? (
                  runs.map((r) => (
                    <tr key={r.id}>
                      <td>{dateTime(r.createdAt)}</td>
                      <td>{systemText(t, r.trigger)}</td>
                      <td>{systemText(t, r.engine)}</td>
                      <td className="wrap">{researchSourcesText(t, r.sources)}</td>
                      <td className="wrap">{r.result ? systemDetail(t, r.result) : ''}</td>
                      <td>{r.appliedCount}</td>
                      <td>
                        <span className={researchStatusBadge(r.status)}>{researchStatusText(t, r.status)}</span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="empty">
                      {view ? t('No research runs yet.') : t('Loading…')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollBox>
        </section>
      </div>
      <aside className="col-side">
        <section className="card" aria-labelledby={clsId}>
          <h2 id={clsId}>{t('AI classification')}</h2>
          <dl className="kv ai-kv">
            <dt>{t('Industry')}</dt>
            <Dd value={c?.aiIndustry} />
            <dt>{t('Business category')}</dt>
            <Dd value={c?.aiBusinessCategory} />
            <dt>{t('Opportunity score')}</dt>
            <Dd value={c && c.aiOpportunityScore !== null ? t('{n} / 100', { n: c.aiOpportunityScore }) : null} />
            <dt>{t('Confidence')}</dt>
            <Dd value={c?.aiConfidence} />
            <dt>{t('Potential services')}</dt>
            {c?.aiPotentialServices.length ? (
              <dd>
                {c.aiPotentialServices.map((x) => (
                  <span key={x} className="pill">
                    {x}
                  </span>
                ))}
              </dd>
            ) : (
              <dd className="dim">—</dd>
            )}
          </dl>
        </section>
        {isAdmin ? <EngineCard /> : null}
      </aside>
    </div>
  );
}

function Dd({ value }: { value: string | null | undefined }) {
  return value ? <dd>{value}</dd> : <dd className="dim">—</dd>;
}

type RowProps = { s: ResearchSuggestion; verified: boolean; canEdit: boolean; busy: boolean; onDecide: (accept: boolean) => void };

function SuggestionRow({ s, verified, canEdit, busy, onDecide }: RowProps) {
  const t = useT();
  const current = asText(s.currentValue);
  return (
    <tr>
      <td>
        <strong>{researchFieldText(t, s.field, s.label)}</strong>
      </td>
      <td className="wrap">
        {current === null ? (
          <span className="dim">NULL</span>
        ) : (
          <>
            {current}
            {verified ? <span className="tag-ok">{t('VERIFIED')}</span> : null}
          </>
        )}
      </td>
      <td className="wrap">{s.display || asText(s.value)}</td>
      <td>
        <span className="tag-ai flat">{t('AI · {n}%', { n: s.confidence })}</span>
      </td>
      <td className="wrap">
        <SourceLink url={s.sourceUrl} label={s.sourceLabel} />
      </td>
      <td className="num nowrap">
        {verified ? (
          <span className="locked-note">{t('Locked · verified')}</span>
        ) : s.locked ? (
          // Filled since the run (by hand or another suggestion): never overwritten, but not verified.
          <span className="locked-note">{t('Field already filled')}</span>
        ) : canEdit ? (
          <>
            <button type="button" className="btn xs" disabled={busy} onClick={() => onDecide(false)}>
              {t('Reject')}
            </button>{' '}
            <button type="button" className="btn xs primary" disabled={busy} onClick={() => onDecide(true)}>
              {t('Accept')}
            </button>
          </>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Research Sources tab (prototype tab "sources"): every source record, "+ Add source manually", the foot text, and
 * a read-only snapshot of the newest record that has one.
 */
export function SourcesTab({ company }: { company: CompanyDetail }) {
  const t = useT();
  const me = useCurrentUser();
  const { dateTime } = useFormatDate();
  const { data } = useSources(company.id);
  const [adding, setAdding] = useState(false);
  const headId = useId();
  const snapId = useId();
  const rows = data ?? [];
  const snap = rows.find((s) => s.snapshot);

  return (
    <div className="cols">
      <section className="card flush col-main" aria-labelledby={headId}>
        <div className="head">
          <h2 id={headId}>{t('Research sources')}</h2>
          <span className="head-note">{t('source_records · every URL and dataset the profile was built from')}</span>
          <div className="grow" />
          {me.can('manage_companies') ? (
            <button type="button" className="btn sm" onClick={() => setAdding(true)}>
              {t('+ Add source manually')}
            </button>
          ) : null}
        </div>
        <ScrollBox>
          <table>
            <thead>
              <tr>
                <th>{t('Source')}</th>
                <th>{t('Type')}</th>
                <th>{t('Collected')}</th>
                <th>{t('By')}</th>
                <th>{t('Fields populated')}</th>
                <th>{t('Confidence')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((s) => {
                  const href = s.url ? safeUrl(s.url) : null;
                  return (
                    <tr key={s.id}>
                      <td>
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="strong">
                            {s.title}
                          </a>
                        ) : (
                          <strong>{s.title}</strong>
                        )}
                      </td>
                      <td>{sourceTypeText(t, s.sourceType)}</td>
                      <td>{dateTime(s.collectedAt)}</td>
                      <td>{s.collectedBy}</td>
                      <td className="wrap">{s.fieldsPopulated || '—'}</td>
                      <td>{s.confidence ?? ''}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="empty">
                    {data ? t('No sources recorded.') : t('Loading…')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollBox>
        <div className="foot">
          {t('Only approved sources are used: public websites, the approved Google Places integration, licensed directories, CSV imports and visitor submissions. No invented values: missing facts stay NULL.')}
        </div>
      </section>
      <aside className="col-side">
        {snap ? (
          <section className="card" aria-labelledby={snapId}>
            <h2 id={snapId}>
              {t('Snapshot · {title}', { title: snap.title })} <span className="badge b-grey">{t('read only')}</span>
            </h2>
            <div className="note info snapshot">{snap.snapshot}</div>
          </section>
        ) : null}
      </aside>
      {adding ? <AddSourceModal companyId={company.id} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
