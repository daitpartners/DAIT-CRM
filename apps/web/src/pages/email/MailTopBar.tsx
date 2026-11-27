import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSyncNow, type MailFilter, type MailMeta } from '../../api/mail';
import { useCurrentUser } from '../../api/useCurrentUser';
import { Icons } from '../../components/Icons';
import { Topbar } from '../../components/Topbar';
import { useToast } from '../../components/Toast';
import { useFormatDate } from '../../hooks/useFormatDate';
import { useT } from '../../i18n/useT';

/** The Filters panel's text fields: the list API refuses more than 200 characters (MailListQuery). */
const FIELD_MAX = 200;

/** The search box and the Filters panel's fields, for the address (`owner`: `me` or a user id). */
export type MailSearch = {
  s: string; from: string; to: string; subject: string; leadq: string; owner: string;
  date: '' | NonNullable<MailFilter['date']>; since: string; until: string; att: boolean;
};

const fromFilter = (f: MailFilter): MailSearch => ({
  s: f.s ?? '', from: f.from ?? '', to: f.to ?? '', subject: f.subject ?? '', leadq: f.leadQ ?? '',
  owner: f.owner === undefined ? '' : String(f.owner), date: f.date ?? '', since: f.since ?? '', until: f.until ?? '', att: !!f.attachments,
});

const EMPTY: MailSearch = { s: '', from: '', to: '', subject: '', leadq: '', owner: '', date: '', since: '', until: '', att: false };

type MailTopBarProps = {
  meta: MailMeta | undefined;
  /** Whose mail the list shows (`undefined` = your own mailbox). */
  mailOf: 'all' | number | undefined;
  filter: MailFilter;
  /** The search box was submitted. */
  onSearch: (s: string) => void;
  /** The Filters panel's Search (or Clear filters, with every field empty). */
  onFilters: (f: MailSearch) => void;
};

/**
 * The Email screen's top bar (web-mail release 2, mockup 2026-11-26-outlook-mail): the title and the mailbox line (or
 * release 1's team line), the "Search lead mail" box with its Filters panel (From, To, Subject, Lead, Owner = the lead's
 * owner, Date, Has attachments), and Sync now (or Connect Microsoft 365). The panel closes on Search, Escape or a click
 * outside it.
 */
