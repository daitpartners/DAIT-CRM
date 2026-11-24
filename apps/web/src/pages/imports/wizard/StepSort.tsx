import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { IMPORT_TABLE_FIELDS, importColumnLabel, importRowStatusText, type ImportField, type RowFilter } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import {
  IMPORT_PAGE_SIZE, useAnswerColumn, useBatchRows, useIncludeAll, useStartResearch, useUpdateRow, type ImportRowView, type OpenQuestion,
} from '../../../api/imports';
import { Pager } from '../../../components/Pager';
import { ScrollBox } from '../../../components/Table';
import { Tile } from '../../../components/Tile';
import { useToast } from '../../../components/Toast';
import { useLang, useT, type TFn } from '../../../i18n/useT';
import { FIELD_OPTIONS, NODE, fieldOptionLabel, importErrorText, rowStatusBadge, withNodes } from '../labels';

type Props = { batchId: number; batchStatus: string; onBack: () => void; onNext: () => void };

/** Step 2 (mockup #s2): tiles, the unsure-column question, and the sorted rows (editable, tickable, 100 a page). */
export function StepSort({ batchId, batchStatus, onBack, onNext }: Props) {
  const t = useT();
  const lang = useLang();
  const [filter, setFilter] = useState<RowFilter>('all');
  const [page, setPage] = useState(1);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data } = useBatchRows(batchId, filter, page);
  const includeAll = useIncludeAll(batchId);
  const updateRow = useUpdateRow();
  const start = useStartResearch();
  const tiles = data?.tiles;
  const items = data?.items ?? [];
  const toast = useToast();
  const refused = (e: unknown) => toast(importErrorText(t, e instanceof ApiError ? e.code : ''), 'warn');
  // The header tick reads the whole filter (every page): all, none or some of its rows ticked.
  const total = data?.total ?? 0;
  const included = data?.included ?? 0;
  const allTicked = total > 0 && included === total;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headRef.current) headRef.current.indeterminate = included > 0 && included < total;
  }, [included, total]);

  function research() {
    setError(null);
    // Research already started (or done) for this batch: step 3 shows it; a new start would research the rows again.
    if (batchStatus !== 'Sorting') return onNext();
    start.mutate(batchId, {
      onSuccess: onNext,
      onError: (e) => {
        const code = e instanceof ApiError ? e.code : '';
        if (code === 'research_stopped') return onNext();
        setError(importErrorText(t, code));
      },
    });
  }

  const count = (n: number | undefined) => n ?? 0;
  return (
    <section className="wiz" aria-label={t('Step 2 of 4: Sort the data')}>
      <p className="muted-text">
        {t('Step 2 of 4 · The engine builds the table. It read each file, found the people and companies in it, and put every value in the right column.')}
      </p>
      <div className="tiles t5">
        <Tile label={t('Rows found')} value={count(tiles?.rows)} meta={tiles?.files === 1 ? t('from 1 file') : t('from {n} files', { n: count(tiles?.files) })} />
        <Tile label={t('Ready')} value={count(tiles?.ready)} meta={t('company + country + email')} metaClass="ok" />
        <Tile label={t('Missing details')} value={count(tiles?.missing)} meta={t('go to AI research')} metaClass="warn" />
        <Tile label={t('Already in CRM')} value={count(tiles?.already)} meta={t('matched by website or name')} />
        <Tile label={t('Not a lead')} value={count(tiles?.notLead)} meta={t('headers, totals, blank lines')} />
      </div>
      {data?.question ? <ColumnQuestionNote key={`${data.question.fileId}-${data.question.sheet}-${data.question.col}`} question={data.question} onDone={setDone} /> : null}
      {done ? (
        <div className="note ok" role="status">
          {done}
        </div>
      ) : null}
      <section className="card flush l2" aria-label={t('Sorted rows')}>
        <div className="head">
          <h2>{t('Sorted into lead and company fields')}</h2>
          <span className="head-note">{t('Click any cell to edit it.')}</span>
          <span className="grow" />
          <label className="sr" htmlFor="imp-row-filter">
            {t('Show rows')}
          </label>
          <select
            id="imp-row-filter"
            className="chip"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as RowFilter);
              setPage(1);
            }}
          >
            <option value="all">{t('All rows ({n})', { n: count(tiles?.rows) })}</option>
            <option value="missing">{t('Missing details ({n})', { n: count(tiles?.missing) })}</option>
            <option value="already">{t('Already in CRM ({n})', { n: count(tiles?.already) })}</option>
            <option value="notlead">{t('Not a lead ({n})', { n: count(tiles?.notLead) })}</option>
          </select>
        </div>
        <ScrollBox sticky={2}>
          <table>
            <thead>
              <tr>
                <th scope="col" className="ck">
                  <input
                    ref={headRef}
                    type="checkbox"
                    aria-label={t('Include all {n} rows in this view', { n: total })}
                    checked={allTicked}
                    disabled={total === 0}
                    onChange={() => includeAll.mutate({ filter, include: !allTicked }, { onError: refused })}
                  />
                </th>
                {IMPORT_TABLE_FIELDS.map((f) => (
                  <th key={f} scope="col">
                    {importColumnLabel(f, lang)}
                  </th>
                ))}
                <th scope="col">{importColumnLabel('from', lang)}</th>
                <th scope="col">{importColumnLabel('status', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <SortRow key={r.id} row={r} onTick={(include) => updateRow.mutate({ id: r.id, body: { include } }, { onError: refused })} />
              ))}
            </tbody>
          </table>
        </ScrollBox>
        <div className="foot">
          {count(tiles?.missing) === 1
            ? t('1 row goes to research. Rows already in the CRM are skipped unless you tick them.')
            : t('{n} rows go to research. Rows already in the CRM are skipped unless you tick them.', { n: count(tiles?.missing) })}
        </div>
        {data && data.total > IMPORT_PAGE_SIZE ? (
          <div className="foot">
            <Pager page={page} pageSize={IMPORT_PAGE_SIZE} total={data.total} onPage={setPage} />
          </div>
        ) : null}
      </section>
      {error ? (
        <div className="note danger" role="alert">
          {error}
        </div>
      ) : null}
      <div className="actions-row">
        <button type="button" className="btn" onClick={onBack}>
          {t('← Back')}
        </button>
        <span className="grow" />
        <button type="button" className="btn primary" disabled={start.isPending} onClick={research}>
          {t('Research missing details →')}
        </button>
      </div>
    </section>
  );
}

