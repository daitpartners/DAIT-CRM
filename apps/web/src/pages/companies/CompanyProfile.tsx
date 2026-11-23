import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { safeUrl } from '@dait-crm/shared';
import { ApiError } from '../../api/client';
import { useCompany, useCompanyPipeline } from '../../api/companies';
import { useCompanyActivities } from '../../api/leads';
import { useLocations } from '../../api/locations';
import { useCompanyProjects } from '../../api/projects';
import { useLookupText } from '../../api/queries';
import { useCreateQuotationForCompany } from '../../api/quotations';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Tabs, type TabDef } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { companyStatusBadge, companyStatusText, errorText, initials, verificationBadge, verificationText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { CompanyModal, type CompanySection } from './CompanyModal';
import { ContactModal } from './ContactModal';
import { useResearchRunner } from './AiCard';
import { ActivitiesTab } from './tabs/ActivitiesTab';
import { AiTab, SourcesTab } from './tabs/AiTabs';
import { ContactsTab } from './tabs/ContactsTab';
import { LeadsTab } from './tabs/LeadsTab';
import { LocationsTab } from './tabs/LocationsTab';
import { OverviewTab } from './tabs/OverviewTab';
import { ProjectsTab } from './tabs/ProjectsTab';
import { ProjectModal } from '../projects/ProjectModal';

const TAB_IDS = ['overview', 'contacts', 'locations', 'leads', 'projects', 'activities', 'ai', 'sources'] as const;
type TabId = (typeof TAB_IDS)[number];
const isTab = (v: string): v is TabId => (TAB_IDS as readonly string[]).includes(v);

/**
 * `/companies/:id` (prototype views-companies.js): logo, legal name, badges, a facts line and the header actions,
 * then eight tabs; the active tab lives in the URL hash (`#contacts`).
 */
export function CompanyProfile() {
  const t = useT();
  const lang = useLang();
  const me = useCurrentUser();
  const canManage = me.can('manage_companies');
  const id = Number(useParams().id);
  const location = useLocation();
  const navigate = useNavigate();
  const { data: company, error, isPending } = useCompany(id);
  const { data: locations } = useLocations(id);
  // One company-scoped groupBy, shared with the Leads tab's Pipeline card.
  const { data: pipeline } = useCompanyPipeline(id);
  const leadTotal = pipeline?.byStatus.reduce((n, g) => n + g.count, 0);
  const { data: activities } = useCompanyActivities(id, 1);
  const { data: projects } = useCompanyProjects(id);
  const lookupText = useLookupText(lang);
  // undefined = closed; null = whole form (header Edit); a section = that group's Edit button.
  const [editing, setEditing] = useState<CompanySection | null | undefined>(undefined);
  const [adding, setAdding] = useState<'contact' | 'project' | null>(null);
  const toast = useToast();
  const newQuote = useCreateQuotationForCompany();
  // One research runner per profile (polls while a run is queued, toasts once when it finishes): the header button,
  // the Overview card and the AI Intelligence tab share it. A run started here opens the AI tab when it finishes.
  const research = useResearchRunner(id, {
    onFinished: (startedHere) => {
      if (startedHere) navigate({ pathname: location.pathname, search: location.search, hash: '#ai' }, { replace: true });
    },
  });

  const hash = location.hash.replace(/^#/, '');
  const active: TabId = isTab(hash) ? hash : 'overview';
  const setActive = (tab: string) =>
    navigate({ pathname: location.pathname, search: location.search, hash: tab === 'overview' ? '' : `#${tab}` }, { replace: true });

  const crumb = <Link to="/companies">{t('Companies')}</Link>;

  if (!Number.isInteger(id) || error || isPending || !company) {
    const code = !Number.isInteger(id) ? 'not_found' : error instanceof ApiError ? error.code : error ? 'unknown' : null;
    return (
      <>
        <Topbar title={code ? errorText(t, code) : t('Loading…')} crumb={crumb} />
        <div className="page">
          {code ? (
            <div className="card empty" role="alert">
              {code === 'not_found' ? t('This company does not exist or you do not have access to it.') : errorText(t, code)}{' '}
              <Link to="/companies">{t('Back to companies')}</Link>
            </div>
          ) : null}
        </div>
      </>
    );
  }

  const count = (n: number | undefined) => (n !== undefined ? { count: n } : {});
  const tabs: TabDef[] = [
    { id: 'overview', label: t('Overview') },
    { id: 'contacts', label: t('Contacts'), count: company.contactCount },
    { id: 'locations', label: t('Locations'), ...count(locations?.length) },
    { id: 'leads', label: t('Leads & Prospects'), ...count(leadTotal) },
    { id: 'projects', label: t('Projects'), ...count(projects?.items.length) },
    { id: 'activities', label: t('Activities'), ...count(activities?.total) },
    { id: 'ai', label: t('AI Intelligence') },
    { id: 'sources', label: t('Research Sources') },
  ];

  let panel;
  switch (active) {
    case 'overview':
      panel = <OverviewTab company={company} canManage={canManage} onEdit={(s) => setEditing(s)} research={research} />;
      break;
    case 'contacts':
      panel = <ContactsTab company={company} canManage={canManage} />;
      break;
    case 'locations':
      panel = <LocationsTab company={company} canManage={canManage} />;
      break;
    case 'leads':
      panel = <LeadsTab company={company} canManage={me.can('manage_leads')} />;
      break;
    case 'projects':
      panel = <ProjectsTab company={company} />;
      break;
    case 'activities':
      panel = <ActivitiesTab company={company} />;
      break;
    case 'ai':
      panel = <AiTab company={company} research={research} />;
      break;
    default:
      panel = <SourcesTab company={company} />;
  }

  const closed = company.status === 'Closed';
  const closedTitle = closed ? errorText(t, 'company_inactive') : undefined;
  const site = company.website ? safeUrl(company.website) : null;
  const place = [company.city, lookupText('country', company.country) ?? company.country].filter(Boolean).join(', ');
  const facts = [
    lookupText('industry', company.industry) ?? t('Industry unknown'),
    place || t('Location unknown'),
    ...(company.employeeRange ? [t('{range} employees', { range: lookupText('employee_range', company.employeeRange) ?? company.employeeRange })] : []),
    t('{n} contacts', { n: company.contactCount }),
    ...(leadTotal !== undefined ? [t('{n} leads', { n: leadTotal })] : []),
    ...(locations ? [t('{n} locations', { n: locations.length })] : []),
  ];

  return (
    <>
      <Topbar
        title={company.legalName || company.name}
        logo={
          <span className="logo lg" aria-hidden="true">
            {initials(company.name)}
          </span>
        }
        crumb={
          <>
            {crumb} / {company.number}
          </>
        }
        sub={
          <>
            {company.domain ? (
              <>
                {site ? (
                  <a href={site} target="_blank" rel="noopener noreferrer">
                    {company.domain}
                  </a>
                ) : (
                  company.domain
                )}
                {' · '}
              </>
            ) : null}
            {facts.join(' · ')}
          </>
        }
        badges={
          <>
            <span className={companyStatusBadge(company.status)}>{companyStatusText(t, company.status)}</span>
            <span className={verificationBadge(company.verificationStatus)}>{verificationText(t, company.verificationStatus)}</span>
            {company.isClient ? <span className="badge b-ok">{t('Client')}</span> : null}
          </>
        }
      >
        <div className="hdr-actions">
          {canManage ? (
            <button type="button" className="btn" onClick={research.run} disabled={research.busy}>
              {t('Run AI research')}
            </button>
          ) : null}
          {canManage ? (
            <button type="button" className="btn" onClick={() => setAdding('contact')} disabled={closed} title={closedTitle}>
              {t('Add contact')}
            </button>
          ) : null}
          {me.can('manage_leads') ? (
            <button type="button" className="btn" onClick={() => navigate(`/leads/new?company=${company.id}`)} disabled={closed} title={closedTitle}>
              {t('New lead')}
            </button>
          ) : null}
          {me.can('manage_quotes') ? (
            <button
              type="button"
              className="btn"
              disabled={newQuote.isPending}
              onClick={() =>
                newQuote.mutate(company.id, {
                  onSuccess: (q) => navigate(`/quotations/${q.id}`),
                  onError: (err) => toast(errorText(t, err instanceof ApiError ? err.code : 'unknown'), 'warn'),
                })
              }
            >
              {t('New quotation')}
            </button>
          ) : null}
          {(projects?.isClient ?? company.isClient) && me.can('manage_quotes') ? (
            <button type="button" className="btn" onClick={() => setAdding('project')}>
              {t('Create project')}
            </button>
          ) : null}
          {canManage ? (
            <button type="button" className="btn primary" onClick={() => setEditing(null)}>
              {t('Edit profile')}
            </button>
          ) : null}
        </div>
      </Topbar>
      <Tabs tabs={tabs} active={active} onChange={setActive} label={t('Company sections')} className="profile-tabs" panelClassName="page">
        {panel}
      </Tabs>
      {editing !== undefined ? (
        <CompanyModal company={company} section={editing ?? undefined} onClose={() => setEditing(undefined)} />
      ) : null}
      {adding === 'contact' ? <ContactModal companyId={company.id} onClose={() => setAdding(null)} /> : null}
      {adding === 'project' ? <ProjectModal preset={{ companyId: company.id }} onClose={() => setAdding(null)} /> : null}
    </>
  );
}
