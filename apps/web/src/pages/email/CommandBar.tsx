import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { localNow } from '@dait-crm/shared';
import type { ListSort } from '../../api/mail';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { useT } from '../../i18n/useT';
import type { ComposeStart } from './ComposeModal';
import { fitCommands } from './fitCommands';
import { flagEntries, FollowUpMenu, Menu, moveEntries, NewMailMenu, sortEntries, type MenuEntry } from './menus';
import { useMailShortcuts } from './useMailShortcuts';
import type { CommandId, MailTarget, useMailCommands } from './useMailCommands';

type Point = { x: number; y: number };
type MenuKind = 'new' | 'move' | 'flag' | 'followUp' | 'more' | 'sort';

/** The View tab's toggles: the list's conversation view and sort, the folder pane and the lead panel. */
export type CommandBarView = {
  conv: boolean;
  sort: ListSort;
  dir: 'asc' | 'desc';
  setQuery: (change: Record<string, string | undefined>) => void;
  foldersClosed: boolean;
  onToggleFolders: () => void;
  leadPanelClosed: boolean;
  onToggleLeadPanel: () => void;
};

type Props = {
  /** The open message (in conversation view its row's conversation, F24), or null. */
  target: MailTarget | null;
  commands: ReturnType<typeof useMailCommands>;
  view: CommandBarView;
  /** New from template: Compose filled from the template. */
  onCompose: (s: ComposeStart) => void;
};

/** A Home command: `short` ones lose their label when the bar is compact (mockup `data-short`). */
type Cmd = { kind: 'cmd'; id: CommandId; label: string; icon: ReactNode; short?: boolean; crm?: boolean; menu?: boolean; caret?: boolean; title?: string };
type Item = Cmd | { kind: 'sep'; key: string };

/** Under a button, from its left edge. */
const below = (el: HTMLElement): Point => {
  const r = el.getBoundingClientRect();
  return { x: Math.max(8, r.left), y: r.bottom + 4 };
};

/** An element's width with its side margins (separators have margins, F29 carry). */
const outer = (el: HTMLElement) => {
  const cs = getComputedStyle(el);
  return el.offsetWidth + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
};

/**
 * The Email screen's command bar (web-mail release 2, mockup "Command bar"): the Home and View tabs. Home: the split
 * New mail ▾ (templates), Delete, Archive, Move to ▾ | Reply, Reply all, Forward | Flag ▾, Mark as unread / read | the
 * orange CRM commands Follow-up ▾, Link to lead ▾, Log as activity, Create task, Schedule meeting, and "…" with what
 * does not fit plus Mark as read and Open lead (F33). A ResizeObserver feeds fitCommands: short of room, the shorter
 * commands show their icon only (named by aria-label and title), then the tail moves into "…". View: Conversation view,
 * Sort by ▾, Folder pane and Lead panel. Every command, and every keyboard shortcut, goes through the commands' rules.
 */
