import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useNavCounts } from '../api/notifications';
import type { Me } from '../api/queries';
import { useT } from '../i18n/useT';
import { initials, roleText } from '../i18n/labels';
import { Icons } from './Icons';

type SidebarProps = { me: Me; open: boolean; onNavigate: () => void };

const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'nav on' : 'nav');

/** The prototype's sidebar() (prototype/js/app.js) without the "Act as" switcher. */
export function Sidebar({ me, open, onNavigate }: SidebarProps) {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const counts = useNavCounts().data;
  const badge = (n: number | undefined, text: string, hot = false) =>
    n ? <span className={hot ? 'cnt hot' : 'cnt'}>{text}</span> : null;

  async function signOut() {
    try {
      await api<void>('/api/auth/logout', { method: 'POST', noAuthRedirect: true });
    } finally {
      qc.clear();
      navigate('/sign-in', { replace: true });
    }
  }

  const item = (to: string, label: string, icon: keyof typeof Icons, end = false, badge?: ReactNode) => (
    <NavLink to={to} end={end} className={cls} onClick={onNavigate}>
      {Icons[icon]}
      {label}
      {badge}
    </NavLink>
  );

  return (
    <nav id="sidebar" className={open ? 'sidebar open' : 'sidebar'} aria-label={t('Main navigation')}>
      <div className="brand">
        <img src="/logo-mark.svg" alt="" />
        <div>
          <b>{t('DAIT Partners')}</b>
          <small>{t('Sales CRM')}</small>
        </div>
      </div>
      {item('/', t('Dashboard'), 'dash', true)}
      <div className="navsec">{t('Modules')}</div>
      {item('/leads', t('Leads'), 'leads', false, badge(counts?.leads, String(counts?.leads)))}
      {item('/companies', t('Companies'), 'companies')}
      {item('/contacts', t('Contacts'), 'contacts')}
      {me.rights.includes('use_email') ? item('/email', t('Email'), 'mail', false, badge(counts?.mailUnread, String(counts?.mailUnread))) : null}
      {me.rights.includes('use_email') ? item('/mailer', t('Mailer'), 'send', false, badge(counts?.mailerLive, t('{n} live', { n: counts?.mailerLive ?? 0 }), true)) : null}
      {item('/calendar', t('Calendar'), 'calendar')}
      {item('/quotations', t('Quotations'), 'quote')}
      <div className="navsec">{t('Work')}</div>
      {item('/tasks', t('Tasks'), 'tasks', false, badge(counts?.overdueTasks, t('{n} overdue', { n: counts?.overdueTasks ?? 0 })))}
      {item('/notifications', t('Notifications'), 'bell', false, badge(counts?.unread, t('{n} new', { n: counts?.unread ?? 0 }), true))}
      {item('/reports', t('Reports'), 'reports')}
      <div className="grow" />
      {item('/settings', t('Settings'), 'settings')}
      <div className="me">
        <span className="av" aria-hidden="true">
          {initials(me.name)}
        </span>
        <div className="who">
          <div className="nm">{me.name}</div>
          <small>{roleText(t, me.role)}</small>
          <button type="button" className="signout" onClick={signOut}>
            {t('Sign out')}
          </button>
        </div>
      </div>
    </nav>
  );
}
