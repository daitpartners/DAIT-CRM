import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectBadge } from '@dait-crm/shared';
import { useCompanyProjects } from '../../api/projects';
import { useCurrentUser } from '../../api/useCurrentUser';
import { projectStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { ProjectModal } from './ProjectModal';
import { projectMoney } from './ProjectsPage';

/**
 * The company's projects as a side card (prototype V.projectsCard), on the lead page and the company Overview:
 * the count, "+ Create project" for a client (preset with this client and `leadId`), rows linking to the client's
 * projects with this lead's projects highlighted, or the unlock hint while the company is not a client.
 */
export function ProjectsCard({ companyId, leadId }: { companyId: number; leadId?: number }) {
  const t = useT();
  const me = useCurrentUser();
  const titleId = useId();
  const { data } = useCompanyProjects(companyId);
  const [creating, setCreating] = useState(false);
  const rows = data?.items ?? [];
  const isClient = data?.isClient ?? false;
  return (
    <section className="card side-card" aria-labelledby={titleId}>
      <div className="card-head">
        <h2 id={titleId}>
          {t('Projects')} <span className="n">{rows.length}</span>
        </h2>
        {isClient && me.can('manage_quotes') ? (
          <button type="button" className="btn xs primary" onClick={() => setCreating(true)}>
            {t('+ Create project')}
          </button>
        ) : null}
      </div>
      {data && !isClient ? (
        <div className="dim side-hint">
          {t('Projects unlock when a lead at this company is marked')} <strong>{t('Won|status')}</strong> {t('or a quotation is accepted.')}
        </div>
      ) : null}
      {rows.map((p) => (
        <Link key={p.id} className={leadId !== undefined && p.lead?.id === leadId ? 'link pj-mine' : 'link'} to={`/projects?company=${companyId}`}>
          <span className="pj-card-main">
            <strong>{p.name}</strong>
            <span className="pj-card-sub">
              {[
                p.number,
                ...(p.lead ? [t('from {lead}', { lead: p.lead.number })] : []),
                p.value === null ? '—' : projectMoney(p.value, p.currency),
                p.manager.name,
              ].join(' · ')}
            </span>
          </span>
          <span className={`badge ${projectBadge(p.status)}`}>{projectStatusText(t, p.status)}</span>
        </Link>
      ))}
      {data && isClient && rows.length === 0 ? <div className="dim side-hint">{t('No projects yet. Create the first one for this engagement.')}</div> : null}
      {creating ? <ProjectModal preset={{ companyId, leadId }} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}