export function CommandBar({ target, commands, view, onCompose }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const [tab, setTab] = useState<'home' | 'view'>('home');
  const [menu, setMenu] = useState<{ kind: MenuKind; at: Point } | null>(null);
  const [fit, setFit] = useState<{ compact: boolean; visible: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);

  // Shortcuts run the same commands on the same target, so view only and the other rules hold (Ctrl/⌘+U marks unread, F31).
  useMailShortcuts((id) => {
    if (id === 'toggleRead') {
      if (target?.item && !target.item.isRead) return;
      commands.run('toggleRead', target, false);
      return;
    }
    commands.run(id, target);
  }, { enabled: true, onEscape: () => setMenu(null) });

  const s = (id: CommandId) => commands.state(id, target);
  const items: Item[] = [
    { kind: 'cmd', id: 'delete', label: t('Delete'), icon: Icons.trash, short: true },
    { kind: 'cmd', id: 'archive', label: t('Archive'), icon: Icons.archive, short: true },
    { kind: 'cmd', id: 'move', label: t('Move to'), icon: Icons.move, short: true, menu: true, caret: true },
    { kind: 'sep', key: 's1' },
    { kind: 'cmd', id: 'reply', label: t('Reply'), icon: Icons.reply },
    { kind: 'cmd', id: 'replyAll', label: t('Reply all'), icon: Icons.replyall, short: true },
    { kind: 'cmd', id: 'forward', label: t('Forward'), icon: Icons.forward, short: true },
    { kind: 'sep', key: 's2' },
    { kind: 'cmd', id: 'flag', label: t('Flag'), icon: Icons.flag, short: true, menu: true },
    { kind: 'cmd', id: 'toggleRead', label: s('toggleRead').label ?? t('Mark as unread'), icon: Icons.unread, short: true },
    { kind: 'sep', key: 's3' },
    { kind: 'cmd', id: 'followUp', label: t('Follow-up'), icon: Icons.followup, crm: true, menu: true, caret: true, title: t("Set the lead's next follow-up date (CRM)") },
    { kind: 'cmd', id: 'link', label: t('Link to lead'), icon: Icons.link, crm: true, menu: true },
    { kind: 'cmd', id: 'log', label: t('Log as activity'), icon: Icons.activity, crm: true },
    { kind: 'cmd', id: 'task', label: t('Create task'), icon: Icons.task, crm: true },
    { kind: 'cmd', id: 'meeting', label: t('Schedule meeting'), icon: Icons.meeting, crm: true },
  ];
  const visible = fit?.visible ?? items.length;
  const compact = fit?.compact ?? false;

  /**
   * Measures every item at full width and compact (labels of the short ones hidden), each with its margins and the
   * row's gap, and fits them into the room left beside New mail ▾ and "…" (F29). Not laid out yet (width 0): everything shows.
   */
  const measure = useCallback(() => {
    const bar = barRef.current;
    const row = rowRef.current;
    const box = itemsRef.current;
    if (!bar || !row || !box) return;
    const width = row.offsetWidth;
    if (!width) return setFit(null);
    const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0;
    // The room beside New mail ▾ and the always-shown "…" (F29).
    const room = width - [...row.children].filter((c) => c !== box).reduce((sum, c) => sum + outer(c as HTMLElement) + rowGap, 0);
    const kids = [...box.children] as HTMLElement[];
    const hidden = kids.map((k) => k.hidden);
    const wasCompact = bar.classList.contains('compact');
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
    kids.forEach((k) => { k.hidden = false; });
    bar.classList.remove('compact');
    const full = kids.map((k) => outer(k) + gap);
    bar.classList.add('compact');
    const small = kids.map((k) => outer(k) + gap);
    bar.classList.toggle('compact', wasCompact);
    kids.forEach((k, i) => { k.hidden = hidden[i]!; });
    const next = fitCommands(full, small, room);
    setFit((f) => (f && f.compact === next.compact && f.visible === next.visible ? f : next));
  }, []);

  // Again when the labels change (language, Mark as unread / read) and whenever the bar's room changes.
  const labels = items.map((i) => (i.kind === 'cmd' ? i.label : '|')).join();
  useLayoutEffect(() => {
    if (tab === 'home') measure();
  }, [labels, tab, measure]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => measure());
    watch.observe(row);
    return () => watch.disconnect();
  }, [tab, measure]);

  /** Opens `kind` under the button, or closes it when it is the one open (its mousedown is kept from the menu). */
  const opener = (kind: MenuKind) => ({
    'aria-haspopup': 'menu' as const,
    'aria-expanded': menu?.kind === kind,
    onMouseDown: (e: MouseEvent) => {
      if (menu?.kind === kind) e.stopPropagation();
    },
    onClick: (e: MouseEvent<HTMLElement>) => setMenu(menu?.kind === kind ? null : { kind, at: below(e.currentTarget) }),
  });

  const runCmd = (c: Cmd, el: HTMLElement) => {
    if (c.id === 'link') commands.run('link', target, below(el));
    else if (c.menu) setMenu(menu?.kind === c.id ? null : { kind: c.id as MenuKind, at: below(el) });
    else commands.run(c.id, target);
  };

  const flagMenu = () => flagEntries(t, localNow(me.timezone).day, me.language, (f) => commands.run('flag', target, f));
  const moveMenu = () => moveEntries(t, (f) => commands.run('move', target, f));

  /** "…": the commands that do not fit, then Mark as read and Open lead (F33). */
  const overflow = (): MenuEntry[] => {
    const at = menu?.at ?? { x: 8, y: 8 };
    const tail = items.slice(visible).filter((i): i is Cmd => i.kind === 'cmd').map((c): MenuEntry => {
      const st = s(c.id);
      const base = { key: c.id, label: c.label, icon: c.icon, crm: c.crm, disabled: !st.enabled, title: st.title ?? c.title };
      if (c.id === 'move') return { ...base, submenu: st.enabled ? moveMenu() : undefined };
      if (c.id === 'flag') return { ...base, submenu: st.enabled ? flagMenu() : undefined };
      if (c.id === 'followUp') return { ...base, onSelect: () => setMenu({ kind: 'followUp', at }) };
      if (c.id === 'link') return { ...base, onSelect: () => commands.run('link', target, at) };
      return { ...base, onSelect: () => commands.run(c.id, target) };
    });
    const read = s('toggleRead');
    const open = s('openLead');
    return [
      ...tail,
      ...(tail.length ? [{ kind: 'sep' as const, key: 'sep' }] : []),
      { key: 'read', label: t('Mark as read'), icon: Icons.eye, disabled: !read.enabled, title: read.title, onSelect: () => commands.run('toggleRead', target, true) },
      { key: 'openLead', label: t('Open lead'), icon: Icons.external, crm: true, disabled: !open.enabled, title: open.title, onSelect: () => commands.run('openLead', target) },
    ];
  };

  const close = () => setMenu(null);
  const foldName = view.foldersClosed ? t('Expand folder pane') : t('Collapse folder pane');
  const leadName = view.leadPanelClosed ? t('Expand lead panel') : t('Collapse lead panel');

  return (
    <div ref={barRef} className={compact ? 'wm-cmdbar compact' : 'wm-cmdbar'}>
      <div className="cmd-tabs" role="tablist" aria-label={t('Command tabs')}>
        {(['home', 'view'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`wm-tab-${k}`}
            aria-selected={tab === k}
            aria-controls="wm-cmd-panel"
            className={tab === k ? 'on' : undefined}
            onClick={() => {
              setTab(k);
              setMenu(null);
            }}
          >
            {k === 'home' ? t('Home|ribbon') : t('View|ribbon')}
          </button>
        ))}
      </div>

      <div ref={rowRef} id="wm-cmd-panel" className="cmd-row" role="tabpanel" aria-labelledby={`wm-tab-${tab}`}>
        {tab === 'home' ? (
          <>
            <div className="split">
              <button type="button" className="btn sm primary" onClick={() => commands.run('new', null)}>
                <span className="ico" aria-hidden="true">{Icons.mailplus}</span>
                {t('New mail')}
              </button>
              <button type="button" className="btn sm primary" aria-label={t('More new mail options')} title={t('More new mail options')} {...opener('new')}>
                <span className="ico" aria-hidden="true">{Icons.down}</span>
              </button>
            </div>
            <div ref={itemsRef} className="cmd-items" role="toolbar" aria-label={t('Mail commands')}>
              {items.map((it, i) => {
                const gone = i >= visible;
                if (it.kind === 'sep') return <span key={it.key} className="cmd-sep" hidden={gone} />;
                const st = s(it.id);
                const iconOnly = compact && it.short;
                return (
                  <button
                    key={it.id}
                    type="button"
                    className={it.crm ? 'cmd crm' : 'cmd'}
                    data-short={it.short ? '' : undefined}
                    hidden={gone}
                    disabled={!st.enabled}
                    title={st.title ?? it.title ?? (iconOnly ? it.label : undefined)}
                    aria-label={iconOnly ? it.label : undefined}
                    aria-haspopup={it.menu ? 'menu' : undefined}
                    aria-expanded={it.menu && it.id !== 'link' ? menu?.kind === it.id : undefined}
                    onMouseDown={(e) => {
                      if (menu?.kind === it.id) e.stopPropagation();
                    }}
                    onClick={(e) => runCmd(it, e.currentTarget)}
                  >
                    <span className="ico" aria-hidden="true">{it.icon}</span>
                    <span className="lb">{it.label}</span>
                    {it.caret ? <span className="ico car" aria-hidden="true">{Icons.down}</span> : null}
                  </button>
                );
              })}
            </div>
            <button type="button" className="cmd cmd-more" aria-label={t('More commands')} title={t('More commands')} {...opener('more')}>
              <span className="ico" aria-hidden="true">{Icons.more}</span>
            </button>
          </>
        ) : (
          <div className="cmd-items">
            <label className="cmd convsw">
              <input type="checkbox" role="switch" checked={view.conv} onChange={(e) => view.setQuery({ conv: e.target.checked ? undefined : '0' })} />
              {t('Conversation view')}
            </label>
            <span className="cmd-sep" />
            <button type="button" className="cmd" {...opener('sort')}>
              <span className="ico" aria-hidden="true">{Icons.swap}</span>
              <span className="lb">{t('Sort by')}</span>
              <span className="ico car" aria-hidden="true">{Icons.down}</span>
            </button>
            <span className="cmd-sep" />
            <button type="button" className="cmd" aria-pressed={!view.foldersClosed} title={foldName} onClick={view.onToggleFolders}>
              <span className="ico" aria-hidden="true">{view.foldersClosed ? Icons.dblr : Icons.dbl}</span>
              <span className="lb">{t('Folder pane')}</span>
            </button>
            <button type="button" className="cmd" aria-pressed={!view.leadPanelClosed} title={leadName} onClick={view.onToggleLeadPanel}>
              <span className="ico" aria-hidden="true">{view.leadPanelClosed ? Icons.dbl : Icons.dblr}</span>
              <span className="lb">{t('Lead panel')}</span>
            </button>
          </div>
        )}
      </div>

      {menu?.kind === 'new' ? <NewMailMenu at={menu.at} onNew={() => commands.run('new', null)} onCompose={onCompose} onClose={close} /> : null}
      {menu?.kind === 'move' && target ? <Menu at={menu.at} label={t('Move to')} items={moveMenu()} onClose={close} /> : null}
      {menu?.kind === 'flag' && target ? <Menu at={menu.at} label={t('Flag')} items={flagMenu()} onClose={close} /> : null}
      {menu?.kind === 'followUp' && target ? <FollowUpMenu at={menu.at} target={target} commands={commands} onClose={close} /> : null}
      {menu?.kind === 'more' ? <Menu at={menu.at} label={t('More commands')} items={overflow()} onClose={close} /> : null}
      {menu?.kind === 'sort' ? <Menu at={menu.at} label={t('Sort by')} items={sortEntries(t, view.sort, view.dir, view.setQuery)} onClose={close} /> : null}
    </div>
  );
}
