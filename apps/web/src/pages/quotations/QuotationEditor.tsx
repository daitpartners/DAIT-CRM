import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useQuotation } from '../../api/quotations';
import { Topbar } from '../../components/Topbar';
import { errorText, quoteStatusBadge, quoteStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';

/**
 * `/quotations/:id`: the header of the quotation the list and the entry points open (prototype V.quoteEditor
 * topbar). Placeholder until the editor (release 3A task 6) replaces this file.
 */
export function QuotationEditor() {
  const t = useT();
  const id = Number(useParams().id);
  const { data: q, error } = useQuotation(id);
  const code = !Number.isInteger(id) ? 'not_found' : error instanceof ApiError ? error.code : error ? 'unknown' : null;
  const crumb = (
    <>
      <Link to="/quotations">{t('Quotations')}</Link>
      {q ? ` / ${q.number}` : null}
    </>
  );
  if (!q) return <Topbar title={code ? errorText(t, code) : t('Loading…')} crumb={crumb} />;
  return (
    <Topbar
      title={`${q.number} · ${q.company.legalName || q.company.name}`}
      crumb={crumb}
      badges={<span className={quoteStatusBadge(q.status)}>{quoteStatusText(t, q.status)}</span>}
    />
  );
}
