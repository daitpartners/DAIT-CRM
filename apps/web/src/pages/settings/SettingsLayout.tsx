import { NavLink, Outlet } from 'react-router-dom';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Topbar } from '../../components/Topbar';
import { useT } from '../../i18n/useT';

/**
 * Settings (prototype app.js settings() + views-settings.js), one tab per prototype card in the prototype's order:
 * Preferences, Email & calendar connections, Email templates (everyone), then Dropdown configuration, Lead allocation
 * rules, Users and Company details (release 3A), each shown only with view_admin_settings and the right the page needs
 * (as in 1A).
 */
export function SettingsLayout() {
  const t = useT();
  const me = useCurrentUser();
  const admin = me.can('view_admin_settings');

  const links = [
    { to: '/settings', label: t('Preferences'), show: true, end: true },
    { to: '/settings/connections', label: t('Email & calendar connections'), show: true },
    { to: '/settings/templates', label: t('Email templates'), show: true },
    { to: '/settings/lookups', label: t('Dropdown configuration'), show: admin && me.can('manage_lookups') },
    { to: '/settings/allocation', label: t('Lead allocation rules'), show: admin },
    { to: '/settings/users', label: t('Users'), show: admin && me.can('manage_users') },
    { to: '/settings/company', label: t('Company details'), show: admin && me.can('manage_users') },
  ].filter((l) => l.show);

  return (
    <>
      <Topbar title={t('Settings')} sub={t('Configuration the CRM reads at runtime; nothing here is hard-coded in forms')} />
      <div className="page">
        <nav className="card flush" aria-label={t('Settings sections')}>
          <div className="tabs" style={{ borderBottom: 0 }}>
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'tab on' : 'tab')}>
                {l.label}
              </NavLink>
            ))}
          </div>
        </nav>
        <Outlet />
      </div>
    </>
  );
}
