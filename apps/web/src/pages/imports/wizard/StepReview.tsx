import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OutreachLanguage } from '@dait-crm/shared';
import { ApiError, api } from '../../../api/client';
import { importKeys, rowsToFixUrl, useReview, useStartImport, type NoContactChoice, type ReviewView } from '../../../api/imports';
import { keys } from '../../../api/queries';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Modal } from '../../../components/Modal';
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

/** "Update 3 existing leads" when the batch only updates. */
export function updateButtonText(t: TFn, n: number): string {
  return n === 1 ? t('Update 1 existing lead') : t('Update {n} existing leads', { n });
}

/**
 * Update rows (Lead ID / Company ID) in step 4: "3 rows will update 7 empty fields; 2 values differ (not changed — see
 * Download rows to fix)", and the rows whose id cannot be used. Empty when there are none.
 */
export function updatesText(t: TFn, u: ReviewView['updates']): string[] {
  if (!u) return [];
  const out: string[] = [];
  if (u.rows > 0) {
    const rows = u.rows === 1
      ? t('1 row will update {fields}', { fields: u.fields === 1 ? t('1 empty field') : t('{n} empty fields', { n: u.fields }) })
      : t('{n} rows will update {fields}', { n: u.rows, fields: u.fields === 1 ? t('1 empty field') : t('{n} empty fields', { n: u.fields }) });
    const differ = u.conflicts === 0 ? t('no values differ from the CRM')
      : u.conflicts === 1 ? t('1 value differs (not changed — see Download rows to fix)')
        : t('{n} values differ (not changed — see Download rows to fix)', { n: u.conflicts });
    out.push(`${rows}; ${differ}.`);
  }
  if (u.errors > 0) {
    out.push(u.errors === 1
      ? t('1 row has a Lead ID or Company ID that is not in the CRM, not yours or does not match: it is not imported (see Download rows to fix).')
      : t('{n} rows have a Lead ID or Company ID that is not in the CRM, not yours or does not match: they are not imported (see Download rows to fix).', { n: u.errors }));
  }
  return out;
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
  const [error, setError] = useState<string | null>(null);
  const [addingCountries, setAddingCountries] = useState(false);
  const hintId = useId();
  const { data: r } = useReview(batchId, acceptHigh, choice);
  const start = useStartImport(batchId);
  // Added (or switched back on) on the server, the file's spelling mapped for this batch's rows, then matched again.
  const addCountries = useMutation({
    mutationFn: (countries: { from: string; to: string }[]) =>
      api<{ countries: string[] }>(`/api/imports/batches/${batchId}/countries`, { method: 'POST', body: { countries } }),
    onSuccess: () => setAddingCountries(false),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.lookups }), qc.invalidateQueries({ queryKey: importKeys.all })]),
  });

  if (!r) return null;
  const typeText = r.leadType === 'Lead' ? t('Leads') : t('Prospects');
  const langText = OUTREACH_LABEL[r.language as OutreachLanguage] ?? r.language;
  const allocation = r.allocation.map((a) => (a.people.length ? `${a.name} → ${a.people.join(', ')}` : a.name)).join('; ');
  const unknownCount = r.unknownCountries.reduce((n, c) => n + c.count, 0);
  const unknownList = r.unknownCountries.map((c) => `${c.value} ×${c.count}`).join(', ');
  const nothingNeeded = r.noContactRows === 0 && r.researchOnlyCountry === 0 && unknownCount === 0;
  // Rows with no email or phone wait for Import them / Leave them out: Import stays off (the server leaves them out of
  // every total until the choice is made).
  const undecided = r.noContactRows > 0 && choice === null;
  const importCount = r.willImport;
  const updateCount = r.updates?.rows ?? 0;
  const updateLines = updatesText(t, r.updates);

  function doImport() {
    setError(null);
    if (undecided) return;
    start.mutate(
      { acceptHigh, noContactRows: r!.noContactRows > 0 ? choice : null, notify },
      {
        onSuccess: () => navigate(`/leads/import/manager?batch=${batchId}`),
        onError: (e) => setError(importErrorText(t, e instanceof ApiError ? e.code : '')),
      },
    );
  }

  return (
    <section className="wiz" aria-label={t('Step 4 of 4: Review and import')}>
      <p className="muted-text">{t('Step 4 of 4 · Approve and save')}</p>
      <div className="tiles">
        <Tile label={t('Will be imported')} value={importCount} meta={t('as {type} · {language}', { type: typeText, language: langText })} />
        <Tile label={t('New companies')} value={r.newCompanies} />
        <Tile label={t('Added to existing companies')} value={r.existingCompanies} />
        <Tile label={t('Skipped')} value={r.skipped.total} meta={skippedMeta(t, r.skipped) || undefined} />
      </div>
      {updateLines.length > 0 ? (
        <div className={(r.updates?.conflicts ?? 0) > 0 || (r.updates?.errors ?? 0) > 0 ? 'note warn' : 'note info'} role="status">
          {updateLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : null}
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
              <div
                className="actions-row"
                role="radiogroup"
                aria-label={t('Rows with no email or phone')}
                aria-describedby={undecided ? hintId : undefined}
              >
                <label className="mradio">
                  <input type="radio" name="imp-nocontact" checked={choice === 'import'} onChange={() => setChoice('import')} /> {t('Import them')}
                </label>
                <label className="mradio">
                  <input type="radio" name="imp-nocontact" checked={choice === 'leave'} onChange={() => setChoice('leave')} /> {t('Leave them out')}
                </label>
              </div>
              <div id={hintId} className="muted-text" role="status" aria-live="polite">
                {undecided ? t('Choose Import them or Leave them out to continue.') : null}
              </div>
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
                        setError(null);
                        addCountries.reset();
                        setAddingCountries(true);
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
        <a className="btn" href={rowsToFixUrl(batchId, acceptHigh, choice)}>
          {t('Download rows to fix (Excel)')}
        </a>
        <span className="grow" />
        <button
          type="button"
          className="btn primary"
          disabled={importCount + updateCount === 0 || undecided || start.isPending}
          aria-describedby={undecided ? hintId : undefined}
          onClick={doImport}
        >
          {importCount === 0 && updateCount > 0 ? updateButtonText(t, updateCount) : importButtonText(t, importCount, r.leadType)}
        </button>
      </div>
      {addingCountries ? (
        <AddCountriesModal
          countries={r.unknownCountries}
          busy={addCountries.isPending}
          error={addCountries.error ? importErrorText(t, addCountries.error instanceof ApiError ? addCountries.error.code : '') : null}
          onClose={() => setAddingCountries(false)}
          onSave={(items) => addCountries.mutate(items)}
        />
      ) : null}
    </section>
  );
}

/**
 * "Add these countries" (Administrators): each unknown country with its name ready to correct before it is saved as a
 * country in the CRM's lists; then the rows are matched again.
 */
function AddCountriesModal({ countries, busy, error, onClose, onSave }: {
  countries: { value: string; count: number }[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** Each unknown country: the file's spelling and the name to save. */
  onSave: (items: { from: string; to: string }[]) => void;
}) {
  const t = useT();
  const [names, setNames] = useState(() => countries.map((c) => c.value.trim().slice(0, 100)));
  const ok = names.every((n) => n.trim() !== '');
  return (
    <Modal
      title={t('Add these countries')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <span className="grow" />
          <button type="button" className="btn primary" disabled={!ok || busy} onClick={() => onSave(countries.map((c, i) => ({ from: c.value, to: names[i]!.trim() })))}>
            {t('Add countries')}
          </button>
        </>
      }
    >
      <p className="muted-text">{t('Each name is added to the country list in Settings (a country that is switched off is switched back on). If you correct a spelling, this import\'s rows with the file\'s spelling use your name.')}</p>
      {countries.map((c, i) => (
        <div key={c.value}>
          <label className="lbl" htmlFor={`imp-country-${i}`}>
            {c.count === 1 ? t('{value} (1 row)', { value: c.value }) : t('{value} ({n} rows)', { value: c.value, n: c.count })}
          </label>
          <input
            id={`imp-country-${i}`}
            className="in"
            maxLength={100}
            value={names[i]}
            onChange={(e) => setNames((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
          />
        </div>
      ))}
      {error ? (
        <div className="note danger" role="alert">
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
