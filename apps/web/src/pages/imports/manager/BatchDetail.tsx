import { useState, type MouseEvent } from 'react';
import {
  IMPORT_TABLE_FIELDS, importColumnLabel, importContinueHintText, importFailureText, importRowErrorText, problemText,
  type ImportField, type Lang, type ProblemCode, type RowProblem,
} from '@dait-crm/shared';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import {
  IMPORT_PAGE_SIZE, originalFileUrl, rowsCsvUrl, rowsToFixUrl, useBatch, useBatchRows, useContinueImport,
  type BatchDetail, type BatchFile, type ImportRowView,
} from '../../../api/imports';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Pager } from '../../../components/Pager';
import { ScrollBox } from '../../../components/Table';
import { Tabs } from '../../../components/Tabs';
import { useToast } from '../../../components/Toast';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { useLang, useT } from '../../../i18n/useT';
import { IN_WIZARD, fileBadge, importErrorText, sizeText } from '../labels';
import { RowStatusBadge } from '../RowStatusBadge';
import { originText } from '../wizard/StepSort';
import { UndoModal, undoCounts } from './UndoModal';

type Tab = 'imported' | 'updated' | 'skipped' | 'errors' | 'files';

/**
 * One batch (mockup "Batch IMPORT-…" card): Imported / Skipped / Errors / Original files, the downloads, "Open leads in
 * Leads list", Undo (Administrators, when the batch can be undone) and, for a Failed import, why and "Continue import".
 * A batch not imported yet links back to the wizard.
 */
export function BatchDetailCard({ id }: { id: number }) {
  const t = useT();
  const { data: b, error } = useBatch(id, true);
  if (!b) {
    return (
      <section className="card" aria-label={t('Batch')}>
        <p className={error ? undefined : 'muted-text'} role={error ? 'alert' : undefined}>
          {error ? (error instanceof ApiError && error.status === 404 ? t('Import not found') : t('Something went wrong. Try again.')) : t('Loading…')}
        </p>
      </section>
    );
  }
  const title = t('Batch {number}', { number: b.number });
  return (
    <section className="card flush" aria-label={title}>
      <div className="head">
        <h2>{title}</h2>
        <span className="head-note">{t('Everything about one import: the original files, every row and what happened to it, and the leads it created.')}</span>
      </div>
      {IN_WIZARD.has(b.status) ? (
        <div className="l2col">
          <div className="note info">{t('This import is not finished yet. It carries on in the wizard, at the step it reached.')}</div>
          <div className="actions-row">
            <Link className="btn sm primary" to={`/leads/import?batch=${b.id}`}>
              {t('Continue in the wizard')}
            </Link>
          </div>
        </div>
      ) : (
        <ImportedDetail b={b} />
      )}
    </section>
  );
}

function ImportedDetail({ b }: { b: BatchDetail }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('imported');
  const counts = b.counts ?? { imported: 0, skipped: 0, errors: 0 };
  const updated = counts.updated ?? 0;
  return (
    <Tabs
      label={t('Batch rows')}
      active={tab}
      onChange={(next) => setTab(next as Tab)}
      tabs={[
        { id: 'imported', label: t('Imported|rows'), count: counts.imported },
        ...(updated > 0 ? [{ id: 'updated', label: t('Updated|rows'), count: updated }] : []),
        { id: 'skipped', label: t('Skipped|rows'), count: counts.skipped },
        { id: 'errors', label: t('Errors'), count: counts.errors },
        { id: 'files', label: t('Original files') },
      ]}
    >
      <BatchActions b={b} />
      {tab === 'files' ? (
        <FilesTable files={b.files ?? []} />
      ) : (
        // Keyed by tab: each tab starts on its own page 1.
        <RowsTable key={tab} batchId={b.id} tab={tab} poll={b.status === 'Importing'} />
      )}
    </Tabs>
  );
}

