import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

type PagerProps = {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  /**
   * Full mode (prototype leads list): "1–25 of 112", a Rows select with these sizes, and
   * « First / ‹ Prev / Page [n] of m / Next › / Last ». Needs `onPageSize`.
   */
  sizes?: readonly number[];
  onPageSize?: (size: number) => void;
  /** A narrow column (Email list): the buttons show « ‹ › » only (their full name stays the accessible name). */
  compact?: boolean;
};

/**
 * "Showing 26–50 of 112" with Previous / Next; renders nothing when the list is empty.
 * With `sizes` and `onPageSize` it renders the prototype's full pager instead.
 */
export function Pager({ page, pageSize, total, onPage, sizes, onPageSize, compact }: PagerProps) {
  const t = useT();
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // A stale URL can ask for a page past the end; show the last real page instead of "2451–25 of 25".
  page = Math.min(Math.max(1, page), pages);
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  if (sizes && onPageSize) {
    return <FullPager {...{ page, pages, pageSize, from, to, total, onPage, sizes, onPageSize, compact }} />;
  }
  return (
    <nav className="pager" aria-label={t('Pagination')}>
      <span aria-live="polite">{t('Showing {from}–{to} of {total}', { from, to, total })}</span>
      <div className="grow" />
      <button type="button" className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t('Previous')}
      </button>
      <span>{t('Page {page} of {pages}', { page, pages })}</span>
      <button type="button" className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {t('Next')}
      </button>
    </nav>
  );
}

type FullProps = {
  page: number;
  pages: number;
  pageSize: number;
  from: number;
  to: number;
  total: number;
  onPage: (page: number) => void;
  sizes: readonly number[];
  onPageSize: (size: number) => void;
  compact?: boolean;
};

function FullPager({ page, pages, pageSize, from, to, total, onPage, sizes, onPageSize, compact }: FullProps) {
  const t = useT();
  // The page box holds what is typed until Enter or leaving the field; then it jumps (clamped).
  const [typed, setTyped] = useState(String(page));
  useEffect(() => setTyped(String(page)), [page]);
  const jump = () => {
    // A blank or non-whole entry goes back to the current page rather than jumping.
    const n = typed.trim() === '' ? NaN : Number(typed);
    const next = Number.isInteger(n) ? Math.min(Math.max(1, n), pages) : page;
    setTyped(String(next));
    if (next !== page) onPage(next);
  };
  const nav = (label: string, target: number, off: boolean, symbol: string) =>
    compact ? (
      <button type="button" className="btn sm pg-sym" disabled={off} onClick={() => onPage(target)} aria-label={label} title={label}>
        {symbol}
      </button>
    ) : (
      <button type="button" className="btn sm" disabled={off} onClick={() => onPage(target)}>
        {label}
      </button>
    );
  return (
    <nav className={compact ? 'pager compact' : 'pager'} aria-label={t('Pagination')}>
      <span aria-live="polite">{t('{from}–{to} of {total}', { from, to, total })}</span>
      <span className="grow" />
      <label>
        {t('Rows')}{' '}
        <select className="chip" aria-label={t('Rows per page')} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {sizes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {nav(`« ${t('First')}`, 1, page <= 1, '«')}
      {nav(`‹ ${t('Prev')}`, page - 1, page <= 1, '‹')}
      <label>
        <span className={compact ? 'sr' : undefined}>{t('Page')}</span>{' '}
        <input
          className="in"
          type="number"
          min={1}
          max={pages}
          value={typed}
          aria-label={t('Go to page')}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={jump}
          onKeyDown={(e) => {
            if (e.key === 'Enter') jump();
          }}
        />{' '}
        {t('of {pages}', { pages })}
      </label>
      {nav(`${t('Next')} ›`, page + 1, page >= pages, '›')}
      {nav(`${t('Last')} »`, pages, page >= pages, '»')}
    </nav>
  );
}
