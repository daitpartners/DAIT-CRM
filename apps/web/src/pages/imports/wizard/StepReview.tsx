import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OutreachLanguage } from '@dait-crm/shared';
import { ApiError, api } from '../../../api/client';
import { rowsToFixUrl, useRematch, useReview, useStartImport, type NoContactChoice, type ReviewView } from '../../../api/imports';
import { keys } from '../../../api/queries';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Tile } from '../../../components/Tile';
import { useT, type TFn } from '../../../i18n/useT';
import { OUTREACH_LABEL } from '../../../lib/outreach';
import { NODE, importErrorText, withNodes } from '../labels';

type Props = { batchId: number; onBack: () => void };

/** "Import 412 prospects" / "Import 1 lead". */
export function importButtonText(t: TFn, n: number, leadType: string): string {
  if (leadType === 'Lead') return n === 1 ? t('Import 1 lead') : t('Import {n} leads', { n });
  return n === 1 ? t('Import 1 prospect') : t('Import {n} prospects', { n });
}

/** "39 already in CRM · 7 not leads · 10 unticked" (parts that are 0 left out). */
function skippedMeta(t: TFn, s: ReviewView['skipped']): string {
  const parts: string[] = [];
  if (s.alreadyInCrm) parts.push(t('{n} already in CRM', { n: s.alreadyInCrm }));
  if (s.notLead) parts.push(s.notLead === 1 ? t('1 not a lead') : t('{n} not leads', { n: s.notLead }));
  if (s.unticked) parts.push(t('{n} unticked', { n: s.unticked }));
  if (s.other) parts.push(t('{n} need fixing', { n: s.other }));
  return parts.join(' · ');
}

/**
 * Step 4 (mockup #s4): what the import will do with the current choices. "Accept research values ≥ 80%" and the
 * notification box start unticked; "Import them / Leave them out" has no default and must be chosen when rows need it.
 */
