import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useBatches } from '../../api/imports';
import { useCurrentUser } from '../../api/useCurrentUser';
import { AccessDenied } from '../../components/AccessDenied';
import { Tabs } from '../../components/Tabs';
import { Topbar } from '../../components/Topbar';
import { useT } from '../../i18n/useT';
import { Wizard } from './wizard/Wizard';

type View = 'wizard' | 'manager';

/**
 * Import leads (mockup 2026-11-24): crumb, title and sub text per view, "Back to Leads", the New import / Data manager
 * tabs (the count = every batch), then the wizard (`/leads/import`) or the Data manager (`/leads/import/manager`).
 * Administrators and Managers only (`import_leads`).
 */
export function ImportLeadsPage({ view }: { view: View }) {
  const me = useCurrentUser();
  if (!me.can('import_leads')) return <AccessDenied />;
  return <ImportLeadsView view={view} />;
}

function ImportLeadsView({ view }: { view: View }) {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: batches } = useBatches({ pageSize: 1 });
  const manager = view === 'manager';
  const here = manager ? t('Data manager') : t('Import leads');
  return (
    <>
      <Topbar
        title={here}
        crumb={
          <>
            <Link to="/leads">{t('Leads')}</Link> / <span>{here}</span>
          </>
        }
        sub={
          manager
            ? t('Every import: when, who, from which files, what was imported or skipped, and undo.')
            : t('Upload lead lists in any format. The CRM sorts the data, researches what is missing, and you approve before anything is saved.')
        }
      >
        <Link className="btn" to="/leads">
          {t('Back to Leads')}
        </Link>
      </Topbar>
      <Tabs
        label={t('Import views')}
        className="profile-tabs"
        panelClassName="page"
        active={view}
        onChange={(id) => {
          const batch = params.get('batch');
          if (id === 'manager') navigate(batch ? `/leads/import/manager?batch=${batch}` : '/leads/import/manager');
          else navigate('/leads/import');
        }}
        tabs={[
          { id: 'wizard', label: t('New import') },
          { id: 'manager', label: t('Data manager'), count: batches?.count },
        ]}
      >
        {manager ? (
          <section className="card">
            <h2>{t('Data manager')}</h2>
            <p className="muted-text">{t('The Data manager opens here.')}</p>
          </section>
        ) : (
          <Wizard />
        )}
      </Tabs>
    </>
  );
}
