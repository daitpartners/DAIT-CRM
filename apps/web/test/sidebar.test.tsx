import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { keys, type Me } from '../src/api/queries';
import { I18nProvider } from '../src/i18n';
import { Shell } from '../src/components/Shell';
import { Wrap, makeClient, rep } from './leadFixture';

const counts = { leads: 15, overdueTasks: 1, unread: 3, mailUnread: 0, mailerLive: 0, projects: 1 };

function view(me: Me = rep, c = counts) {
  const qc = makeClient(me);
  qc.setQueryData(keys.navCounts, c);
  return render(
    <Wrap qc={qc}>
      <I18nProvider>
        <Shell me={me} />
      </I18nProvider>
    </Wrap>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('collapsible sidebar', () => {
  it('starts expanded; « folds it to an icon rail with names as tooltips, remembered for the next visit', async () => {
    const u = userEvent.setup();
    const { unmount } = view();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(nav).not.toHaveClass('collapsed');

    await u.click(toggle);
    expect(nav).toHaveClass('collapsed');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
    // Each item keeps its name (tooltip and accessible name), with the count where it has one.
    expect(screen.getByRole('link', { name: 'Leads (15)' })).toHaveAttribute('data-label', 'Leads (15)');
    expect(screen.getByRole('link', { name: 'Notifications (3 new)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('data-label', 'Dashboard');
    // Hover shows the name beside the rail (a fixed tooltip, so the rail can keep its own scroll; review N-1).
    await u.hover(screen.getByRole('link', { name: 'Leads (15)' }));
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Leads (15)');
    await u.unhover(screen.getByRole('navigation', { name: 'Main navigation' }));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    // Sign out stays reachable.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(localStorage.getItem('dait-sidebar-collapsed')).toBe('1');

    unmount();
    view();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toHaveClass('collapsed');
    await u.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).not.toHaveClass('collapsed');
    expect(screen.getByRole('link', { name: /^Leads/ })).not.toHaveAttribute('data-label');
    expect(localStorage.getItem('dait-sidebar-collapsed')).toBe('0');
  });

  it('works for the visit when the browser blocks storage', async () => {
    const u = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    view();
    await u.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toHaveClass('collapsed');
  });

  it('Spanish and French badges agree with their number; French calls the menu item Leads', () => {
    const { unmount } = view({ ...rep, language: 'es' }, { ...counts, unread: 1 });
    expect(screen.getByText('1 vencida')).toBeInTheDocument();
    expect(screen.getByText('1 nueva')).toBeInTheDocument();
    unmount();
    view({ ...rep, language: 'fr' }, { ...counts, overdueTasks: 2 });
    expect(screen.getByText('2 en retard')).toBeInTheDocument();
    // Short on screen where the full word does not fit; the full wording for screen readers (review M-12).
    expect(screen.getByText('3 nouv.')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('3 nouvelles')).toHaveClass('sr');
    expect(screen.getByRole('link', { name: /^Leads/ })).toBeInTheDocument();
  });
});
