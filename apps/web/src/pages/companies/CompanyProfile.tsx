import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useCompany } from '../../api/companies';
import { useLocations } from '../../api/locations';
import { useLookupText } from '../../api/queries';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Tabs, type TabDef } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { companyStatusBadge, companyStatusText, errorText } from '../../i18n/labels';
import { useLang, useT } from '../../i18n/useT';
import { CompanyModal, type CompanySection } from './CompanyModal';
import { ActivitiesTab } from './tabs/ActivitiesTab';
import { ContactsTab } from './tabs/ContactsTab';
import { EmptyTab } from './tabs/EmptyTab';
import { LeadsTab } from './tabs/LeadsTab';
import { LocationsTab } from './tabs/LocationsTab';
import { OverviewTab } from './tabs/OverviewTab';

const TAB_IDS = ['overview', 'contacts', 'locations', 'leads', 'activities', 'ai', 'sources'] as const;
type TabId = (typeof TAB_IDS)[number];
const isTab = (v: string): v is TabId => (TAB_IDS as readonly string[]).includes(v);

/** `/companies/:id`: header, Edit, and seven tabs; the active tab lives in the URL hash (`#contacts`). */
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
  const lookupText = useLookupText(lang);
  // undefined = closed; null = whole form (header Edit); a section = that group's Edit button.
  const [editing, setEditing] = useState<CompanySection | null | undefined>(undefined);

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

  const tabs: TabDef[] = [
    { id: 'overview', label: t('Overview') },
    { id: 'contacts', label: t('Contacts'), count: company.contactCount },
    { id: 'locations', label: t('Locations'), ...(locations ? { count: locations.length } : {}) },
    { id: 'leads', label: t('Leads & Prospects') },
    { id: 'activities', label: t('Activities') },
    { id: 'ai', label: t('AI Intelligence') },
    { id: 'sources', label: t('Research Sources') },
  ];

  let panel;
  switch (active) {
    case 'overview':
      panel = <OverviewTab company={company} canManage={canManage} onEdit={(s) => setEditing(s)} />;
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
    case 'activities':
      panel = <ActivitiesTab company={company} />;
      break;
    default:
      panel = <EmptyTab release="4" />;
  }

  return (
    <>
      <Topbar
        title={company.name}
        sub={`${company.number} · ${lookupText('country', company.country) ?? company.country}`}
        crumb={crumb}
        badges={
          <>
            <span className={companyStatusBadge(company.status)}>{companyStatusText(t, company.status)}</span>
            {company.isClient ? <span className="badge b-ok">{t('Client')}</span> : null}
          </>
        }
      >
        {canManage ? (
          <button type="button" className="btn primary" onClick={() => setEditing(null)}>
            {t('Edit')}
          </button>
        ) : null}
      </Topbar>
      <Tabs tabs={tabs} active={active} onChange={setActive} label={t('Company sections')} className="profile-tabs" panelClassName="page">
        {panel}
      </Tabs>
      {editing !== undefined ? (
        <CompanyModal company={company} section={editing ?? undefined} onClose={() => setEditing(undefined)} />
      ) : null}
    </>
  );
}
