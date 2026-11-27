import { Fragment, useEffect, useRef, useState, type Dispatch, type MouseEvent, type ReactNode, type SetStateAction } from 'react';
import { MAIL_CHIPS, type ListSort, type MailChip, type MailDetail, type MailFilter, type MailItem, type MailView } from '../../api/mail';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { useT, type TFn } from '../../i18n/useT';
import { viewLabel } from './FolderPane';
import { dateGroup, type DateGroup } from './listDates';
import { FlagMenu, Menu, MoveMenu, RowMenu, sortEntries } from './menus';
import { MessageRow } from './MessageRow';
import { rowTarget, selectionTarget, type CommandId, type useMailCommands } from './useMailCommands';

/** Where the Email screen fits the window and the list scrolls in its own column (app.css). */
const WIDE = '(min-width:1100px)';

type Point = { x: number; y: number };

type Props = {
  view: MailView;
  teamView: boolean;
  filter: MailFilter;
  /** The Inbox's unread count (the folder pane's). */
  unread: number | undefined;
  list: {
    items: MailItem[]; total: number; isLoading: boolean; hasNextPage: boolean; isFetchingNextPage: boolean; isPlaceholderData: boolean;
    fetchNextPage: () => unknown;
  };
  selectedId: number | null;
  /** The message open in the reading pane: a list answered before the open marked it read still shows it read. */
  opened: MailDetail | undefined;
  rowHref: (id: number) => string;
  setQuery: (change: Record<string, string | undefined>) => void;
  /** Under the chips: the link's client / lead / project chip. */
  extra?: ReactNode;
  commands: ReturnType<typeof useMailCommands>;
  /** The checked rows' ids (kept by the page: while rows are checked, the command bar and shortcuts act on them). */
  checked: Set<number>;
  setChecked: Dispatch<SetStateAction<Set<number>>>;
};

const groupText = (t: TFn, g: DateGroup) => ({
  today: t('Today'), yesterday: t('Yesterday'), thisWeek: t('This week'), lastWeek: t('Last week'), older: t('Older'),
})[g];
const chipText = (t: TFn, c: MailChip) => ({ all: t('All'), unread: t('Unread'), flagged: t('Flagged'), attachments: t('Attachments') })[c];

function sortButtonText(t: TFn, sort: ListSort): string {
  switch (sort) {
    case 'date': return t('By date');
    case 'from': return t('By from');
    case 'lead': return t('By lead');
    case 'stage': return t('By lead stage');
    case 'size': return t('By size');
  }
}

/** Under a button, its right edge on the button's (a menu about 200 px wide). */
const below = (el: HTMLElement): Point => {
  const r = el.getBoundingClientRect();
  return { x: Math.max(8, r.right - 200), y: r.bottom + 4 };
};

/**
 * The message list (web-mail release 2, mockup states 1, 4 and 5): the header (the view's name, its unread count or
 * total, the Conversation view switch, the sort menu), the quick filter chips, date groups when sorted by date, the rows
 * with their hover actions and right-click menu, and the bulk bar that replaces the header once rows are checked. The
 * next 50 load when the list's foot comes near (owner, 23 Nov 2026: no page numbers).
 */
