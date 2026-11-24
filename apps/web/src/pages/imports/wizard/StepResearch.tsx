import { useState } from 'react';
import { importActivityText, importColumnLabel, importResearchNoteText, type ImportField } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import {
  IMPORT_PAGE_SIZE, usePauseResearch, useResearch, useResumeResearch, useStartResearch, type ImportRowView, type ResearchPage,
} from '../../../api/imports';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Pager } from '../../../components/Pager';
import { ScrollBox } from '../../../components/Table';
import { Tile } from '../../../components/Tile';
import { useLang, useT, type TFn } from '../../../i18n/useT';
import { NODE, importErrorText, researchBadge, sourceLabelText, withNodes } from '../labels';

type Props = { batchId: number; onBack: () => void; onNext: () => void };

/** The research results table's columns (mockup #s3). */
const COLUMNS: readonly ImportField[] = ['companyName', 'website', 'country', 'city', 'contactName', 'designation', 'email', 'industry'];

/** "Running · one company at a time", "Paused", "Stopped" (the Claude cap), "Done"; null before research started. */
export function researchState(t: TFn, v: ResearchPage): { cls: string; text: string } | null {
  if (v.status === 'Researching') return v.paused ? { cls: 'b-grey', text: t('Paused') } : { cls: 'b-purple', text: t('Running · one company at a time') };
  if (v.stopReason === 'cap') return { cls: 'b-warn', text: t('Stopped') };
  if (v.total > 0) return { cls: 'b-ok', text: t('Done') };
  return null;
}

/** HH:MM in the viewer's time zone. */
const hhmm = (iso: string, timezone: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  }
};

