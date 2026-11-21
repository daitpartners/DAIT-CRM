import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import type { CompanyDetail } from '../../../api/companies';
import { useCompanyActivities } from '../../../api/leads';
import { Pager } from '../../../components/Pager';
import { errorText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { TimelineEntry } from '../../leads/Timeline';

/** Activities across the company's leads the user may see, newest first, 20 per page. */
export function ActivitiesTab({ company }: { company: CompanyDetail }) {
  const t = useT();
  const [page, setPage] = useState(1);
  const { data, isPending, error } = useCompanyActivities(company.id, page);

  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(data.total / data.pageSize)));
  }, [data, page]);

  const rows = data?.items ?? [];
  return (
    <section className="card" aria-labelledby="company-activities-title">
      <h2 id="company-activities-title" className="card-title">
        {t('Activities across leads')}
      </h2>
      {error ? (
        <div className="empty" role="alert">
          {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
        </div>
      ) : isPending ? (
        <div className="empty">{t('Loading…')}</div>
      ) : rows.length === 0 ? (
        <div className="empty">{t('No activity yet')}</div>
      ) : (
        <ol className="timeline" aria-label={t('Activity timeline')}>
          {rows.map((a, i) => (
            <TimelineEntry
              key={a.id}
              activity={a}
              last={i === rows.length - 1}
              extra={
                <>
                  {' · '}
                  <Link to={`/leads/${a.lead.id}`}>{a.lead.number}</Link>
                </>
              }
            />
          ))}
        </ol>
      )}
      {data && data.total > data.pageSize ? <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /> : null}
    </section>
  );
}
