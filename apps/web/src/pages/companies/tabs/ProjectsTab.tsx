import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatMoney, projectBadge } from '@dait-crm/shared';
import { ApiError } from '../../../api/client';
import type { CompanyDetail } from '../../../api/companies';
import { useCompanyProjects, type ProjectRow } from '../../../api/projects';
import { useCurrentUser } from '../../../api/useCurrentUser';
import { Table } from '../../../components/Table';
import { useFormatDate } from '../../../hooks/useFormatDate';
import { errorText, projectStatusText } from '../../../i18n/labels';
import { useT } from '../../../i18n/useT';
import { ProjectModal } from '../../projects/ProjectModal';
import { projectEmailHref } from '../../projects/ProjectsPage';
import { bold, withBold } from '../../quotations/SendQuotationModal';

/**
 * The company's projects the user can see (prototype views-companies.js projects tab): "+ Create project" for a
 * client, the table, and the side card "How projects work".
 */
export function ProjectsTab({ company }: { company: CompanyDetail }) {
  const t = useT();
  const me = useCurrentUser();
  const { day } = useFormatDate();
  const { data, isPending, error } = useCompanyProjects(company.id);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const isClient = data?.isClient ?? company.isClient;
  const canMail = me.can('use_email');
  const rows = data?.items;
  const dim = <span className="dim">—</span>;
  const head = [t('Project'), t('From lead'), t('Status'), t('Start'), t('Value'), t('Project manager'), t('Primary stakeholders'), ''];

  return (
    <div className="cols">
      <section className="card flush col-main" aria-labelledby="company-projects-title">
        <div className="head">
          <h2 id="company-projects-title">{t('Projects at {company}', { company: company.name })}</h2>
          <span className="head-note">{t('One client, many projects; each starts from its own lead.')}</span>
          <div className="grow" />
          {isClient && me.can('manage_quotes') ? (
            <button type="button" className="btn sm primary" onClick={() => setCreating(true)}>
              {t('+ Create project')}
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="empty" role="alert">
            {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
          </div>
        ) : (
          <Table
            head={head}
            isEmpty={isPending || !rows?.length}
            empty={
              isPending
                ? t('Loading…')
                : isClient
                  ? t('No projects yet. Create the first one.')
                  : t('Projects unlock when a lead here is marked Won or a quotation is accepted.')
            }
          >
            {rows?.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong>
                  <span className="pj-sub">{p.quotation ? `${p.number} · ${p.quotation.number}` : p.number}</span>
                </td>
                <td>{p.lead ? p.lead.visible ? <Link to={`/leads/${p.lead.id}`}>{p.lead.number}</Link> : p.lead.number : dim}</td>
                <td>
                  <span className={`badge ${projectBadge(p.status)}`}>{projectStatusText(t, p.status)}</span>
                </td>
                <td>{day(p.startDate)}</td>
                <td>{p.value === null ? '—' : formatMoney(p.value, p.currency)}</td>
                <td>{p.manager.name}</td>
                <td className="wrap">{p.stakeholders.map((s) => s.name).join(', ') || '—'}</td>
                <td className="pj-acts">
                  {canMail ? (
                    <Link className="btn xs" to={projectEmailHref(p)}>
                      {t('Email|button')}
                    </Link>
                  ) : null}{' '}
                  {p.canEdit ? (
                    <button type="button" className="btn xs" onClick={() => setEditing(p)}>
                      {t('Edit')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>
      <aside className="col-side">
        <section className="card side-card" aria-labelledby="co-how-projects">
          <h2 id="co-how-projects">{t('How projects work')}</h2>
          <ul className="rules">
            <li>
              {withBold(t('A company becomes a {client} when a lead is Won or a quotation is accepted.', { client: bold('client') }), { client: t('Client') })}
            </li>
            <li>{t('Each project records the lead it came from, its stakeholders, manager, value and linked quotation.')}</li>
            <li>{t('Emails composed with a project selected copy its primary stakeholders and stay attached to the project.')}</li>
          </ul>
        </section>
      </aside>
      {creating ? <ProjectModal preset={{ companyId: company.id }} onClose={() => setCreating(false)} /> : null}
      {editing ? <ProjectModal existing={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