/** Step 3 (mockup #s3): progress, tiles, Claude's state, the researched rows and the activity log. */
export function StepResearch({ batchId, onBack, onNext }: Props) {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const { data: v } = useResearch(batchId, page);
  const start = useStartResearch();
  const pause = usePauseResearch();
  const resume = useResumeResearch();
  const busy = start.isPending || pause.isPending || resume.isPending;
  const fail = (e: unknown) => setError(importErrorText(t, e instanceof ApiError ? e.code : ''));

  if (!v) return null;
  const state = researchState(t, v);
  const running = v.status === 'Researching' && !v.paused;
  const canResume = (v.status === 'Researching' && v.paused) || v.stopReason === 'cap';
  const capReached = v.claude.on && v.claude.cap > 0 && v.claude.runsThisMonth >= v.claude.cap;
  const notStarted = state === null && v.status === 'Sorting';
  const pct = v.total > 0 ? Math.round((v.done / v.total) * 100) : 0;

  let action = null;
  if (running) {
    action = (
      <button type="button" className="btn sm" disabled={busy} onClick={() => { setError(null); pause.mutate(batchId, { onError: fail }); }}>
        {t('Pause')}
      </button>
    );
  } else if (canResume) {
    action = (
      <button
        type="button"
        className="btn sm"
        disabled={busy || capReached}
        title={capReached ? t("Claude's monthly run cap is reached. Raise the cap in Settings or switch Claude off to resume.") : undefined}
        onClick={() => { setError(null); resume.mutate(batchId, { onError: fail }); }}
      >
        {t('Resume')}
      </button>
    );
  } else if (notStarted) {
    action = (
      <button type="button" className="btn sm primary" disabled={busy} onClick={() => { setError(null); start.mutate(batchId, { onError: fail }); }}>
        {t('Start research')}
      </button>
    );
  }

  return (
    <section className="wiz" aria-label={t('Step 3 of 4: AI research')}>
      <p className="muted-text">{t('Step 3 of 4 · Fill missing details')}</p>
      <div className="card">
        <div className="sec-title-row">
          <h2>{t('AI research')}</h2>
          {state ? <span className={`badge ${state.cls}`}>{state.text}</span> : null}
          <span className="grow" />
          {action}
        </div>
        <p className="muted-text">
          {t("For each row with missing details the engine reads the company's own website first (free), then uses Claude Code with web search to find what is still missing. Every value found shows where it came from.")}
        </p>
        <div className="actions-row">
          <div className="grow">
            <div className="bar">
              <div style={{ width: `${pct}%` }} />
            </div>
          </div>
          <strong>
            {v.done} / {v.total}
          </strong>
          {running && v.etaMinutes !== null ? (
            <span className="muted-text">{v.etaMinutes <= 1 ? t('about 1 min left') : t('about {n} min left', { n: v.etaMinutes })}</span>
          ) : null}
        </div>
        <div className="tiles">
          <Tile label={t('Found everything')} value={v.tiles.everything} />
          <Tile label={t('Found some')} value={v.tiles.some} />
          <Tile label={t('Found nothing')} value={v.tiles.nothing} />
          <Tile label={t('Claude runs this month')} value={`${v.claude.runsThisMonth} / ${v.claude.cap}`} meta={t('your monthly cap')} />
        </div>
      </div>
      {!v.claude.on ? <div className="note info">{t('Claude Code is off: only the website reader runs.')}</div> : null}
      {/* One note per cap problem: stopped at the cap (and whether Resume can work yet), or paused with the cap reached. */}
      {v.stopReason === 'cap' ? (
        <div className="note warn">
          {capReached
            ? t("Claude's monthly run cap is reached. Research stopped; the remaining rows stay Missing details. Raise the cap in Settings or switch Claude off to resume.")
            : t("Claude's monthly run cap is reached. Research stopped; the remaining rows stay Missing details.")}
        </div>
      ) : canResume && capReached ? (
        <div className="note warn">{t("Claude's monthly run cap is reached. Raise the cap in Settings or switch Claude off to resume.")}</div>
      ) : null}
      {error ? (
        <div className="note danger" role="alert">
          {error}
        </div>
      ) : null}
      <section className="card flush" aria-label={t('Research results')}>
        <div className="head">
          <h2>{t('Research results')}</h2>
          <span className="head-note">
            {withNodes(t('Values marked {ai} were found by research; the line under each shows the source and confidence.', { ai: NODE[0] }), [
              <span key="ai" className="tag-ai flat">AI</span>,
            ])}
          </span>
        </div>
        <ScrollBox sticky={1}>
          <table>
            <thead>
              <tr>
                {COLUMNS.map((f) => (
                  <th key={f} scope="col">
                    {importColumnLabel(f, lang)}
                  </th>
                ))}
                <th scope="col">{t('Research')}</th>
              </tr>
            </thead>
            <tbody>
              {v.items.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length + 1} className="empty">
                    {t('No rows to research yet.')}
                  </td>
                </tr>
              ) : (
                v.items.map((r) => <ResearchRow key={r.id} row={r} />)
              )}
            </tbody>
          </table>
        </ScrollBox>
        {v.total > IMPORT_PAGE_SIZE ? (
          <div className="foot">
            <Pager page={page} pageSize={IMPORT_PAGE_SIZE} total={v.total} onPage={setPage} />
          </div>
        ) : null}
      </section>
      {v.activity.length ? (
        <div className="card">
          <h2>{t('Activity')}</h2>
          <ul className="agenda">
            {v.activity.map((a, i) => (
              <li key={`${a.at}-${i}`}>
                <span className="ag-time">{hhmm(a.at, me.timezone)}</span>
                <div className="ag-body">{importActivityText(a, lang)}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="actions-row">
        <button type="button" className="btn" onClick={onBack}>
          {t('← Back')}
        </button>
        <span className="grow" />
        <span className="muted-text">{t('You can review rows already done while research continues.')}</span>
        <button type="button" className="btn primary" onClick={onNext}>
          {t('Review →')}
        </button>
      </div>
    </section>
  );
}

function ResearchRow({ row: r }: { row: ImportRowView }) {
  const t = useT();
  const lang = useLang();
  const badge = researchBadge(t, r.researchStatus);
  const finished = r.researchStatus !== undefined && !['waiting', 'running'].includes(r.researchStatus);
  const cell = (f: ImportField) => {
    const own = r.fields[f];
    const found = r.research?.[f];
    if (found) {
      return (
        <>
          {found.value}
          <span className="tag-ai">AI</span>
          <span className="cell-sub">
            {sourceLabelText(t, found.sourceLabel)} · {found.confidence}%
          </span>
        </>
      );
    }
    if (own) return own;
    if (r.researchStatus === 'running') return <span className="dim">{f === 'website' ? t('searching…') : '…'}</span>;
    if (finished) return <span className="dim">{t('not found')}</span>;
    return <span className="dim">—</span>;
  };
  return (
    <tr>
      {COLUMNS.map((f) => (
        <td key={f} className={f === 'companyName' ? 'strong' : undefined}>
          {cell(f)}
        </td>
      ))}
      <td>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
        {r.researchStatus === 'failed' && r.researchNote?.length ? <span className="cell-sub">{importResearchNoteText(r.researchNote, lang)}</span> : null}
      </td>
    </tr>
  );
}
