import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useNavCounts } from '../api/notifications';
import type { Me } from '../api/queries';
import { useT } from '../i18n/useT';
import { initials, roleText } from '../i18n/labels';
import { Icons } from './Icons';

type SidebarProps = {
  me: Me;
  open: boolean;
  onNavigate: () => void;
  /** Folded to an icon rail (wide screens only; below 900 px the sidebar is the menu overlay). */
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
};

const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'nav on' : 'nav');

/**
 * The prototype's sidebar() (prototype/js/app.js) without the "Act as" switcher. Owner addition (23 Nov 2026): « folds
 * it to an icon rail, names as tooltips and counts as a dot on the icon; » opens it again.
 */
export function Sidebar({ me, open, onNavigate, collapsed = false, onCollapse }: SidebarProps) {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const counts = useNavCounts().data;
  // Badge text, also part of the rail's tooltip: "Leads (15)", "Tasks (1 overdue)".
  const count = (n: number | undefined, text: string) => (n ? text : null);
  // es / fr agree with the number: "1 vencida", "3 vencidas".
  const many = (n: number | undefined, one: string, other: string) => (n === 1 ? t(one) : t(other, { n: n ?? 0 }));

  async function signOut() {
    try {
      await api<void>('/api/auth/logout', { method: 'POST', noAuthRedirect: true });
    } finally {
      qc.clear();
      navigate('/sign-in', { replace: true });
    }
  }

  const item = (to: string, label: string, icon: keyof typeof Icons, end = false, badge: string | null = null, hot = false) => {
    const name = badge ? `${label} (${badge})` : label;
    return (
      <NavLink
        to={to}
        end={end}
        className={cls}
        onClick={onNavigate}
        title={collapsed ? name : undefined}
        aria-label={collapsed ? name : undefined}
      >
        {Icons[icon]}
        <span className="nav-l">{label}</span>
        {badge ? <span className={hot ? 'cnt hot' : 'cnt'}>{badge}</span> : null}
      </NavLink>
    );
  };
  const toggleName = collapsed ? t('Expand sidebar') : t('Collapse sidebar');

  return (
    <nav id="sidebar" className={['sidebar', open ? 'open' : '', collapsed ? 'collapsed' : ''].filter(Boolean).join(' ')} aria-label={t('Main navigation')}>
      <div className="brand">
        <img src="/logo-mark.svg" alt="" />
        <div className="brand-t">
          <b>{t('DAIT Partners')}</b>
          <small>{t('Sales CRM')}</small>
        </div>
        <button
          type="button"
          className="side-toggle"
          aria-expanded={!collapsed}
          aria-controls="sidebar"
          aria-label={toggleName}
          title={toggleName}
          onClick={() => onCollapse?.(!collapsed)}
        >
          {Icons.fold}
        </button>
      </div>
      {item('/', t('Dashboard'), 'dash', true)}
      <div className="navsec">{t('Modules')}</div>
      {item('/leads', t('Leads'), 'leads', false, count(counts?.leads, String(counts?.leads)))}
      {item('/companies', t('Companies'), 'companies')}
      {item('/contacts', t('Contacts'), 'contacts')}
      {me.rights.includes('use_email') ? item('/email', t('Email'), 'mail', false, count(counts?.mailUnread, String(counts?.mailUnread))) : null}
      {me.rights.includes('use_email') ? item('/mailer', t('Mailer'), 'send', false, count(counts?.mailerLive, many(counts?.mailerLive, '1 live', '{n} live')), true) : null}
      {item('/calendar', t('Calendar'), 'calendar')}
      {item('/quotations', t('Quotations'), 'quote')}
      {item('/projects', t('Projects'), 'tasks', false, count(counts?.projects, String(counts?.projects)))}
      <div className="navsec">{t('Work')}</div>
      {item('/tasks', t('Tasks'), 'tasks', false, count(counts?.overdueTasks, many(counts?.overdueTasks, '1 overdue', '{n} overdue')))}
      {item('/notifications', t('Notifications'), 'bell', false, count(counts?.unread, many(counts?.unread, '1 new', '{n} new')), true)}
      {item('/reports', t('Reports'), 'reports')}
      <div className="grow" />
      {item('/settings', t('Settings'), 'settings')}
      <div className="me">
        <span className="av" aria-hidden="true" title={collapsed ? me.name : undefined}>
          {initials(me.name)}
        </span>
        <div className="who">
          <div className="nm">{me.name}</div>
          <small>{roleText(t, me.role)}</small>
          <button type="button" className="signout" onClick={signOut} aria-label={t('Sign out')} title={collapsed ? `${t('Sign out')} · ${me.name}` : undefined}>
            {Icons.signout}
            <span className="nav-l">{t('Sign out')}</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
