import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { useCompanyPipeline, type CompanyDetail } from '../../../api/companies';
import { useLeads } from '../../../api/leads';
import { Icons } from '../../../components/Icons';
import { Pager } from '../../../components/Pager';
import { PriorityLabel, StatusBadge } from '../../../components/StatusBadge';
import { Table } from '../../../components/Table';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { errorText, leadTypeText } from '../../../i18n/labels';
import { useLang, useT } from '../../../i18n/useT';
import { useLookupText } from '../../../api/queries';

const PAGE_SIZE = 25;

/**
 * The company's leads and prospects the user may see, newest first, with New lead linked to the company;
 * side column: Pipeline at this company and Rules enforced here (prototype views-companies.js).
 */
export function LeadsTab({ company, canManage }: { company: CompanyDetail; canManage: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const { day, date } = useFormatDate();
  const lookup = useLookupText(useLang());
  const [page, setPage] = useState(1);
  const { data, isPending, error } = useLeads({ companyId: company.id, page, pageSize: PAGE_SIZE });
  const closed = company.status === 'Closed';

  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(data.total / data.pageSize)));
  }, [data, page]);

  const dim = <span className="dim">—</span>;
  const rows = data?.items;
  const head = [
    t('Lead ID'), t('Type'), t('Contact person'), t('Source'), t('Status'), t('Priority'), t('Assigned to'), t('Next follow-up'),
    t('Quotation'), t('Created'),
  ];

  return (
    <div className="cols">
      <section className="card flush col-main" aria-labelledby="company-leads-title">
        <div className="head">
          <h2 id="company-leads-title">{t('Leads & prospects linked to this company')}</h2>
          <span className="head-note">{t('One company, many leads. Leads never duplicate the company record.')}</span>
          <div className="grow" />
          {canManage ? (
            <button
              type="button"
              className="btn sm primary"
              onClick={() => navigate(`/leads/new?company=${company.id}`)}
              disabled={closed}
              title={closed ? errorText(t, 'company_inactive') : undefined}
            >
              {Icons.plus}
              {t('New lead for this company')}
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="empty" role="alert">
            {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
          </div>
        ) : (
          <Table head={head} isEmpty={isPending || !rows?.length} empty={isPending ? t('Loading…') : t('No leads for this company yet')}>
            {rows?.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => navigate(`/leads/${l.id}`)}>
                <td>
                  <Link to={`/leads/${l.id}`} className="row-link" onClick={(e) => e.stopPropagation()}>
                    {l.number}
                  </Link>
                </td>
                <td>
                  <span className={l.leadType === 'Lead' ? 'badge b-purple' : 'badge b-grey'}>{leadTypeText(t, l.leadType)}</span>
                </td>
                <td>{l.contact ? l.contact.name : dim}</td>
                <td>{lookup('lead_source', l.leadSource)}</td>
                <td>
                  <StatusBadge status={l.status} />
                </td>
                <td>
                  <PriorityLabel priority={l.priority} />
                </td>
                <td>{l.assignedTo ? l.assignedTo.name : <span className="dim">{t('Unassigned')}</span>}</td>
                <td>
                  {l.nextFollowUp ? (
                    l.isOverdue ? <span className="overdue">{t('{date} · overdue', { date: day(l.nextFollowUp) })}</span> : day(l.nextFollowUp)
                  ) : (
                    dim
                  )}
                </td>
                <td>{dim}</td>
                <td className="muted">{date(l.createdAt)}</td>
              </tr>
            ))}
          </Table>
        )}
        {data && data.total > PAGE_SIZE ? (
          <div className="foot">
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        ) : null}
      </section>
      <aside className="col-side">
        <PipelineCard companyId={company.id} />
        <section className="card side-card" aria-labelledby="co-rules-title">
          <h2 id="co-rules-title">{t('Rules enforced here')}</h2>
          <ul className="rules">
            <li>{t('A new enquiry from this company always creates a new lead, even though the company and contact exist.')}</li>
            <li>{t('Prospects from research attach here when the domain or registration number matches.')}</li>
            <li>
              <WithLink
                text={t('Uncertain name-only matches go to the {queue} queue.')}
                slot="{queue}"
                link={<Link to="/companies?tab=dups">{t('Duplicate review')}</Link>}
              />
            </li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

/**
 * Prototype "Pipeline at this company": open leads and Won / Lost among the leads the user may see, from one
 * company-scoped request. Quotation value and projects arrive in release 3.
 */
function PipelineCard({ companyId }: { companyId: number }) {
  const t = useT();
  const { data } = useCompanyPipeline(companyId);
  const dim = <span className="dim">—</span>;
  return (
    <section className="card side-card" aria-labelledby="co-pipeline-title">
      <h2 id="co-pipeline-title">{t('Pipeline at this company')}</h2>
      <dl className="kv kv-narrow">
        <dt>{t('Open leads')}</dt>
        <dd>{data ? data.open : dim}</dd>
        <dt>{t('Open quotation value')}</dt>
        <dd className="null">—</dd>
        <dt>{t('Won / Lost')}</dt>
        <dd>{data ? `${data.won} / ${data.lost}` : dim}</dd>
        <dt>{t('Projects')}</dt>
        <dd className="null">—</dd>
      </dl>
    </section>
  );
}

/** Renders a translated sentence with a link in place of `slot` (word order stays the translator's). */
function WithLink({ text, slot, link }: { text: string; slot: string; link: ReactNode }) {
  const at = text.indexOf(slot);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      {link}
      {text.slice(at + slot.length)}
    </>
  );
}
