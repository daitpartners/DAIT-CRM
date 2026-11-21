import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import type { CompanyDetail } from '../../../api/companies';
import { useLeads } from '../../../api/leads';
import { Icons } from '../../../components/Icons';
import { Pager } from '../../../components/Pager';
import { PriorityLabel, StatusBadge } from '../../../components/StatusBadge';
import { Table } from '../../../components/Table';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { errorText, leadTypeText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { LeadModal } from '../../leads/LeadModal';

const PAGE_SIZE = 25;

/** The company's leads and prospects the user may see, newest first, with New lead linked to the company. */
export function LeadsTab({ company, canManage }: { company: CompanyDetail; canManage: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const { day, date } = useFormatDate();
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const { data, isPending, error } = useLeads({ companyId: company.id, page, pageSize: PAGE_SIZE });
  const closed = company.status === 'Closed';

  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(data.total / data.pageSize)));
  }, [data, page]);

  const dim = <span className="dim">—</span>;
  const rows = data?.items;
  const head = [t('Lead ID'), t('Type'), t('Status'), t('Priority'), t('Contact person'), t('Assigned to'), t('Next follow-up'), t('Created')];

  return (
    <section className="card flush" aria-labelledby="company-leads-title">
      <div className="head">
        <h2 id="company-leads-title">{t('Leads at {company}', { company: company.name })}</h2>
        <div className="grow" />
        {canManage ? (
          <button
            type="button"
            className="btn sm primary"
            onClick={() => setAdding(true)}
            disabled={closed}
            title={closed ? errorText(t, 'company_inactive') : undefined}
          >
            {Icons.plus}
            {t('New lead')}
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
              <td>
                <StatusBadge status={l.status} />
              </td>
              <td>
                <PriorityLabel priority={l.priority} />
              </td>
              <td>{l.contact ? l.contact.name : dim}</td>
              <td>{l.assignedTo ? l.assignedTo.name : <span className="dim">{t('Unassigned')}</span>}</td>
              <td>
                {l.nextFollowUp ? (
                  l.isOverdue ? <span className="overdue">{t('{date} · overdue', { date: day(l.nextFollowUp) })}</span> : day(l.nextFollowUp)
                ) : (
                  dim
                )}
              </td>
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
      {adding ? (
        <LeadModal company={{ id: company.id, name: company.name, country: company.country }} onClose={() => setAdding(false)} />
      ) : null}
    </section>
  );
}