export function MailTopBar({ meta, mailOf, filter, onSearch, onFilters }: MailTopBarProps) {
  const t = useT();
  const toast = useToast();
  const me = useCurrentUser();
  const { relative } = useFormatDate();
  const sync = useSyncNow();
  const [text, setText] = useState(filter.s ?? '');
  useEffect(() => setText(filter.s ?? ''), [filter.s]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MailSearch>(EMPTY);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const away = (e: MouseEvent) => {
      const at = e.target as Node;
      if (!panelRef.current?.contains(at) && !toggleRef.current?.contains(at)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const openPanel = () => {
    if (open) return setOpen(false);
    setDraft(fromFilter(filter));
    setOpen(true);
  };
  const set = <K extends keyof MailSearch>(k: K, v: MailSearch[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const mailbox = meta?.mailbox ?? null;
  const connected = mailbox?.status === 'connected';
  const teamWho = mailOf === 'all' ? t('everyone') : meta?.mailUsers.find((u) => u.id === mailOf)?.name;
  const sub = !meta ? null : mailOf !== undefined ? (
    <>
      <span>{t('Team view · lead mail of {who}', { who: teamWho ?? '' })}</span> <span className="badge b-warn">{t('View only')}</span> {t('for other mailboxes')}
    </>
  ) : mailbox ? (
    <>
      {t('{address} · Microsoft 365', { address: mailbox.address })}{' '}
      {connected ? <span className="badge b-ok">{t('Connected')}</span> : <span className="badge b-warn">{t('Needs reconnecting')}</span>} ·{' '}
      {mailbox.lastSyncAt ? t('synced {when}', { when: relative(mailbox.lastSyncAt) }) : t('synced never')} · {t('lead mail only')}
    </>
  ) : (
    <>
      {me.email} · <span className="badge b-warn">{t('Mailbox not connected')}</span>
    </>
  );

  return (
    <Topbar title={t('Email')} sub={sub} className="wm-top">
      <form
        className="msearch"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(text.trim());
        }}
      >
        <span className="ico" aria-hidden="true">{Icons.search}</span>
        <input type="search" value={text} placeholder={t('Search lead mail')} aria-label={t('Search lead mail')} onChange={(e) => setText(e.target.value)} />
        <button
          ref={toggleRef}
          type="button"
          className="sfilter"
          aria-expanded={open}
          aria-controls="mail-filters"
          title={t('Search filters')}
          onClick={openPanel}
        >
          <span className="ico" aria-hidden="true">{Icons.filter}</span>
          {t('Filters')}
        </button>
      </form>
      <div className="mtop-r">
        {connected ? (
          <button
            type="button"
            className="btn sm"
            title={t('Fetch new lead mail now')}
            disabled={sync.isPending}
            onClick={() => sync.mutate(mailbox.id, { onSuccess: () => toast(t('Sync started — new mail appears in a few seconds')), onError: () => toast(t('Sync could not start. Try again.'), 'warn') })}
          >
            <span className="ico" aria-hidden="true">{Icons.sync}</span>
            {t('Sync now')}
          </button>
        ) : (
          <Link className="btn sm" to="/settings/connections">
            {t('Connect Microsoft 365')}
          </Link>
        )}
      </div>
      {open ? (
        <div
          id="mail-filters"
          className="spanel"
          ref={panelRef}
          role="group"
          aria-label={t('Search filters')}
          onKeyDown={(e) => {
            // Enter in a field searches, as the panel's Search button.
            if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
              e.preventDefault();
              setOpen(false);
              onFilters({ ...draft, s: text.trim() });
            }
          }}
        >
          <label htmlFor="sf-from">{t('From')}</label>
          <input ref={firstRef} id="sf-from" className="in" maxLength={FIELD_MAX} placeholder={t('Name or address')} value={draft.from} onChange={(e) => set('from', e.target.value)} />
          <label htmlFor="sf-to">{t('To')}</label>
          <input id="sf-to" className="in" maxLength={FIELD_MAX} placeholder={t('Name or address')} value={draft.to} onChange={(e) => set('to', e.target.value)} />
          <label htmlFor="sf-subject">{t('Subject')}</label>
          <input id="sf-subject" className="in" maxLength={FIELD_MAX} placeholder={t('Words in the subject')} value={draft.subject} onChange={(e) => set('subject', e.target.value)} />
          <label htmlFor="sf-lead">{t('Lead')}</label>
          <input id="sf-lead" className="in" maxLength={FIELD_MAX} placeholder={t('LD number or company')} value={draft.leadq} onChange={(e) => set('leadq', e.target.value)} />
          <label htmlFor="sf-owner">{t('Owner')}</label>
          <select id="sf-owner" className="in" value={draft.owner} onChange={(e) => set('owner', e.target.value)}>
            <option value="">{t('Anyone')}</option>
            <option value="me">{t('Me')}</option>
            {(meta?.leadOwners ?? []).filter((u) => u.id !== me.id).map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          <label htmlFor="sf-date">{t('Date')}</label>
          <select id="sf-date" className="in" value={draft.date} onChange={(e) => set('date', e.target.value as MailSearch['date'])}>
            <option value="">{t('Any time')}</option>
            <option value="today">{t('Today')}</option>
            <option value="7d">{t('Last 7 days')}</option>
            <option value="30d">{t('Last 30 days')}</option>
            <option value="12m">{t('Last 12 months')}</option>
            <option value="custom">{t('Custom range…')}</option>
          </select>
          {draft.date === 'custom' ? (
            <>
              <label htmlFor="sf-since">{t('Start date')}</label>
              <input id="sf-since" type="date" className="in" value={draft.since} max={draft.until || undefined} onChange={(e) => set('since', e.target.value)} />
              <label htmlFor="sf-until">{t('End date')}</label>
              <input id="sf-until" type="date" className="in" value={draft.until} min={draft.since || undefined} onChange={(e) => set('until', e.target.value)} />
            </>
          ) : null}
          <span />
          <label className="check sp-check">
            <input type="checkbox" checked={draft.att} onChange={(e) => set('att', e.target.checked)} /> {t('Has attachments')}
          </label>
          <div className="sp-act">
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setDraft(EMPTY);
                setOpen(false);
                onFilters({ ...EMPTY, s: text.trim() });
              }}
            >
              {t('Clear filters')}
            </button>
            <button
              type="button"
              className="btn sm primary"
              onClick={() => {
                setOpen(false);
                onFilters({ ...draft, s: text.trim() });
              }}
            >
              {t('Search')}
            </button>
          </div>
        </div>
      ) : null}
    </Topbar>
  );
}
