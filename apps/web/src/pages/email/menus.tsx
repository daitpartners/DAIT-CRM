import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FLAG_PRESETS, flagDueDay, localNow, type FlagPreset } from '@dait-crm/shared';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { useT, type TFn } from '../../i18n/useT';
import { dayLabel } from './listDates';
import type { CommandId, FlagChoice, MailTarget, useMailCommands } from './useMailCommands';

/** A menu line: a command (with an optional submenu), a separator, or a small heading. */
export type MenuEntry =
  | {
    kind?: 'item'; key: string; label: string; icon?: ReactNode; hint?: string; danger?: boolean; crm?: boolean;
    /** A keyboard shortcut (`aria-keyshortcuts`): its hint is shown but not read as part of the name. */
    keys?: string;
    checked?: boolean; disabled?: boolean; title?: string; onSelect?: () => void; submenu?: MenuEntry[];
  }
  | { kind: 'sep'; key: string }
  | { kind: 'head'; key: string; label: string };
type ItemEntry = Extract<MenuEntry, { label: string; key: string }> & { kind?: 'item' };

const isItem = (e: MenuEntry): e is ItemEntry => e.kind === undefined || e.kind === 'item';
const MARGIN = 8;

type MenuProps = {
  /** Where it opens (the pointer, or under a button), kept inside the window. */
  at: { x: number; y: number };
  items: MenuEntry[];
  label: string;
  onClose: () => void;
  /** Inside another menu: ← closes it and gives focus back to its item. */
  onBack?: () => void;
};

/**
 * The Email screen's menu (mockup `.mm`): `role="menu"` with `menuitem` buttons, opened at a point and kept inside the
 * window. ↑ ↓ (and Home, End) move between the enabled items, Esc and a click outside close it; an item with a submenu
 * opens it on hover or →, and ← or Esc closes the submenu. Choosing an item closes the menu, then runs the item.
 */