/** The unsure column, asked one at a time: the guess is applied already; Confirm keeps it or sorts the column again. */
function ColumnQuestionNote({ question: q, onDone }: { question: OpenQuestion; onDone: (text: string) => void }) {
  const t = useT();
  const answer = useAnswerColumn();
  const [field, setField] = useState<ImportField | 'skip'>(q.guess);
  const [error, setError] = useState<string | null>(null);
  const header = q.header;
  function confirm() {
    setError(null);
    answer.mutate(
      { fileId: q.fileId, body: { sheet: q.sheet, col: q.col, field } },
      {
        onSuccess: () =>
          onDone(
            field === 'skip'
              ? t('Column "{column}" in {file} is now skipped.', { column: header, file: q.fileName })
              : t('Column "{column}" in {file} is now the {field}.', { column: header, file: q.fileName, field: fieldOptionLabel(t, field) }),
          ),
        onError: (e) => setError(importErrorText(t, e instanceof ApiError ? e.code : '')),
      },
    );
  }
  const selectId = `imp-map-${q.fileId}-${q.col}`;
  return (
    <div className="note warn" role="status">
      <div className="actions-row">
        <span className="grow">
          {withNodes(t('Column {column} in {file} — is this the {field}?', { column: NODE[0], file: q.fileName, field: NODE[1] }), [
            <b key="c">"{header}"</b>,
            <b key="f">{fieldOptionLabel(t, q.guess)}</b>,
          ])}{' '}
          {q.samples.length ? <span className="dim">{t('First values: {values}', { values: q.samples.join(', ') })}</span> : null}
        </span>
        <label className="sr" htmlFor={selectId}>
          {t('CRM field for column {column}', { column: header })}
        </label>
        <select id={selectId} className="chip" value={field} onChange={(e) => setField(e.target.value as ImportField | 'skip')}>
          {FIELD_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {fieldOptionLabel(t, f)}
            </option>
          ))}
        </select>
        <button type="button" className="btn sm primary" disabled={answer.isPending} onClick={confirm}>
          {t('Confirm')}
        </button>
      </div>
      {error ? <div className="err-msg">{error}</div> : null}
    </div>
  );
}

