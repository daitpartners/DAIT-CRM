import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { FLAG_PRESETS, MAIL_SORTS, addDays, flagDueDay, followUpChoices, localNow, type FlagPreset, type FollowUpKey, type ListSort } from '@dait-crm/shared';
import { useLeads } from '../../api/leads';
import { useLeadSuggestions, type MailDetail, type MailItem } from '../../api/mail';
import { useTemplates } from '../../api/templates';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Modal } from '../../components/Modal';
import { useDebounce } from '../../hooks/useDebounce';
import { leadStatusText } from '../../i18n/labels';
import { useT, type TFn } from '../../i18n/useT';
import { dayLabel, dayMonthLabel } from './listDates';
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
  | { kind: 'head'; key: string; label: string }
  | { kind: 'note'; key: string; label: string };
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
  /** Above the items (Link to lead's search field): it takes the focus on opening, and typing in it types. */
  top?: ReactNode;
  className?: string;
};

/**
 * The Email screen's menu (mockup `.mm`): `role="menu"` with `menuitem` buttons, opened at a point and kept inside the
 * window. ↑ ↓ (and Home, End) move between the enabled items, Esc and a click outside close it; an item with a submenu
 * opens it on hover or →, and ← or Esc closes the submenu. Choosing an item closes the menu, then runs the item.
 */
