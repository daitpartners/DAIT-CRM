import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PROJECT_STATUSES, formatMoney, projectBadge, type ProjectStatus, type QuoteCurrency } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { clientName } from '../../api/companies';
import { useProjects, type ProjectRow } from '../../api/projects';
import { useCurrentUser } from '../../api/useCurrentUser';
import { CompanyPicker } from '../../components/CompanyPicker';
import { Icons } from '../../components/Icons';
import { Table } from '../../components/Table';
import { Tile } from '../../components/Tile';
import { Topbar } from '../../components/Topbar';
import { useFormatDate } from '../../hooks/useFormatDate';
import { errorText, projectStatusText } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { ProjectModal } from './ProjectModal';

/** Money as the prototype shows it: a whole amount without ".00". */
export const projectMoney = (amount: number, currency: QuoteCurrency) => formatMoney(amount, currency).replace(/\.00$/, '');

/** Compose preset for a project (Task 6 reads these params on the Email page). */
export function projectEmailHref(p: Pick<ProjectRow, 'id' | 'company' | 'lead'>): string {
  const params = new URLSearchParams({ compose: '1', company: String(p.company.id) });
  if (p.lead?.visible) params.set('lead', String(p.lead.id));
  params.set('project', String(p.id));
  return `/email?${params.toString()}`;
}

/**
 * Projects (prototype V.projects): tiles over every project the user can see, the Client / Status filters (kept in
 * the URL), and the table newest first. "Create project" (manage_quotes) opens the dialog preset with the filtered
 * client; Edit shows on the rows the user may change.
 */
export function ProjectsPage() {
  const t = useT();
  const me = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const companyParam = Number(searchParams.get('company'));
  const company = Number.isInteger(companyParam) && companyParam > 0 ? companyParam : undefined;
  const statusParam = searchParams.get('status') ?? '';
  const status = (PROJECT_STATUSES as readonly string[]).includes(statusParam) ? (statusParam as ProjectStatus) : undefined;
  const { data, isPending, error } = useProjects({ company, status });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const canMail = me.can('use_email');

  const setFilter = (k: 'company' | 'status', v: string | undefined) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v) next.set(k, v);
      else next.delete(k);
      return next;
    });

  const tiles = data?.tiles;
  const rows = data?.items;
  const filteredCompany = company ? rows?.find((p) => p.company.id === company)?.company : undefined;
  const filteredName = filteredCompany ? clientName(filteredCompany) : undefined;
  const head = [t('Project'), t('Client'), t('From lead'), t('Status'), t('Start'), t('Value'), t('Project manager'), t('Primary stakeholders'), t('Quotation'), ''];

  return (
    <>
      <Topbar title={t('Projects')} sub={t('Engagements won from leads. One client can have many projects, each from its own lead.')}>
        {canMail ? (
          <Link className="btn" to={`/email?compose=1${company ? `&company=${company}` : ''}`}>
            {t('Email a project')}
          </Link>
        ) : null}
        {me.can('manage_quotes') ? (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            {Icons.plus}
            {t('Create project')}
          </button>
        ) : null}
      </Topbar>
      <div className="page">
        <div className="tiles">
          <Tile label={t('Active projects')} value={tiles?.active ?? '—'} meta={tiles ? t('{n} clients', { n: tiles.clients }) : undefined} />
          <Tile
            label={t('Total value')}
            value={tiles ? tiles.totals.map((x) => projectMoney(x.amount, x.currency)).join(' · ') || '—' : '—'}
            meta={t('across all projects')}
          />
          <Tile label={t('Completed|project')} value={tiles?.completedThisYear ?? '—'} meta={t('this year')} />
          <Tile label={t('On hold|project')} value={tiles?.onHold ?? '—'} />
        </div>
        <section className="card flush" aria-label={t('Projects')}>
          <div className="filters">
            <div className="filter-combo">
              <CompanyPicker
                id="flt-client"
                label={t('Client')}
                hideLabel
                clientsOnly
                emptyLabel={t('Client: all')}
                optionLabel={clientName}
                value={company}
                selected={company && filteredName ? { value: String(company), label: filteredName } : null}
                onChange={(id) => setFilter('company', String(id))}
                onClear={() => setFilter('company', undefined)}
              />
            </div>
            <label className="sr" htmlFor="flt-status">
              {t('Status')}
            </label>
            <select id="flt-status" className="chip" value={status ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">{t('Status: any')}</option>
              {PROJECT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {projectStatusText(t, s)}
                </option>
              ))}
            </select>
            {company || status ? (
              <Link className="btn sm" to="/projects">
                {t('✕ Clear')}
              </Link>
            ) : null}
            <div className="grow" />
            {data ? <span className="pj-count">{t('{n} projects', { n: data.total })}</span> : null}
          </div>
          {error ? (
            <div className="empty" role="alert">
              {errorText(t, error instanceof ApiError ? error.code : 'unknown')}
            </div>
          ) : (
            <Table
              head={head}
              isEmpty={isPending || !rows?.length}
              empty={isPending ? t('Loading…') : t('No projects yet. Mark a lead as Won or accept a quotation, then create the project.')}
            >
              {rows?.map((p) => <ProjectTableRow key={p.id} p={p} canMail={canMail} onEdit={() => setEditing(p)} />)}
            </Table>
          )}
        </section>
      </div>
      {creating ? <ProjectModal preset={{ companyId: company }} onClose={() => setCreating(false)} /> : null}
      {editing ? <ProjectModal existing={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

/** A row in the prototype's columns. */
function ProjectTableRow({ p, canMail, onEdit }: { p: ProjectRow; canMail: boolean; onEdit: () => void }) {
  const t = useT();
  const { day } = useFormatDate();
  const dim = <span className="dim">—</span>;
  return (
    <tr>
      <td>
        <strong>{p.name}</strong>
        <span className="pj-sub">{p.number}</span>
      </td>
      <td>
        <Link to={`/companies/${p.company.id}#projects`} className="pj-client">
          {clientName(p.company)}
        </Link>
      </td>
      <td>{p.lead ? p.lead.visible ? <Link to={`/leads/${p.lead.id}`}>{p.lead.number}</Link> : p.lead.number : dim}</td>
      <td>
        <span className={`badge ${projectBadge(p.status)}`}>{projectStatusText(t, p.status)}</span>
      </td>
      <td>{day(p.startDate)}</td>
      <td>{p.value === null ? '—' : projectMoney(p.value, p.currency)}</td>
      <td>{p.manager.name}</td>
      <td className="wrap pj-sh">{p.stakeholders.map((s) => s.name).join(', ') || '—'}</td>
      <td>{p.quotation ? <Link to={`/quotations/${p.quotation.id}`}>{p.quotation.number}</Link> : dim}</td>
      <td className="pj-acts">
        {canMail ? (
          <Link className="btn xs" to={projectEmailHref(p)}>
            {t('Email|button')}
          </Link>
        ) : null}{' '}
        {p.canEdit ? (
          <button type="button" className="btn xs" onClick={onEdit}>
            {t('Edit')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}
