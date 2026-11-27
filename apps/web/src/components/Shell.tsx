import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import type { Me } from '../api/queries';
import { useStoredFlag } from '../hooks/useStoredFlag';
import { useT } from '../i18n/useT';
import { Icons } from './Icons';
import { UndoSendProvider } from './send/UndoSend';
import { Sidebar } from './Sidebar';

/**
 * Sidebar + main column. Below 900 px the sidebar collapses into a top bar with a menu button. On wider screens the
 * sidebar can be folded to an icon rail, remembered in this browser (owner addition, 23 Nov 2026). The Undo send toast
 * lives here, so it stays while the user moves to another screen (web-mail release 3).
 */
export function Shell({ me }: { me: Me }) {
  const t = useT();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useStoredFlag('dait-sidebar-collapsed');
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
    <UndoSendProvider>
      <div className={collapsed ? 'shell side-collapsed' : 'shell'}>
        <div className="mobilebar">
          <img src="/logo-mark-white.svg" alt="" />
          <b>{t('DAIT Partners CRM')}</b>
          <button
            type="button"
            className="menu-btn"
            aria-expanded={navOpen}
            aria-controls="sidebar"
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? Icons.close : Icons.menu}
            {navOpen ? t('Close') : t('Menu')}
          </button>
        </div>
        <Sidebar me={me} open={navOpen} onNavigate={() => setNavOpen(false)} collapsed={collapsed} onCollapse={setCollapsed} />
        <div className={navOpen ? 'nav-scrim open' : 'nav-scrim'} onClick={() => setNavOpen(false)} aria-hidden="true" />
        <main>
          <Outlet />
        </main>
      </div>
    </UndoSendProvider>
  );
}