/** The actions and the batch's state (Failed: why + Continue; Importing; Undone: when, by whom, what was removed). */
function BatchActions({ b }: { b: BatchDetail }) {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const toast = useToast();
  const { dateTime } = useFormatDate();
  const continueImport = useContinueImport(b.id);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canUndo = me.can('undo_imports') && b.canUndo === true;
  const failed = b.status === 'Failed';

  function onContinue() {
    setError(null);
    continueImport.mutate(undefined, {
      onSuccess: () => toast(t('Import continued')),
      onError: (e) => setError(importErrorText(t, e instanceof ApiError ? e.code : '')),
    });
  }

  return (
    <div className="l2col">
      {failed ? <div className="note danger">{importFailureText(b.importError ?? 'job_failed', lang)}</div> : null}
      {b.status === 'Importing' ? <div className="note info">{t('Importing… The rows and counts update as it goes.')}</div> : null}
      {b.status === 'Undone' ? <UndoneNote b={b} when={b.undoneAt ? dateTime(b.undoneAt) : ''} /> : null}
      <div className="actions-row">
        {failed ? (
          <button type="button" className="btn sm primary" disabled={continueImport.isPending} onClick={onContinue}>
            {t('Continue import')}
          </button>
        ) : null}
        <a className="btn sm" href={rowsCsvUrl(b.id)}>
          {t('Download rows (CSV)')}
        </a>
        <a className="btn sm" href={rowsToFixUrl(b.id, false, null)}>
          {t('Download rows to fix (Excel)')}
        </a>
        <Link className="btn sm" to={`/leads?q=${encodeURIComponent(b.number)}`}>
          {t('Open leads in Leads list')}
        </Link>
        {canUndo ? (
          <button type="button" className="btn sm danger" onClick={() => setUndoing(true)}>
            {t('Undo this import…')}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="note danger" role="alert">
          {error}
        </div>
      ) : null}
      {failed || b.status === 'Importing' ? <p className="muted-text">{importContinueHintText(lang)}</p> : null}
      {b.counts?.updated ? (
        <div className={b.counts.conflicts ? 'note warn' : 'note info'}>
          {b.counts.updated === 1 ? t('1 row updated a lead already in the CRM (empty fields only).') : t('{n} rows updated leads already in the CRM (empty fields only).', { n: b.counts.updated })}{' '}
          {b.counts.conflicts
            ? t('Conflicts: {n} values differ from the CRM and were not changed (see Download rows to fix).', { n: b.counts.conflicts })
            : t('Conflicts: none.')}
        </div>
      ) : null}
      {canUndo ? (
        <div className="note info">
          {t("Undo removes leads and companies this batch created that nobody has worked on yet (no emails, notes, tasks or quotations). Anything already worked on stays, and you're shown a list first.")}
        </div>
      ) : null}
      {undoing ? <UndoModal batch={b} onClose={() => setUndoing(false)} /> : null}
    </div>
  );
}

function UndoneNote({ b, when }: { b: BatchDetail; when: string }) {
  const t = useT();
  const u = b.undo;
  const counts = u ? undoCounts(t, { leads: u.remove.leads.length, contacts: u.remove.contacts, companies: u.remove.companies }) : null;
  return (
    <div className="note info">
      {b.undoneBy ? t('Undone {when} by {name}.', { when, name: b.undoneBy }) : t('Undone {when}.', { when })}
      {counts ? ` ${t('Removed: {leads}, {contacts}, {companies}.', counts)}` : null}
      {u && u.keep.length > 0 ? ` ${u.keep.length === 1 ? t('1 record was kept because someone worked on it.') : t('{n} records were kept because someone worked on them.', { n: u.keep.length })}` : null}
    </div>
  );
}

/** An updated row's values that were not applied ("Phone: CRM has …, file has …"), in plain words. */
export function conflictsText(r: ImportRowView, lang: Lang): string {
  return (r.changes?.conflicts ?? [])
    .map((c) => problemText(c.unknown
      ? { code: 'industry_unknown', field: c.field, level: 'questionable', value: c.file }
      : { code: 'update_conflict', field: c.field, level: 'questionable', crm: c.crm, value: c.file }, lang))
    .join('; ');
}

/** "What to fix" for a skipped row: its problems, then why it was left out (once per code), in plain words. */
export function skippedText(r: ImportRowView, lang: Lang): string {
  const problems: RowProblem[] = [...r.problems];
  const code = r.outcomeCode;
  if (code && !problems.some((p) => p.code === code)) {
    const value = code === 'already_in_crm' ? r.matched?.number : code === 'country_unknown' ? r.fields.country ?? '' : undefined;
    problems.push({ code: code as ProblemCode, level: 'info', ...(value !== undefined ? { value } : {}) });
  }
  const seen = new Set<string>();
  return problems
    .filter((p) => !seen.has(p.code) && seen.add(p.code))
    .map((p) => problemText(p, lang))
    .join('; ');
}

/** A website on screen: a link only when it is an http(s) address, otherwise plain text. */
function WebsiteCell({ value }: { value: string }) {
  return /^https?:\/\/[^\s]+$/i.test(value) ? (
    <a href={value} target="_blank" rel="noopener noreferrer">
      {value}
    </a>
  ) : (
    <>{value}</>
  );
}

const ROWS_FILTER = { imported: 'imported', updated: 'updated', skipped: 'skipped', errors: 'errors' } as const;

