import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import type { CompanyDetail } from '../../../api/companies';
import { useCompanyActivities } from '../../../api/leads';
import { Pager } from '../../../components/Pager';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { errorText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { TimelineEntry } from '../../leads/Timeline';

/**
 * Activities across the company's leads the user may see, newest first, 20 per page; side column: Activity
 * summary (counts across every page) and Where this comes from (prototype views-companies.js).
 */
export function ActivitiesTab({ company }: { company: CompanyDetail }) {
  const t = useT();
  const { date } = useFormatDate();
  const [page, setPage] = useState(1);
  const { data, isPending, error } = useCompanyActivities(company.id, page);

  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(data.total / data.pageSize)));
  }, [data, page]);

  const rows = data?.items ?? [];
  const sum = data?.summary;
  const n = (v: number | undefined) => (v === undefined ? '—' : v);
  return (
    <div className="cols">
      <section className="card flush col-main" aria-labelledby="company-activities-title">
        <div className="head">
          <h2 id="company-activities-title">{t('All interactions with this company')}</h2>
          <span className="head-note">{t('Rolled up from every linked lead')}</span>
        </div>
        <div className="activity-body">
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
        </div>
      </section>
      <aside className="col-side">
        <section className="card side-card" aria-labelledby="co-act-sum-title">
          <h2 id="co-act-sum-title">{t('Activity summary')}</h2>
          <dl className="kv">
            <dt>{t('Calls')}</dt>
            <dd>{n(sum?.call)}</dd>
            <dt>{t('Emails')}</dt>
            <dd>{n(sum?.email)}</dd>
            <dt>{t('Meetings')}</dt>
            <dd>{n(sum?.meeting)}</dd>
            <dt>{t('Quotations')}</dt>
            <dd>{n(sum?.quote)}</dd>
            <dt>{t('Last touch')}</dt>
            <dd>{sum?.lastAt ? date(sum.lastAt) : '—'}</dd>
          </dl>
        </section>
        <section className="card side-card" aria-labelledby="co-act-src-title">
          <h2 id="co-act-src-title">{t('Where this comes from')}</h2>
          <p className="info-text">
            {t('Activities are stored once, against the lead they belong to, and roll up here through the company relationship. Emails, calendar events and quotations keep their own records and link by lead, contact and company.')}
          </p>
        </section>
      </aside>
    </div>
  );
}