export function Menu({ at, items, label, onClose, onBack, top, className }: MenuProps) {
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

  // The search field, else the first enabled item, takes focus (the keyboard starts in the menu).
  useEffect(() => {
    const field = ref.current?.querySelector<HTMLInputElement>('.mm-top input');
    if (field) field.focus();
    else buttons()[0]?.focus();
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
    // In the search field only ↓ (to the first item), Esc and Tab are the menu's: the other keys type.
    if (ev.target instanceof HTMLInputElement && !['ArrowDown', 'Escape', 'Tab'].includes(ev.key)) return;
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
    <div ref={ref} className={className ? `mm ${className}` : 'mm'} role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
      {top ? <div className="mm-top">{top}</div> : null}
      {items.map((e) => {
        if (e.kind === 'sep') return <div key={e.key} className="msep" role="separator" />;
        if (e.kind === 'head') return <div key={e.key} className="mhd">{e.label}</div>;
        if (e.kind === 'note') return <div key={e.key} className="mnote">{e.label}</div>;
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
    // Link to lead ▾ opens its menu where this one was.
    item('link', t('Link to lead'), Icons.link, { crm: true, onSelect: () => commands.run('link', target, at) }),
    item('log', t('Log as activity'), Icons.activity, { crm: true }),
    item('task', t('Create task'), Icons.task, { crm: true }),
    item('openLead', t('Open lead'), Icons.external, { crm: true }),
  ];
  return <Menu at={at} label={t('Message actions')} items={items} onClose={onClose} />;
}

const sortText = (t: TFn, k: ListSort) => ({ date: t('Date'), from: t('From'), lead: t('Lead'), stage: t('Lead stage'), size: t('Size') })[k];
/** From and Lead sort by name: their directions read A to Z / Z to A. */
const BY_NAME: readonly ListSort[] = ['from', 'lead'];

/**
 * Sort by (the list's sort button and the View tab): Date, From, Lead, Lead stage, Size | the direction, Newest on top /
 * Oldest on top, or A to Z / Z to A (first) for From and Lead. Choosing From or Lead starts at A to Z.
 */
export function sortEntries(t: TFn, sort: ListSort, dir: 'asc' | 'desc', setQuery: (change: Record<string, string | undefined>) => void): MenuEntry[] {
  const items: MenuEntry[] = [
    ...MAIL_SORTS.map((k): MenuEntry => ({
      key: k, label: sortText(t, k), checked: sort === k,
      onSelect: () => setQuery({ sort: k === 'date' ? undefined : k, dir: BY_NAME.includes(k) ? 'asc' : undefined }),
    })),
    { kind: 'sep', key: 'sep' },
    ...(['desc', 'asc'] as const).map((d): MenuEntry => ({
      key: d,
      label: BY_NAME.includes(sort) ? (d === 'asc' ? t('A to Z') : t('Z to A')) : d === 'desc' ? t('Newest on top') : t('Oldest on top'),
      checked: dir === d,
      onSelect: () => setQuery({ dir: d === 'desc' ? undefined : 'asc' }),
    })),
  ];
  // A to Z first for names (Outlook).
  if (BY_NAME.includes(sort)) items.push(...items.splice(items.length - 2, 1));
  return items;
}

/**
 * New mail ▾ (mockup `mNew`): New mail; New from template, every team template with the user's language first (an
 * `.oft` marked), each opening the New message page with that template filled (`onNew(templateId)`); Manage templates….
 */
export function NewMailMenu({ at, onNew, onClose }: { at: { x: number; y: number }; onNew: (templateId?: number) => void; onClose: () => void }) {
  const t = useT();
  const me = useCurrentUser();
  const navigate = useNavigate();
  const { data: templates } = useTemplates();
  const list = [...(templates ?? [])].sort((a, b) => Number(b.language === me.language) - Number(a.language === me.language));
  const items: MenuEntry[] = [
    { key: 'new', label: t('New mail'), icon: Icons.mailplus, onSelect: () => onNew() },
    { kind: 'sep', key: 's1' },
    { kind: 'head', key: 'h', label: t('New from template') },
    ...list.map((tp): MenuEntry => ({
      key: `tp${tp.id}`, label: tp.name, icon: Icons.template, title: tp.subject, hint: tp.sourceType === 'oft' ? '.oft' : undefined,
      onSelect: () => onNew(tp.id),
    })),
    { kind: 'sep', key: 's2' },
    { key: 'manage', label: t('Manage templates…'), icon: Icons.settings, onSelect: () => navigate('/settings/templates') },
  ];
  return <Menu at={at} label={t('More new mail options')} items={items} onClose={onClose} />;
}

const followText = (t: TFn, k: FollowUpKey) => ({
  laterToday: t('Later today'), tomorrow: t('Tomorrow'), nextWeek: t('Next week'), twoWeeks: t('In 2 weeks'),
})[k];

/** `27 Nov, 09:00`: a follow-up's day and 24-hour time as the menu and its toast show them. */
export const followUpWhen = (date: string, time: string, language: string) => `${dayMonthLabel(date, language)}, ${time}`;

/**
 * Follow-up ▾ (mockup `mFollow`, replaces Outlook's Snooze): Lead follow-up · {lead}, then Later today 17:00 (before
 * 17:00 only), Tomorrow, Next week, In 2 weeks at 09:00 in the user's zone, Choose date and time… (a small dialog), Clear
 * follow-up and the note. Sets the linked lead's next follow-up through the commands (`followUp`).
 */
export function FollowUpMenu({ at, target, commands, onClose }: { at: { x: number; y: number }; target: MailTarget; commands: Commands; onClose: () => void }) {
  const t = useT();
  const me = useCurrentUser();
  const [menuOpen, setMenuOpen] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const now = localNow(me.timezone);
  const [date, setDate] = useState(() => addDays(now.day, 1));
  const [time, setTime] = useState('09:00');
  // Choosing an item closes the menu first: the whole thing goes unless Choose date and time… opened the dialog.
  useEffect(() => {
    if (!menuOpen && !choosing) onClose();
  }, [menuOpen, choosing]);
  const set = (arg: { date: string; time: string } | { clear: true }) => commands.run('followUp', target, arg);

  const items: MenuEntry[] = [
    { kind: 'head', key: 'h', label: t('Lead follow-up · {lead}', { lead: target.item?.leadNumber ?? '' }) },
    ...followUpChoices(now.day, now.time).map((c): MenuEntry => ({
      key: c.key, label: followText(t, c.key), icon: Icons.followup, crm: true, hint: followUpWhen(c.date, c.time, me.language),
      onSelect: () => set({ date: c.date, time: c.time }),
    })),
    { key: 'choose', label: t('Choose date and time…'), icon: Icons.meeting, crm: true, onSelect: () => setChoosing(true) },
    { kind: 'sep', key: 's' },
    { key: 'clear', label: t('Clear follow-up'), icon: Icons.x, onSelect: () => set({ clear: true }) },
    { kind: 'note', key: 'note', label: t("Sets the lead's next follow-up and adds it to Tasks. Replaces Outlook's Snooze.") },
  ];
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  return (
    <>
      {menuOpen ? (
        <Menu
          at={at}
          label={t('Follow-up')}
          items={items}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      {choosing ? (
        <Modal
          title={t('Choose date and time')}
          onClose={() => setChoosing(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setChoosing(false)}>{t('Cancel')}</button>
              <button
                type="button"
                className="btn primary"
                disabled={!valid}
                onClick={() => {
                  set({ date, time });
                  setChoosing(false);
                }}
              >
                {t('Set follow-up')}
              </button>
            </>
          }
        >
          <div className="wm-fu-pick">
            <div>
              <label className="lbl" htmlFor="wm-fu-date">{t('Date')}</label>
              <input id="wm-fu-date" className="in" type="date" value={date} min={now.day} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="lbl" htmlFor="wm-fu-time">{t('Time')}</label>
              <input id="wm-fu-time" className="in" type="time" step={60} value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

type LinkItem = Pick<MailItem | MailDetail, 'id' | 'leadId' | 'leadNumber'>;

/**
 * Link to lead ▾ (mockup `mLink`): a search over the leads (LD number or company, the leads list's search, debounced);
 * empty, the leads Suggested from the address. Each `{number} · {company}` with its stage links the message (`/link`).
 * Then Create lead from this email… (the Link email to a lead window) and Unlink when it is linked. The caller links
 * and unlinks (it outlives the menu, so its toasts still show).
 */
export function LinkMenu({ at, item, onClose, onLink, onUnlink, onCreate }: {
  at: { x: number; y: number };
  item: LinkItem;
  onClose: () => void;
  onLink: (lead: { id: number; number: string }) => void;
  onUnlink: () => void;
  onCreate: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const query = useDebounce(q.trim(), 250);
  const { data: suggested } = useLeadSuggestions(query ? null : item.id);
  const { data: found } = useLeads({ q: query, pageSize: 8, tab: 'all' }, query !== '');
  const leads = query
    ? (found?.items ?? []).filter((l) => !l.archivedAt).map((l) => ({ id: l.id, number: l.number, companyName: l.companyName, status: l.status }))
    : suggested?.items ?? [];
  const items: MenuEntry[] = [
    { kind: 'head', key: 'h', label: query ? t('Leads') : t('Suggested from the address') },
    ...leads.map((l): MenuEntry => ({
      key: `l${l.id}`, label: `${l.number} · ${l.companyName}`, icon: Icons.link, crm: true, hint: leadStatusText(t, l.status),
      checked: l.id === item.leadId ? true : undefined, onSelect: () => onLink(l),
    })),
    ...(leads.length === 0 && (query ? found : suggested) ? [{ kind: 'note' as const, key: 'none', label: query ? t('No leads match.') : t('No suggestions for this address.') }] : []),
    { kind: 'sep', key: 's' },
    { key: 'create', label: t('Create lead from this email…'), icon: Icons.plus, onSelect: onCreate },
    ...(item.leadId !== null
      ? [{ key: 'unlink', label: t('Unlink'), icon: Icons.x, onSelect: onUnlink }]
      : []),
  ];
  return (
    <Menu
      at={at}
      label={t('Link to lead')}
      className="mm-link"
      items={items}
      onClose={onClose}
      top={(
        <input
          type="search"
          className="in"
          value={q}
          placeholder={t('Search leads by LD number or company')}
          aria-label={t('Search leads by LD number or company')}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
    />
  );
}
