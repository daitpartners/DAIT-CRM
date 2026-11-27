import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { MailMeta, MailView } from '../../api/mail';
import { Icons } from '../../components/Icons';
import type { TFn } from '../../i18n/useT';
import { useT } from '../../i18n/useT';

/** A folder or Leads view's name; `teamView` (Mail of: Everyone or one user) names My leads "Team leads". */
export function viewLabel(t: TFn, v: MailView, teamView = false): string {
  switch (v) {
    case 'inbox': return t('Inbox');
    case 'sent': return t('Sent items');
    case 'drafts': return t('Drafts');
    case 'scheduled': return t('Scheduled|mail');
    case 'flagged': return t('Flagged');
    case 'archive': return t('Archive');
    case 'deleted': return t('Deleted items');
    case 'awaiting': return t('Awaiting reply');
    case 'due': return t('Follow-up due today');
    case 'mine': return teamView ? t('Team leads') : t('My leads');
  }
}

type FolderPaneProps = {
  view: MailView;
  meta: MailMeta | undefined;
  /** Whose mail the list shows (`undefined` = your own mailbox). */
  mailOf: 'all' | number | undefined;
  /** The user may read the team's lead mail (`view_team_mail`): the "Mail of:" picker shows. */
  team: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** The Email screen's address with some query values changed. */
  href: (change: Record<string, string | undefined>) => string;
};

/**
 * The folder pane (web-mail release 2, mockup 2026-11-26-outlook-mail): release 1's "Mail of:" picker (Administrators and
 * Managers; team mail is view only), the mailbox folders with their counts, the Leads group (Awaiting reply, Follow-up
 * due today, My leads / Team leads), and the "lead mail only" note with its Why? popover. « folds it to a strip of icons,
 * remembered in this browser (the caller keeps the flag).
 */
export function FolderPane({ view, meta, mailOf, team, collapsed, onToggle, href }: FolderPaneProps) {
  const t = useT();
  const navigate = useNavigate();
  const teamView = mailOf !== undefined;
  const counts = meta?.counts;
  const foldName = collapsed ? t('Expand folders') : t('Collapse folders');

  const folder = (v: MailView, icon: ReactNode, count?: number, tone: '' | 'mute' | 'hot' = '') => {
    const name = viewLabel(t, v, teamView);
    return (
      <Link
        key={v}
        className={view === v ? 'fold on' : 'fold'}
        to={href({ folder: v === 'inbox' ? undefined : v })}
        title={name}
        aria-current={view === v ? 'page' : undefined}
      >
        <span className="ico" aria-hidden="true">{icon}</span>
        <span className="fold-l">{name}</span>
        {count ? <span className={tone ? `n ${tone}` : 'n'}>{count}</span> : null}
      </Link>
    );
  };

  return (
    <nav id="mail-folders" className={collapsed ? 'fpane collapsed' : 'fpane'} aria-label={t('Mail folders')}>
      <div className="fp-head">
        {team ? (
          <div className="mo-wrap">
            <label className="mo-l" htmlFor="mail-of">{t('Mail of:')}</label>
            <select
              id="mail-of"
              className="chip mailof"
              title={t('Administrators and managers. Team mail is view only.')}
              value={mailOf === undefined ? '' : String(mailOf)}
              onChange={(e) => navigate(href({ mailof: e.target.value || undefined }))}
            >
              <option value="">{t('Me')}</option>
              <option value="all">{t('Everyone')}</option>
              {(meta?.mailUsers ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        {/* One toggle in both states, so it keeps the keyboard focus when pressed. */}
        <button
          type="button"
          className="icon-btn fp-toggle"
          aria-expanded={!collapsed}
          aria-controls="mail-folders"
          aria-label={foldName}
          title={foldName}
          onClick={onToggle}
        >
          {Icons.dbl}
        </button>
      </div>
      <div className="fp-scroll">
        {folder('inbox', Icons.inbox, counts?.inbox)}
        {folder('sent', Icons.send)}
        {folder('drafts', Icons.draft, counts?.drafts, 'mute')}
        {folder('scheduled', Icons.clock, counts?.scheduled, 'mute')}
        {folder('flagged', Icons.flag, counts?.flagged, 'mute')}
        {folder('archive', Icons.archive)}
        {folder('deleted', Icons.trash)}
        <div className="fsec">
          <span className="ico" aria-hidden="true">{Icons.down}</span>
          {t('Leads')}
        </div>
        {folder('awaiting', Icons.hourglass, counts?.awaiting, 'mute')}
        {folder('due', Icons.followup, counts?.due, 'hot')}
        {folder('mine', Icons.users, counts?.leads, 'mute')}
      </div>
      <WhyNote />
    </nav>
  );
}

/**
 * The folder pane's foot (web-mail release 1, mockup state 5): the CRM keeps lead mail only, and Why? opens what it
 * keeps. The popover is placed beside the note in the window (the pane scrolls and would clip it); a click outside,
 * Escape or scrolling closes it.
 */
function WhyNote() {
  const t = useT();
  const noteRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const away = (e: MouseEvent) => {
      if (!noteRef.current?.contains(e.target as Node)) setAt(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAt(null);
    // It is placed once: scrolling (the page on a phone, the pane on desktop) closes it rather than leave it behind.
    const scrolled = () => setAt(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [at]);
  const toggle = () => {
    if (at) return setAt(null);
    const r = noteRef.current?.getBoundingClientRect();
    setAt({ left: Math.max(8, r?.left ?? 0), bottom: Math.max(8, window.innerHeight - (r?.top ?? 0) + 6) });
  };
  return (
    <div className="fp-foot" ref={noteRef}>
      {Icons.shield}
      <span>
        {t('Only mail with your leads and contacts is shown here')} ·{' '}
        <button type="button" className="mail-why-btn" aria-expanded={!!at} aria-controls="mail-why-pop" onClick={toggle}>
          {t('Why?')}
        </button>
      </span>
      {at ? (
        <div id="mail-why-pop" className="mail-why-pop" style={{ left: at.left, bottom: at.bottom }}>
          <strong>{t('What the CRM keeps')}</strong>
          <ul>
            <li>{t("Mail to and from your leads' and contacts' addresses.")}</li>
            <li>{t("Mail from a lead company's own domain (not gmail.com, outlook.com and similar).")}</li>
            <li>{t('The past 12 months are fetched when a lead is added.')}</li>
          </ul>
          <div>{t('Personal and other work mail stays in Outlook only.')}</div>
        </div>
      ) : null}
    </div>
  );
}
