import { useState } from 'react';
import { BATCH_STATUSES, OUTREACH_LANGUAGES, type OutreachLanguage } from '@dait-crm/shared';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useBatches, type BatchListItem } from '../../../api/imports';
import { Icons } from '../../../components/Icons';
import { Pager } from '../../../components/Pager';
import { ScrollBox } from '../../../components/Table';
import { Tile } from '../../../components/Tile';
import { useDebounce } from '../../../hooks/useDebounce';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { useT } from '../../../i18n/useT';
import { OUTREACH_LABEL } from '../../../lib/outreach';
import { IN_WIZARD, batchStatusBadge, batchStatusText } from '../labels';
import { BatchDetailCard } from './BatchDetail';

const PAGE_SIZE = 25;

/** Where a batch opens: the wizard (at its step) until it is imported, otherwise its detail here. */
export const batchHref = (b: { id: number; status: string }) =>
  IN_WIZARD.has(b.status) ? `/leads/import?batch=${b.id}` : `/leads/import/manager?batch=${b.id}`;

/**
 * Data manager (mockup #paneManager): the month's tiles, the batches (Language / Status filters, search, 25 a page) and
 * the selected batch's detail (`?batch=<id>`).
 */
export function DataManager() {
  const t = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selected = Number(params.get('batch')) || null;
  const [language, setLanguage] = useState('');
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounce(text.trim(), 300);
  const { data, isPending } = useBatches({ page, pageSize: PAGE_SIZE, language: language || undefined, status: status || undefined, q: q || undefined });
  const tiles = data?.tiles;
  const items = data?.items ?? [];
  const filtered = Boolean(language || status || q);

  function open(b: BatchListItem) {
    if (IN_WIZARD.has(b.status)) navigate(batchHref(b));
    else setParams({ batch: String(b.id) });
  }

  return (
    <>
      <div className="tiles">
        <Tile
          label={t('Imported this month')}
          value={tiles?.importedThisMonth ?? '—'}
          meta={tiles ? (tiles.importedBatchesThisMonth === 1 ? t('in 1 batch') : t('in {n} batches', { n: tiles.importedBatchesThisMonth })) : undefined}
        />
        <Tile label={t('Waiting for review')} value={tiles?.waitingForReview ?? '—'} meta={tiles ? (tiles.waitingForReview === 1 ? t('batch') : t('batches')) : undefined} />
        <Tile label={t('Still being researched')} value={tiles?.stillResearching ?? '—'} meta={tiles ? (tiles.stillResearching === 1 ? t('lead') : t('leads')) : undefined} />
        <Tile label={t('Duplicates skipped')} value={tiles?.duplicatesSkippedThisMonth ?? '—'} meta={t('this month')} />
      </div>
      <section className="card flush" aria-label={t('Import batches')}>
        <div className="head">
          <h2>{t('Import batches')}</h2>
        </div>
        <div className="filters">
          <label className="sr" htmlFor="dm-lang">
            {t('Language')}
          </label>
          <select
            id="dm-lang"
            className="chip"
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('Language: Any')}</option>
            {OUTREACH_LANGUAGES.map((x: OutreachLanguage) => (
              <option key={x} value={x}>
                {t('Language: {language}', { language: OUTREACH_LABEL[x] })}
              </option>
            ))}
          </select>
          <label className="sr" htmlFor="dm-status">
            {t('Status')}
          </label>
          <select
            id="dm-status"
            className="chip"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('Status: Any')}</option>
            {BATCH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {batchStatusText(t, s)}
              </option>
            ))}
          </select>
          <div className="grow" />
          <label className="search">
            {Icons.search}
            <span className="sr">{t('Search batches')}</span>
            <input
              type="search"
              value={text}
              placeholder={t('Search file or batch…')}
              onChange={(e) => {
                setText(e.target.value);
                setPage(1);
              }}
            />
          </label>
        </div>
        <ScrollBox sticky={1}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('Batch')}</th>
                <th scope="col">{t('Date')}</th>
                <th scope="col">{t('By')}</th>
                <th scope="col">{t('Language')}</th>
                <th scope="col">{t('Files')}</th>
                <th scope="col">{t('Rows')}</th>
                <th scope="col">{t('Imported|rows')}</th>
                <th scope="col">{t('New companies')}</th>
                <th scope="col">{t('Skipped|rows')}</th>
                <th scope="col">{t('Research')}</th>
                <th scope="col">{t('Status')}</th>
                <th scope="col">
                  <span className="sr">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={12} className="empty">
                    {isPending ? t('Loading…') : filtered ? t('No imports match these filters.') : t('No imports yet.')}
                  </td>
                </tr>
              ) : (
                items.map((b) => <BatchRow key={b.id} b={b} selected={b.id === selected} onOpen={() => open(b)} />)
              )}
            </tbody>
          </table>
        </ScrollBox>
        {data && data.total > PAGE_SIZE ? (
          <div className="foot">
            <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
          </div>
        ) : null}
      </section>
      {selected ? <BatchDetailCard key={selected} id={selected} /> : null}
    </>
  );
}

function BatchRow({ b, selected, onOpen }: { b: BatchListItem; selected: boolean; onOpen: () => void }) {
  const t = useT();
  const { dateTime, dayMonth } = useFormatDate();
  const dash = <span className="dim">—</span>;
  const num = (n: number | null) => (n === null ? dash : n);
  const undoneDay = b.undoneAt ? dayMonth(b.undoneAt) : undefined;
  return (
    <tr className={selected ? 'sel' : undefined}>
      <td>
        <Link className="id-link" to={batchHref(b)}>
          {b.number}
        </Link>
      </td>
      <td className="muted">{dateTime(b.createdAt)}</td>
      <td>{b.by ?? dash}</td>
      <td>{OUTREACH_LABEL[b.language as OutreachLanguage] ?? b.language}</td>
      <td>
        {b.files.first || dash}
        {b.files.more > 0 ? <span className="cell-sub">{t('+ {n} more', { n: b.files.more })}</span> : null}
      </td>
      <td>{b.rowCount}</td>
      <td>{num(b.importedCount)}</td>
      <td>{num(b.newCompanyCount)}</td>
      <td>{num(b.skippedCount)}</td>
      <td>{b.research === null ? dash : b.research === 'done' ? t('Done') : `${b.research.done} / ${b.research.total}`}</td>
      <td>
        <span className={`badge ${batchStatusBadge(b.status)}`}>{batchStatusText(t, b.status, undoneDay)}</span>
      </td>
      <td>
        <button type="button" className="btn xs" onClick={onOpen} aria-label={t('Open {batch}', { batch: b.number })}>
          {t('Open')}
        </button>
      </td>
    </tr>
  );
}
