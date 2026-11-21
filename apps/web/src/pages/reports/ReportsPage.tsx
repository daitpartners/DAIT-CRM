import { useLookupText } from '../../api/queries';
import { useReports } from '../../api/reports';
import { Topbar } from '../../components/Topbar';
import { useLang, useT } from '../../i18n/useT';

/** `/reports`: the prototype's Reports view (prototype/js/app.js `reports()`): Leads by source and Enquiry conversion. */
export function ReportsPage() {
  const t = useT();
  const lookup = useLookupText(useLang());
  const { data } = useReports();
  const sources = data?.bySource ?? [];
  const max = Math.max(1, ...sources.map((s) => s.count));
  const e = data?.enquiries;
  return (
    <>
      <Topbar title={t('Reports')} sub={t('Existing dashboard and reporting stay as they are; these are the additions for the new modules')} />
      <div className="page cols">
        <section className="card col-main" aria-labelledby="rep-src">
          <h2 id="rep-src">{t('Leads by source')}</h2>
          <ul className="rep-bars">
            {sources.map((s) => (
              <li key={s.source}>
                <div className="rep-row">
                  <span>{lookup('lead_source', s.source) ?? s.source}</span>
                  <strong>{s.count}</strong>
                </div>
                <div className="bar">
                  <div style={{ width: `${Math.round((s.count / max) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
        <section className="card col-main" aria-labelledby="rep-enq">
          <h2 id="rep-enq">{t('Enquiry conversion')}</h2>
          <dl className="kv rep-kv">
            <dt>{t('Enquiries received')}</dt>
            <dd>{e?.received ?? ''}</dd>
            <dt>{t('Spam blocked')}</dt>
            <dd>{e?.spamBlocked ?? ''}</dd>
            <dt>{t('Leads created')}</dt>
            <dd>{e?.leadsCreated ?? ''}</dd>
            <dt>{t('Awaiting manual review')}</dt>
            <dd>{e?.awaitingReview ?? ''}</dd>
            <dt>{t('Matched existing companies')}</dt>
            <dd>{e?.matchedExisting ?? ''}</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