function RowsTable({ batchId, tab, poll }: { batchId: number; tab: Exclude<Tab, 'files'>; poll: boolean }) {
  const t = useT();
  const lang = useLang();
  const [page, setPage] = useState(1);
  const { data, isPending } = useBatchRows(batchId, ROWS_FILTER[tab], page, poll);
  const items = data?.items ?? [];
  const extra =
    tab === 'imported'
      ? [importColumnLabel('lead', lang), importColumnLabel('company', lang)]
      : tab === 'updated'
        ? [importColumnLabel('lead', lang), importColumnLabel('company', lang), t('Not changed (differs from the CRM)')]
      : tab === 'skipped'
        ? [importColumnLabel('whatToFix', lang)]
        : [t('Why it was not imported')];
  const columns = IMPORT_TABLE_FIELDS.length + 2 + extra.length;
  return (
    <>
      <ScrollBox sticky={1}>
        <table>
          <thead>
            <tr>
              {IMPORT_TABLE_FIELDS.map((f) => (
                <th key={f} scope="col">
                  {importColumnLabel(f, lang)}
                </th>
              ))}
              <th scope="col">{importColumnLabel('from', lang)}</th>
              <th scope="col">{importColumnLabel('status', lang)}</th>
              {extra.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={columns} className="empty">
                  {isPending ? t('Loading…') : t('No rows here.')}
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={r.id}>
                  {IMPORT_TABLE_FIELDS.map((f: ImportField) => (
                    <td key={f} className={f === 'companyName' ? 'strong' : undefined}>
                      {f === 'website' && r.fields.website ? <WebsiteCell value={r.fields.website} /> : r.fields[f] ?? ''}
                    </td>
                  ))}
                  <td className="muted">{originText(t, r.origin)}</td>
                  <td>
                    <RowStatusBadge row={r} />
                  </td>
                  {tab === 'updated' ? (
                    <>
                      <td>
                        {r.lead ? (
                          <Link className="id-link" to={`/leads/${r.lead.id}`}>
                            {r.lead.number}
                          </Link>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td>
                        {r.company ? (
                          <Link className="id-link" to={`/companies/${r.company.id}`}>
                            {r.company.number}
                          </Link>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td>{conflictsText(r, lang) || <span className="dim">—</span>}</td>
                    </>
                  ) : tab === 'imported' ? (
                    <>
                      <td>
                        {r.lead ? (
                          <Link className="id-link" to={`/leads/${r.lead.id}`}>
                            {r.lead.number}
                          </Link>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td>
                        {r.company ? (
                          <>
                            <Link className="id-link" to={`/companies/${r.company.id}`}>
                              {r.company.number}
                            </Link>
                            <span className="cell-sub">{r.company.created ? t('new|company') : t('existing|company')}</span>
                          </>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </>
                  ) : tab === 'skipped' ? (
                    <td>{skippedText(r, lang)}</td>
                  ) : (
                    <td>{importRowErrorText(r.error, lang)}</td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollBox>
      {data && data.total > IMPORT_PAGE_SIZE ? (
        <div className="foot">
          <Pager page={page} pageSize={IMPORT_PAGE_SIZE} total={data.total} onPage={setPage} />
        </div>
      ) : null}
    </>
  );
}

/** The uploaded files: name, type, size, read status, and a download (or "Deleted after 90 days"). */
function FilesTable({ files }: { files: BatchFile[] }) {
  const t = useT();
  const toast = useToast();
  // Files the server answered 410 for (retention removed them since the page loaded).
  const [gone, setGone] = useState<Set<number>>(new Set());

  async function download(e: MouseEvent<HTMLAnchorElement>, f: BatchFile) {
    e.preventDefault();
    try {
      const res = await fetch(originalFileUrl(f.id), { credentials: 'same-origin' });
      if (res.status === 410) {
        setGone((s) => new Set(s).add(f.id));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast(t('Something went wrong. Try again.'), 'warn');
    }
  }

  return (
    <ScrollBox sticky={1}>
      <table>
        <thead>
          <tr>
            <th scope="col">{t('File')}</th>
            <th scope="col">{t('Type')}</th>
            <th scope="col">{t('Size')}</th>
            <th scope="col">{t('Read status')}</th>
            <th scope="col">
              <span className="sr">{t('Download')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {files.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                {t('No files.')}
              </td>
            </tr>
          ) : (
            files.map((f) => {
              const badge = fileBadge(t, f.status);
              const deleted = f.deletedAt !== null || gone.has(f.id);
              return (
                <tr key={f.id}>
                  <td className="strong">{f.name}</td>
                  <td>{f.ext.toUpperCase()}</td>
                  <td>{sizeText(f.size)}</td>
                  <td>
                    <span className={`badge ${badge.cls}`}>{badge.text}</span>
                  </td>
                  <td>
                    {deleted ? (
                      <span className="dim">{t('Deleted after 90 days')}</span>
                    ) : (
                      <a href={originalFileUrl(f.id)} download={f.name} aria-label={t('Download {file}', { file: f.name })} onClick={(e) => void download(e, f)}>
                        {t('Download')}
                      </a>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </ScrollBox>
  );
}
