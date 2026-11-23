import { useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { isResearchQueued, useResearch, useStartResearch, useVerifyProfile, type ResearchView } from '../../api/research';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, researchStatusBadge, researchStatusText, verificationBadge, verificationText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';

/** Toast text for an API error from a research write; `locked` here means a verified field, not a closed quotation. */
export function researchErrorText(t: TFn, err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'unknown';
  return errorText(t, code === 'locked' ? 'field_locked' : code);
}

/** The prototype's completion toast: suggestions from the run that just finished, or why it failed. */
function finishedToast(t: TFn, view: ResearchView): { text: string; kind: 'ok' | 'warn' } {
  const run = view.runs[0];
  if (run?.status === 'Failed') return { text: t('AI research failed · {reason}', { reason: run.result ?? '' }), kind: 'warn' };
  const n = run ? view.pending.filter((s) => s.runId === run.id).length : 0;
  return {
    text: n === 1 ? t('AI research completed · 1 suggestion to review') : t('AI research completed · {n} suggestions to review', { n }),
    kind: 'ok',
  };
}

/**
 * The research view (polled while a run is queued) with "Run research": the queued toast, refusals as warnings, and
 * the completion toast when the run finishes. Use it once per screen. `onFinished` gets whether this screen started
 * the run.
 */
export function useResearchRunner(companyId: number, opts: { enabled?: boolean; onFinished?: (startedHere: boolean) => void } = {}) {
  const t = useT();
  const toast = useToast();
  const startedHere = useRef(false);
  const query = useResearch(companyId, {
    enabled: opts.enabled,
    onFinished: (view) => {
      const { text, kind } = finishedToast(t, view);
      toast(text, kind);
      opts.onFinished?.(startedHere.current);
      startedHere.current = false;
    },
  });
  const start = useStartResearch(companyId);
  const run = () =>
    start.mutate(undefined, {
      onSuccess: () => {
        startedHere.current = true;
        toast(t('Enrichment job queued · running in background'));
      },
      onError: (err) => toast(researchErrorText(t, err), 'warn'),
    });
  const queued = isResearchQueued(query.data?.company?.aiResearchStatus);
  return { query, run, busy: start.isPending || queued };
}

type ViewProps = {
  companyId: number;
  view: ResearchView | undefined;
  /** The AI Intelligence tab's variant: Re-run research / Mark profile verified beside the score. */
  big?: boolean;
  /** Run and verify buttons (users who may edit the company). */
  canEdit: boolean;
  busy: boolean;
  onRun: () => void;
};

/**
 * "AI business intelligence" (prototype aiCard): score ring, opportunity score, confidence, research status, last
 * research and verification, the AI summary or its empty note, the actions and the engine line.
 */
function AiCardView({ companyId, view, big = false, canEdit, busy, onRun }: ViewProps) {
  const t = useT();
  const toast = useToast();
  const { dateTime } = useFormatDate();
  const headingId = useId();
  const verify = useVerifyProfile(companyId);
  const c = view?.company;
  const score = c?.aiOpportunityScore ?? null;
  const status = c?.aiResearchStatus ?? 'Not started';
  const verification = c?.verificationStatus ?? 'Unverified';
  const markVerified = () =>
    verify.mutate(undefined, {
      onSuccess: () => toast(t('All filled fields marked verified')),
      onError: (err) => toast(researchErrorText(t, err), 'warn'),
    });

  return (
    <section className="card ai-card" aria-labelledby={headingId}>
      <h2>
        <span className="pill" aria-hidden="true">G</span>
        <span id={headingId}>{t('AI business intelligence')}</span>
      </h2>
      <div className="ai-head">
        <div className="score" style={{ background: `conic-gradient(#822CDB 0 ${score ?? 0}%, var(--line) ${score ?? 0}% 100%)` }} aria-hidden="true">
          <div>{score === null ? '—' : score}</div>
        </div>
        <div className="ai-facts">
          <div className="ai-score">
            {score === null ? t('Opportunity score not yet computed') : t('Opportunity score {n} / 100', { n: score })}
          </div>
          <div className="ai-sub">
            {t('Confidence')} <strong className="ai-conf">{c?.aiConfidence || '—'}</strong> · {t('Research')}{' '}
            <span className={researchStatusBadge(status)}>{researchStatusText(t, status)}</span>
          </div>
          <div className="ai-sub">
            {t('Last research')} {c?.aiLastResearchAt ? dateTime(c.aiLastResearchAt) : t('never')} ·{' '}
            <span className={verificationBadge(verification)}>{verificationText(t, verification)}</span>
          </div>
        </div>
        {big && canEdit ? (
          <div className="ai-actions">
            <button type="button" className="btn primary" onClick={onRun} disabled={busy}>
              {t('Re-run research')}
            </button>
            <button type="button" className="btn" onClick={markVerified} disabled={verify.isPending}>
              {t('Mark profile verified')}
            </button>
          </div>
        ) : null}
      </div>
      {c?.aiSummary ? (
        <div className="note ai-summary">
          <strong>{t('AI company summary.')}</strong> {c.aiSummary}
        </div>
      ) : (
        <div className="note info">{t('No AI summary yet. Run research to generate one.')}</div>
      )}
      {big ? null : (
        <div className="ai-links">
          <Link className="btn sm" to={`/companies/${companyId}#ai`}>
            {t('Review suggestions')}
          </Link>
          {canEdit ? (
            <button type="button" className="btn sm" onClick={onRun} disabled={busy}>
              {t('Run research')}
            </button>
          ) : null}
        </div>
      )}
      <div className="ai-engine">
        {t('Engine: pluggable (Ollama self-hosted or Claude API). Suggestions are stored in enrichment_history and applied only to unverified fields.')}
      </div>
    </section>
  );
}

export type ResearchRunner = ReturnType<typeof useResearchRunner>;

/** The card on the Overview (small) or the AI Intelligence tab (`big`), driven by the profile's one research runner. */
export function AiCard({ companyId, research, big = false }: { companyId: number; research: ResearchRunner; big?: boolean }) {
  const { query, run, busy } = research;
  return <AiCardView companyId={companyId} view={query.data} big={big} canEdit={query.data?.canEdit ?? false} busy={busy} onRun={run} />;
}