export function Menu({ at, items, label, onClose, onBack }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const [open, setOpen] = useState<{ key: string; at: { x: number; y: number }; focus: boolean } | null>(null);

  // Kept inside the window once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(MARGIN, Math.min(at.x, window.innerWidth - r.width - MARGIN));
    const y = Math.max(MARGIN, Math.min(at.y, window.innerHeight - r.height - MARGIN));
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
    // Only the opening point moves it.
  }, [at.x, at.y]);

  // Its own items only (not a submenu's).
  const buttons = () => [...(ref.current?.children ?? [])].filter((el): el is HTMLButtonElement => el instanceof HTMLButtonElement && !el.disabled);

  // The first enabled item takes focus (the keyboard starts in the menu).
  useEffect(() => {
    buttons()[0]?.focus();
  }, []);

  // A root menu closes on a click outside it (its submenus are inside it) and on Esc from anywhere.
  useEffect(() => {
    if (onBack) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [onBack, onClose]);

  const openSub = (e: ItemEntry, el: HTMLElement, focus: boolean) => {
    const r = el.getBoundingClientRect();
    setOpen({ key: e.key, at: { x: r.right + 2, y: r.top - 6 }, focus });
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    // A submenu handles its own keys.
    if (ev.target instanceof HTMLElement && ev.target.closest('[role="menu"]') !== ref.current) return;
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    switch (ev.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i < 0 ? -1 : i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(-1); break;
      case 'ArrowRight': {
        const entry = items.find((e) => isItem(e) && e.key === list[i]?.dataset.key);
        if (entry && isItem(entry) && entry.submenu && list[i]) openSub(entry, list[i]!, true);
        else return;
        break;
      }
      case 'ArrowLeft':
        if (!onBack) return;
        onBack();
        break;
      case 'Escape':
        (onBack ?? onClose)();
        break;
      case 'Tab':
        onClose();
        return;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  };

  const sub = open ? items.find((e): e is ItemEntry => isItem(e) && e.key === open.key) : undefined;

  return (
    <div ref={ref} className="mm" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
      {items.map((e) => {
        if (e.kind === 'sep') return <div key={e.key} className="msep" role="separator" />;
        if (e.kind === 'head') return <div key={e.key} className="mhd">{e.label}</div>;
        const cls = ['mi', e.danger ? 'danger' : '', e.crm ? 'crm' : '', open?.key === e.key ? 'hl' : ''].filter(Boolean).join(' ');
        return (
          <button
            key={e.key}
            type="button"
            role="menuitem"
            className={cls}
            data-key={e.key}
            disabled={e.disabled}
            title={e.title}
            aria-keyshortcuts={e.keys}
            aria-haspopup={e.submenu ? 'menu' : undefined}
            aria-expanded={e.submenu ? open?.key === e.key : undefined}
            onMouseEnter={(ev) => {
              if (e.submenu) openSub(e, ev.currentTarget, false);
              else setOpen(null);
            }}
            onClick={(ev) => {
              if (e.submenu) {
                openSub(e, ev.currentTarget, true);
                return;
              }
              onClose();
              e.onSelect?.();
            }}
          >
            <span className="ico" aria-hidden="true">{e.checked === false ? null : e.checked ? Icons.check : e.icon}</span>
            {e.label}
            {e.submenu ? <span className="sub-car" aria-hidden="true">›</span> : e.hint ? <span className="k" aria-hidden={e.keys ? true : undefined}>{e.hint}</span> : null}
          </button>
        );
      })}
      {sub?.submenu && open ? (
        <SubMenu
          key={open.key}
          at={open.at}
          items={sub.submenu}
          label={sub.label}
          focus={open.focus}
          onClose={onClose}
          onBack={() => {
            setOpen(null);
            ref.current?.querySelector<HTMLButtonElement>(`[data-key="${sub.key}"]`)?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

/** A submenu opened on hover keeps the focus where it was; opened with → or a click, it takes it. */
function SubMenu({ focus, ...props }: MenuProps & { focus: boolean }) {
  const holder = useRef<HTMLSpanElement>(null);
  const before = useRef<Element | null>(document.activeElement);
  // Runs after the inner menu focused its first item; → on an item whose submenu hover opened moves the focus in.
  useEffect(() => {
    if (focus) holder.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    else if (before.current instanceof HTMLElement) before.current.focus();
  }, [focus]);
  return (
    <span ref={holder} className="mm-sub">
      <Menu {...props} />
    </span>
  );
}

/** Move to: Inbox, Archive, Deleted items. */
export function moveEntries(t: TFn, onMove: (folder: 'inbox' | 'archive' | 'deleted') => void): MenuEntry[] {
  return [
    { key: 'inbox', label: t('Inbox'), icon: Icons.inbox, onSelect: () => onMove('inbox') },
    { key: 'archive', label: t('Archive'), icon: Icons.archive, onSelect: () => onMove('archive') },
    { key: 'deleted', label: t('Deleted items'), icon: Icons.trash, onSelect: () => onMove('deleted') },
  ];
}

const flagText = (t: TFn, p: FlagPreset) => ({
  today: t('Today'), tomorrow: t('Tomorrow'), thisWeek: t('This week'), nextWeek: t('Next week'), noDate: t('No date'),
})[p];

/** Flag: Today, Tomorrow, This week, Next week (each with its due day, `Thu 26 Nov`), No date | Mark complete, Clear flag. */
export function flagEntries(t: TFn, today: string, language: string, onFlag: (flag: FlagChoice) => void): MenuEntry[] {
  const presets = FLAG_PRESETS.map((p): MenuEntry => {
    const due = flagDueDay(p, today);
    return { key: p, label: flagText(t, p), icon: Icons.flag, hint: due ? dayLabel(due, language) : undefined, onSelect: () => onFlag(p) };
  });
  return [
    ...presets,
    { kind: 'sep', key: 'sep' },
    { key: 'complete', label: t('Mark complete'), icon: Icons.check, onSelect: () => onFlag('complete') },
    { key: 'clear', label: t('Clear flag'), icon: Icons.x, onSelect: () => onFlag('clear') },
  ];
}

/** The user's today and language, for the Flag menu's due days. */
function useFlagDays(): { today: string; language: string } {
  const me = useCurrentUser();
  return { today: localNow(me.timezone).day, language: me.language };
}

type Commands = ReturnType<typeof useMailCommands>;

/** Move to ▾ (the bulk bar): the folders for `target`. */
export function MoveMenu({ at, target, commands, onClose }: { at: { x: number; y: number }; target: MailTarget; commands: Commands; onClose: () => void }) {
  const t = useT();
  return <Menu at={at} label={t('Move to')} items={moveEntries(t, (f) => commands.run('move', target, f))} onClose={onClose} />;
}

/** Flag ▾ (the bulk bar): the flag choices for `target`. */
export function FlagMenu({ at, target, commands, onClose }: { at: { x: number; y: number }; target: MailTarget; commands: Commands; onClose: () => void }) {
  const t = useT();
  const { today, language } = useFlagDays();
  return <Menu at={at} label={t('Flag')} items={flagEntries(t, today, language, (f) => commands.run('flag', target, f))} onClose={onClose} />;
}

/**
 * A message's menu (mockup state 4: right-click on a row; later the reading pane's More actions): Reply, Reply all,
 * Forward | Delete, Archive, Move to ›, Flag ›, Mark as unread | Link to lead, Log as activity, Create task, Open lead,
 * each enabled and titled by the commands' rules for `target`.
 */
export function RowMenu({ at, target, commands, onClose }: { at: { x: number; y: number }; target: MailTarget; commands: Commands; onClose: () => void }) {
  const t = useT();
  const { today, language } = useFlagDays();
  const item = (id: CommandId, label: string, icon: ReactNode, more: Partial<ItemEntry> = {}): MenuEntry => {
    const s = commands.state(id, target);
    return {
      key: id, label: s.label ?? label, icon, disabled: !s.enabled, title: s.title,
      onSelect: () => commands.run(id, target), ...more,
      ...(more.submenu && !s.enabled ? { submenu: undefined } : {}),
    };
  };
  const items: MenuEntry[] = [
    item('reply', t('Reply'), Icons.reply),
    item('replyAll', t('Reply all'), Icons.replyall),
    item('forward', t('Forward'), Icons.forward),
    { kind: 'sep', key: 's1' },
    item('delete', t('Delete'), Icons.trash, { danger: true, hint: t('Del|key'), keys: 'Delete' }),
    item('archive', t('Archive'), Icons.archive, { hint: 'E', keys: 'E' }),
    item('move', t('Move to'), Icons.move, { submenu: moveEntries(t, (f) => commands.run('move', target, f)) }),
    item('flag', t('Flag'), Icons.flag, { submenu: flagEntries(t, today, language, (f) => commands.run('flag', target, f)) }),
    item('toggleRead', t('Mark as unread'), Icons.unread, { hint: 'Ctrl+U', keys: 'Control+U' }),
    { kind: 'sep', key: 's2' },
    item('link', t('Link to lead'), Icons.link, { crm: true }),
    item('log', t('Log as activity'), Icons.activity, { crm: true }),
    item('task', t('Create task'), Icons.task, { crm: true }),
    item('openLead', t('Open lead'), Icons.external, { crm: true }),
  ];
  return <Menu at={at} label={t('Message actions')} items={items} onClose={onClose} />;
}
