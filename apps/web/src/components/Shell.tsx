import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import type { Me } from '../api/queries';
import { useT } from '../i18n/useT';
import { Icons } from './Icons';
import { Sidebar } from './Sidebar';

/** Sidebar + main column. Below 900 px the sidebar collapses into a top bar with a menu button. */
export function Shell({ me }: { me: Me }) {
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  return (
    <div className="shell">
      <div className="mobilebar">
        <img src="/logo-mark-white.svg" alt="" />
        <b>{t('DAIT Partners CRM')}</b>
        <button
          type="button"
          className="menu"
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpen((o) => !o)}
        >
          {navOpen ? Icons.close : Icons.menu}
          {navOpen ? t('Close') : t('Menu')}
        </button>
      </div>
      <Sidebar me={me} open={navOpen} onNavigate={() => setNavOpen(false)} />
      <div className={navOpen ? 'nav-scrim open' : 'nav-scrim'} onClick={() => setNavOpen(false)} aria-hidden="true" />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