/** "Expo xlsx · row 14", "GITEX pdf · p.7", "Madrid docx · card 3", "notes txt · line 2", in the reader's language. */
export function originText(t: TFn, o: ImportRowView['origin']): string {
  const where =
    o.kind === 'page' ? t('p.{n}', { n: o.n }) : o.kind === 'card' ? t('card {n}', { n: o.n }) : o.kind === 'line' ? t('line {n}', { n: o.n }) : t('row {n}', { n: o.n });
  return `${o.word} ${o.ext} · ${where}`;
}

function SortRow({ row: r, onTick }: { row: ImportRowView; onTick: (include: boolean) => void }) {
  const t = useT();
  const lang = useLang();
  const notLead = r.status === 'Not a lead';
  const status = r.status === 'Already in CRM' && r.matched ? `${importRowStatusText(r.status, lang)} · ${r.matched.number}` : importRowStatusText(r.status, lang);
  return (
    <tr>
      <td className="ck">
        <input type="checkbox" checked={r.include} aria-label={t('Include')} onChange={(e) => onTick(e.target.checked)} />
      </td>
      {IMPORT_TABLE_FIELDS.map((f) => (
        <EditableCell key={f} rowId={r.id} field={f} value={r.fields[f] ?? ''} strong={f === 'companyName' && !notLead} blank={notLead} />
      ))}
      <td className="muted">{originText(t, r.origin)}</td>
      <td>
        <span className={`badge ${rowStatusBadge(r.status)}`}>{status}</span>
      </td>
    </tr>
  );
}

/**
 * A cell edited in place: plain text only (a paste drops formatting), Enter saves, Escape puts the value back, leaving
 * the cell saves a change. An empty cell shows "missing"; a "Not a lead" row's values are dimmed and its empty cells stay blank.
 */
export function EditableCell({ rowId, field, value: saved, strong, blank }: { rowId: number; field: ImportField; value: string; strong?: boolean; blank?: boolean }) {
  const t = useT();
  const toast = useToast();
  const update = useUpdateRow();
  const ref = useRef<HTMLTableCellElement>(null);
  // Re-mounts the cell's content after an edit or Escape, so React's DOM matches the value again.
  const [version, setVersion] = useState(0);
  // What was just typed, shown until the saved value changes (no flicker back to the old value while saving).
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [saved]);
  const value = draft ?? saved;
  const cancelled = useRef(false);

  function onFocus() {
    const el = ref.current;
    if (!el || value !== '') return;
    // Drop the "missing" hint and put the caret in the now empty cell (the hint's text node, where it was, is gone).
    el.textContent = '';
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function onBlur() {
    const el = ref.current;
    if (!el) return;
    const next = (el.textContent ?? '').trim();
    if (!cancelled.current && next !== value) {
      setDraft(next.slice(0, 500));
      update.mutate(
        { id: rowId, body: { field, value: next.slice(0, 500) } },
        {
          // Refused (e.g. the import has started): the old value comes back and the reason is shown.
          onError: (e) => {
            setDraft(null);
            setVersion((v) => v + 1);
            toast(importErrorText(t, e instanceof ApiError ? e.code : ''), 'warn');
          },
        },
      );
    }
    cancelled.current = false;
    setVersion((v) => v + 1);
  }
  function onKeyDown(e: KeyboardEvent<HTMLTableCellElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      ref.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled.current = true;
      if (ref.current) ref.current.textContent = value;
      ref.current?.blur();
    }
  }
  function onPaste(e: ClipboardEvent<HTMLTableCellElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\s+/g, ' ');
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
  }
  return (
    <td
      key={version}
      ref={ref}
      className={strong ? 'strong' : undefined}
      contentEditable
      suppressContentEditableWarning
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    >
      {value !== '' ? blank ? <span className="dim">{value}</span> : value : blank ? null : <span className="dim">{t('missing')}</span>}
    </td>
  );
}