export function StepReview({ batchId, onBack }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [acceptHigh, setAcceptHigh] = useState(false);
  const [notify, setNotify] = useState(false);
  const [choice, setChoice] = useState<NoContactChoice>(null);
  const [needChoice, setNeedChoice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: r } = useReview(batchId, acceptHigh, choice);
  const start = useStartImport(batchId);
  const rematch = useRematch(batchId);
  const addCountries = useMutation({
    mutationFn: async (values: string[]) => {
      for (const value of values) {
        try {
          await api('/api/lookups', { method: 'POST', body: { group: 'country', value, label: value } });
        } catch (e) {
          // Added meanwhile by someone else: the rematch below still finds it.
          if (!(e instanceof ApiError && e.code === 'duplicate_value')) throw e;
        }
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.lookups });
      rematch.mutate();
    },
    onError: (e) => setError(importErrorText(t, e instanceof ApiError ? e.code : '')),
  });

  if (!r) return null;
  const typeText = r.leadType === 'Lead' ? t('Leads') : t('Prospects');
  const langText = OUTREACH_LABEL[r.language as OutreachLanguage] ?? r.language;
  const allocation = r.allocation.map((a) => (a.people.length ? `${a.name} → ${a.people.join(', ')}` : a.name)).join('; ');
  const unknownCount = r.unknownCountries.reduce((n, c) => n + c.count, 0);
  const unknownList = r.unknownCountries.map((c) => `${c.value} ×${c.count}`).join(', ');
  const nothingNeeded = r.noContactRows === 0 && r.researchOnlyCountry === 0 && unknownCount === 0;

  function doImport() {
    setError(null);
    if (r!.noContactRows > 0 && choice === null) {
      setNeedChoice(true);
      return;
    }
    start.mutate(
      { acceptHigh, noContactRows: r!.noContactRows > 0 ? choice : null, notify },
      {
        onSuccess: () => navigate(`/leads/import/manager?batch=${batchId}`),
        onError: (e) => {
          const code = e instanceof ApiError ? e.code : '';
          if (code === 'choice_required') setNeedChoice(true);
          else setError(importErrorText(t, code));
        },
      },
    );
  }

  return (
    <section className="wiz" aria-label={t('Step 4 of 4: Review and import')}>
      <p className="muted-text">{t('Step 4 of 4 · Approve and save')}</p>
      <div className="tiles">
        <Tile label={t('Will be imported')} value={r.willImport} meta={t('as {type} · {language}', { type: typeText, language: langText })} />
        <Tile label={t('New companies')} value={r.newCompanies} />
        <Tile label={t('Added to existing companies')} value={r.existingCompanies} />
        <Tile label={t('Skipped')} value={r.skipped.total} meta={skippedMeta(t, r.skipped) || undefined} />
      </div>
      <div className="grid2">
        <div className="card">
          <h2>{t('Before you import')}</h2>
          <ul className="rules">
            <li>
              {withNodes(
                t('Values found by research are saved as {suggestions} on the company (AI Intelligence tab), not as confirmed facts, unless you tick {accept}.', {
                  suggestions: NODE[0], accept: NODE[1],
                }),
                [<b key="s">{t('suggestions')}</b>, <b key="a">{t('Accept research values ≥ 80%')}</b>],
              )}
            </li>
            <li>
              {allocation
                ? withNodes(t('Leads are allocated by your existing rule: {rule}.', { rule: NODE[0] }), [<b key="r">{allocation}</b>])
                : t('No allocation rule matches this language: the leads are imported unassigned.')}
            </li>
            <li>
              {withNodes(t('Source on each lead: {source}, so you can find or undo this batch in the Data manager.', { source: NODE[0] }), [
                <b key="src">{r.source}</b>,
              ])}
            </li>
          </ul>
          <label className="check">
            <input type="checkbox" checked={acceptHigh} onChange={(e) => setAcceptHigh(e.target.checked)} />{' '}
            {t('Accept research values with confidence 80% or higher')}
          </label>
          <label className="check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> {t('Send each assignee one notification for the batch')}
          </label>
        </div>
        <div className="card">
          <h2>{t('Rows that still need you')}</h2>
          {r.noContactRows > 0 ? (
            <>
              <p className="info-text">
                {r.noContactRows === 1
                  ? t('1 row has no email or phone after research. Import it anyway (it waits in research) or leave it out.')
                  : t('{n} rows have no email or phone after research. Import them anyway (they wait in research) or leave them out.', { n: r.noContactRows })}
              </p>
              <div className="actions-row" role="radiogroup" aria-label={t('Rows with no email or phone')}>
                <label className="mradio">
                  <input type="radio" name="imp-nocontact" checked={choice === 'import'} onChange={() => { setChoice('import'); setNeedChoice(false); }} />{' '}
                  {t('Import them')}
                </label>
                <label className="mradio">
                  <input type="radio" name="imp-nocontact" checked={choice === 'leave'} onChange={() => { setChoice('leave'); setNeedChoice(false); }} />{' '}
                  {t('Leave them out')}
                </label>
              </div>
              {needChoice && choice === null ? <div className="err-msg">{t('Choose Import them or Leave them out.')}</div> : null}
            </>
          ) : null}
          {r.researchOnlyCountry > 0 ? (
            <p className="info-text">
              {r.researchOnlyCountry === 1
                ? t('1 row has a country only from research. Tick Accept research values with confidence 80% or higher, or fix it in the rows-to-fix download.')
                : t('{n} rows have a country only from research. Tick Accept research values with confidence 80% or higher, or fix them in the rows-to-fix download.', { n: r.researchOnlyCountry })}
            </p>
          ) : null}
          {unknownCount > 0 ? (
            <div className="note warn">
              {withNodes(
                unknownCount === 1
                  ? t("1 row has a country the CRM doesn't know yet ({list}). {action} or leave the row out.", { list: unknownList, action: NODE[0] })
                  : t("{n} rows have a country the CRM doesn't know yet ({list}). {action} or leave the rows out.", { n: unknownCount, list: unknownList, action: NODE[0] }),
                [
                  me.can('manage_lookups') ? (
                    <a
                      key="add"
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (!addCountries.isPending && !rematch.isPending) addCountries.mutate(r.unknownCountries.map((c) => c.value));
                      }}
                    >
                      {t('Add these countries')}
                    </a>
                  ) : (
                    <span key="ask">{t('Ask an Administrator to add these countries')}</span>
                  ),
                ],
              )}
            </div>
          ) : null}
          {nothingNeeded ? <p className="info-text">{t('No rows need you.')}</p> : null}
        </div>
      </div>
      {error ? (
        <div className="note danger" role="alert">
          {error}
        </div>
      ) : null}
      <div className="actions-row">
        <button type="button" className="btn" onClick={onBack}>
          {t('← Back')}
        </button>
        <a className="btn" href={rowsToFixUrl(batchId, acceptHigh, choice)} download>
          {t('Download rows to fix (Excel)')}
        </a>
        <span className="grow" />
        <button type="button" className="btn primary" disabled={r.willImport === 0 || start.isPending} onClick={doImport}>
          {importButtonText(t, r.willImport, r.leadType)}
        </button>
      </div>
    </section>
  );
}