export function MessageList({ view, teamView, filter, unread, list, selectedId, opened, rowHref, setQuery, extra, commands, checked, setChecked }: Props) {
  const t = useT();
  const me = useCurrentUser();
  const { items, total, isLoading, hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage } = list;
  const rowsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [rowMenu, setRowMenu] = useState<{ id: number; at: Point } | null>(null);
  const [menu, setMenu] = useState<{ kind: 'sort' | 'move' | 'flag'; at: Point } | null>(null);

  // Another folder, filter or search starts at the top of the list, with nothing checked.
  const listKey = JSON.stringify(filter);
  useEffect(() => {
    if (rowsRef.current) rowsRef.current.scrollTop = 0;
    setChecked(new Set());
    setRowMenu(null);
  }, [listKey]);

  // Desktop or not (the 1100 px breakpoint where the rows start scrolling in their own column), followed on resize.
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(WIDE);
    if (!media) return;
    const change = () => setWide(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  /**
   * The next batch loads when the list's foot comes near: within the rows' own column on desktop (owner, 23 Nov 2026:
   * the screen fits the window), within the window where the page itself scrolls (chosen again when the window crosses
   * the breakpoint). Watching again after each batch keeps loading while the foot is still in view (a tall screen).
   * Nothing is watched while the previous filter's rows stand in for the new ones, so its first batch is asked once.
   */
  const loaded = items.length;
  useEffect(() => {
    const foot = moreRef.current;
    if (!foot || !hasNextPage || isFetchingNextPage || isPlaceholderData || typeof IntersectionObserver === 'undefined') return;
    const rows = rowsRef.current;
    const root = rows && getComputedStyle(rows).overflowY !== 'visible' ? rows : null;
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
    }, { root, rootMargin: '0px 0px 300px 0px' });
    watch.observe(foot);
    return () => watch.disconnect();
  }, [hasNextPage, isFetchingNextPage, isPlaceholderData, loaded, listKey, wide, fetchNextPage]);

  const sort = filter.sort ?? 'date';
  const dir = filter.dir ?? 'desc';
  const chip = filter.chip ?? 'all';
  const grouped = sort === 'date';
  // Rows that left the list (moved, deleted) are no longer checked.
  const selected = items.filter((m) => checked.has(m.id));
  const selection = selectionTarget(selected);
  const check = (id: number, on: boolean) => setChecked((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });

  const openRowMenu = (m: MailItem) => (e: MouseEvent) => {
    e.preventDefault();
    // From the keyboard (the menu key, Shift+F10) there is no pointer: the menu opens over the row.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 40, y: r.top + 20 };
    setMenu(null);
    setRowMenu({ id: m.id, at });
  };
  const menuRow = rowMenu ? items.find((m) => m.id === rowMenu.id) : undefined;

  const sortItems = sortEntries(t, sort, dir, setQuery);

  const bulk = (id: CommandId, icon: ReactNode, label: string, arg?: unknown) => {
    const s = commands.state(id, selection);
    return (
      <button type="button" className="btn sm" disabled={!s.enabled} title={s.title} onClick={() => commands.run(id, selection, arg)}>
        <span className="ico" aria-hidden="true">{icon}</span>
        {label}
      </button>
    );
  };
  const bulkMenu = (kind: 'move' | 'flag', id: CommandId, icon: ReactNode, label: string) => {
    const s = commands.state(id, selection);
    return (
      <button
        type="button"
        className="btn sm"
        disabled={!s.enabled}
        title={s.title}
        aria-haspopup="menu"
        aria-expanded={menu?.kind === kind}
        onClick={(e) => setMenu(menu?.kind === kind ? null : { kind, at: below(e.currentTarget) })}
      >
        <span className="ico" aria-hidden="true">{icon}</span>
        {label} ▾
      </button>
    );
  };

  let group: DateGroup | null = null;

  return (
    <section className="msglist" aria-label={t('Message list')}>
      {selected.length ? (
        <div className="ml-head ml-bulk">
          <strong>{t('{n} selected', { n: selected.length })}</strong>
          <div className="ml-bulk-acts">
            {bulk('delete', Icons.trash, t('Delete'))}
            {bulk('archive', Icons.archive, t('Archive'))}
            {bulkMenu('move', 'move', Icons.move, t('Move to'))}
            {bulkMenu('flag', 'flag', Icons.flag, t('Flag'))}
            {bulk('toggleRead', Icons.mail, t('Mark as read'), true)}
            <button type="button" className="btn sm" onClick={() => setChecked(new Set())}>
              {t('Clear selection')}
            </button>
          </div>
        </div>
      ) : (
        <div className="ml-head">
          <div className="ml-row1">
            <h2>{viewLabel(t, view, teamView)}</h2>
            <span className="cnt-t">
              {view === 'inbox' && unread !== undefined ? t('{n} unread', { n: unread }) : total === 1 ? t('1 message') : t('{n} messages', { n: total })}
            </span>
            <span className="grow" />
            <label className="convsw" title={t('Group messages by conversation')}>
              <input
                type="checkbox"
                role="switch"
                checked={filter.conv !== false}
                onChange={(e) => setQuery({ conv: e.target.checked ? undefined : '0' })}
              />
              {t('Conversation view')}
            </label>
            <button
              type="button"
              className="sortbtn"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'sort'}
              onClick={(e) => setMenu(menu?.kind === 'sort' ? null : { kind: 'sort', at: below(e.currentTarget) })}
            >
              {sortButtonText(t, sort)}
              <span className="ico" aria-hidden="true">{Icons.down}</span>
            </button>
          </div>
          <div className="ml-row2" role="group" aria-label={t('Quick filters')}>
            {MAIL_CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                className={chip === c ? 'fchip on' : 'fchip'}
                aria-pressed={chip === c}
                onClick={() => setQuery({ chip: c === 'all' ? undefined : c })}
              >
                {chipText(t, c)}
              </button>
            ))}
          </div>
          {extra}
        </div>
      )}
      {/* The rows scroll on their own on desktop. */}
      <div className={`msglist-rows${selected.length ? ' selecting' : ''}`} ref={rowsRef}>
        {items.map((m) => {
          const g = grouped ? dateGroup(m.occurredAt, me.timezone) : null;
          const head = g !== null && g !== group;
          group = g;
          return (
            <Fragment key={m.id}>
              {head ? (
                <h3 className="grp">
                  <span className="ico" aria-hidden="true">{Icons.down}</span>
                  {groupText(t, g)}
                </h3>
              ) : null}
              <MessageRow
                m={opened?.id === m.id && opened.isRead ? { ...m, isRead: true } : m}
                on={m.id === selectedId}
                to={rowHref(m.id)}
                team={teamView}
                checked={checked.has(m.id)}
                selecting={selected.length > 0}
                menuOpen={rowMenu?.id === m.id}
                onCheck={(on) => check(m.id, on)}
                onMenu={openRowMenu(m)}
                commands={commands}
              />
            </Fragment>
          );
        })}
        {!isLoading && items.length === 0 ? <div className="empty">{t('No lead mail matches this filter.')}</div> : null}
        {hasNextPage ? (
          <div className="msglist-more" ref={moreRef} role="status">
            {t('Loading…')}
          </div>
        ) : null}
      </div>
      {rowMenu && menuRow ? <RowMenu at={rowMenu.at} target={rowTarget(menuRow)} commands={commands} onClose={() => setRowMenu(null)} /> : null}
      {menu?.kind === 'sort' ? <Menu at={menu.at} label={t('Sort by')} items={sortItems} onClose={() => setMenu(null)} /> : null}
      {menu?.kind === 'move' && selected.length ? <MoveMenu at={menu.at} target={selection} commands={commands} onClose={() => setMenu(null)} /> : null}
      {menu?.kind === 'flag' && selected.length ? <FlagMenu at={menu.at} target={selection} commands={commands} onClose={() => setMenu(null)} /> : null}
    </section>
  );
}
