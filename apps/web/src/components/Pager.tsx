import { useT } from '../i18n/useT';

type PagerProps = { page: number; pageSize: number; total: number; onPage: (page: number) => void };

/** "Showing 26–50 of 112" with Previous / Next; renders nothing when the list is empty. */
export function Pager({ page, pageSize, total, onPage }: PagerProps) {
  const t = useT();
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // A stale URL can ask for a page past the end; show the last real page instead of "2451–25 of 25".
  page = Math.min(Math.max(1, page), pages);
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
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
