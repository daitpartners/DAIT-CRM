import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Topbar } from '../../components/Topbar';
import { useT } from '../../i18n/useT';

/** Settings tabs: "My settings" for everyone, "Administration" with view_admin_settings. */
export function SettingsLayout() {
  const t = useT();
  const me = useCurrentUser();
  const { pathname } = useLocation();
  const inAdmin = pathname !== '/settings' && pathname !== '/settings/';
  const showAdmin = me.can('view_admin_settings');

  // Administration sub-pages, each shown only with the right it needs.
  const adminLinks = [
    { to: '/settings/users', label: t('Users'), right: me.can('manage_users') },
    { to: '/settings/lookups', label: t('Dropdown values'), right: me.can('manage_lookups') },
    { to: '/settings/allocation', label: t('Allocation rules'), right: me.can('view_admin_settings') },
    { to: '/settings/mailbox', label: t('System mailbox'), right: me.can('view_admin_settings') },
  ].filter((l) => l.right);
  const adminHome = adminLinks[0]?.to ?? '/settings/allocation';

  const tab = ({ isActive }: { isActive: boolean }) => (isActive ? 'tab on' : 'tab');
  return (
    <>
      <Topbar title={t('Settings')} sub={t('Your preferences and, for administrators, how the CRM is configured')} />
      <div className="page">
        <nav className="card flush" aria-label={t('Settings sections')}>
          <div className="tabs" style={{ borderBottom: 0 }}>
            <NavLink to="/settings" end className={tab}>
              {t('My settings')}
            </NavLink>
            {showAdmin ? (
              <NavLink to={adminHome} className={() => tab({ isActive: inAdmin })} aria-current={inAdmin ? 'page' : undefined}>
                {t('Administration')}
              </NavLink>
            ) : null}
          </div>
        </nav>
        {inAdmin && showAdmin ? (
          <nav className="subnav" aria-label={t('Administration')}>
            {adminLinks.map((l) => (
              <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'on' : undefined)}>
                {l.label}
              </NavLink>
            ))}
          </nav>
        ) : null}
        <Outlet />
      </div>
    </>
  );
}
