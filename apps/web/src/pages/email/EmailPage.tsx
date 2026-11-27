import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MAIL_CHIPS, MAIL_SORTS, MAIL_VIEWS, useMailList, useMailMessage, useMailMeta, type ListSort, type MailChip, type MailFilter, type MailItem, type MailView } from '../../api/mail';
import { clientName } from '../../api/companies';
import { useCurrentUser } from '../../api/useCurrentUser';
import { useFormatDate } from '../../hooks/useFormatDate';
import { useStoredFlag } from '../../hooks/useStoredFlag';
import { firstName, initials } from '../../i18n/labels';
import { useT } from '../../i18n/useT';
import { ComposeModal, type ComposeStart } from './ComposeModal';
import { FolderPane, viewLabel } from './FolderPane';
import { MailTopBar, type MailSearch } from './MailTopBar';
import { Reader } from './Reader';

/** Where the Email screen fits the window and the list scrolls in its own column (app.css). */
const WIDE = '(min-width:1100px)';

const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined => ((list as readonly string[]).includes(v ?? '') ? (v as T) : undefined);
const DATES = ['today', '7d', '30d', '12m', 'custom'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `?mailof=` (`all` or a user id) for a user with `view_team_mail`; anything else, or no right, is your own mailbox. */
function mailOfParam(v: string | null, team: boolean): 'all' | number | undefined {
  if (!team || !v) return undefined;
  return v === 'all' ? 'all' : num(v);
}

/**
 * The list's filters from the address: the folder, Mail of, the search box and Filters panel (`s`, `from`, `to`,
 * `subject`, `leadq`, `owner`, `date`, `since`, `until`, `att`), the list's quick filter, conversation view and sort
 * (`chip`, `conv`, `sort`, `dir`), and `company` / `lead` / `project` from links such as the Projects list's Email
 * buttons. Values the API would refuse are left out.
 */
function filterFrom(params: URLSearchParams, mailOf: 'all' | number | undefined): MailFilter {
  const text = (k: string) => params.get(k)?.trim() || undefined;
  const owner = params.get('owner');
  const date = oneOf(DATES, params.get('date'));
  const day = (k: string) => (date === 'custom' && DAY.test(params.get(k) ?? '') ? params.get(k)! : undefined);
  const f: MailFilter = {
    view: oneOf(MAIL_VIEWS, params.get('folder')) ?? 'inbox',
    company: num(params.get('company')), lead: num(params.get('lead')), project: num(params.get('project')),
    s: text('s'), from: text('from'), to: text('to'), subject: text('subject'), leadQ: text('leadq'),
    owner: owner === 'me' ? 'me' : num(owner), date, since: day('since'), until: day('until'),
    attachments: params.get('att') === '1' || undefined,
    chip: oneOf<MailChip>(MAIL_CHIPS, params.get('chip')), conv: params.get('conv') === '0' ? false : undefined,
    sort: oneOf<ListSort>(MAIL_SORTS, params.get('sort')), dir: oneOf(['asc', 'desc'] as const, params.get('dir')),
    ...(mailOf !== undefined ? { mailOf } : {}),
  };
  // Only what is set, so the list's query key (and the request) stays the same for the same filters.
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as MailFilter;
}

/**
 * The Email screen (web-mail release 2, mockup 2026-11-26-outlook-mail): the top bar with the lead-mail search and its
 * Filters panel, the command bar, and the panes (folders, the message list, the reading pane). Your own mailbox, synced
 * every 5 minutes; Administrators and Managers pick "Mail of:" Me / Everyone / one user to read the team's lead mail,
 * view only (web-mail release 1). A link's `company`, `lead` or `project` narrows the list and shows as a removable chip.
 * `?compose=1` (with `company`, `lead`, `project`) opens Compose preset (the Projects list's Email buttons).
 * No page numbers (owner, 23 Nov 2026): the list loads the next 50 when scrolled near its foot.
 */
export function EmailPage() {
  const t = useT();
  const me = useCurrentUser();
  const navigate = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  const teamRight = me.can('view_team_mail');
  const mailOf = mailOfParam(params.get('mailof'), teamRight);
  const filter = filterFrom(params, mailOf);
  const view = filter.view;
  const { data: meta } = useMailMeta(mailOf);
  const { items, total, isLoading, hasNextPage, isFetchingNextPage, isPlaceholderData, fetchNextPage } = useMailList(filter);
  const [compose, setCompose] = useState<ComposeStart | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Another folder, filter or search starts at the top of the list (on desktop its rows scroll inside their column).
  const listKey = JSON.stringify(filter);
  useEffect(() => {
    if (rowsRef.current) rowsRef.current.scrollTop = 0;
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

  const selectedId = num(id ?? null) ?? items[0]?.id ?? null;
  // The message opened from a link (the Reader's own query): a list answered before the open marked it read
  // still shows its row as read.
  const { data: opened } = useMailMessage(num(id ?? null) ?? null);
  const mailbox = meta?.mailbox ?? null;
  const connected = mailbox?.status === 'connected';

  /** Same screen with some query values changed (selection kept only when asked). */
  const href = (change: Record<string, string | undefined>, keepId = false) => {
    const q = new URLSearchParams(params);
    for (const [k, v] of Object.entries(change)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const s = q.toString();
    return `/email${keepId && id ? `/${id}` : ''}${s ? `?${s}` : ''}`;
  };
  const setQuery = (change: Record<string, string | undefined>) => navigate(href(change));

  /** The Filters panel's Search (and Clear filters): its fields and the search box go in the address. */
  const applySearch = (f: MailSearch) => {
    const custom = f.date === 'custom';
    setQuery({
      s: f.s || undefined, from: f.from.trim() || undefined, to: f.to.trim() || undefined, subject: f.subject.trim() || undefined,
      leadq: f.leadq.trim() || undefined, owner: f.owner || undefined, date: f.date || undefined,
      since: custom ? f.since || undefined : undefined, until: custom ? f.until || undefined : undefined, att: f.att ? '1' : undefined,
    });
  };

  // ?page= and ?size= from the old pager (bookmarks, old links) mean nothing now: they leave the address.
  const oldPaging = params.has('page') || params.has('size');
  useEffect(() => {
    if (oldPaging) navigate(href({ page: undefined, size: undefined }, true), { replace: true });
    // Only their arrival in the address should trigger this.
  }, [oldPaging]);

  // A Compose link (`?compose=1&company=…&lead=…&project=…`) opens Compose once; the filters stay in the address.
  const composeLink = params.get('compose') === '1';
  useEffect(() => {
    if (!composeLink) return;
    setCompose({ companyId: filter.company, leadId: filter.lead, projectId: filter.project });
    const q = new URLSearchParams(params);
    q.delete('compose');
    const s = q.toString();
    navigate(`/email${id ? `/${id}` : ''}${s ? `?${s}` : ''}`, { replace: true });
    // Only the link's arrival should trigger this.
  }, [composeLink]);

  // Owner addition (23 Nov 2026): the folder pane folds to a strip, remembered in this browser. The folder and filters
  // live in the address, so folding loses neither.
  const [foldersClosed, setFoldersClosed] = useStoredFlag('dait-mail-folders-collapsed');

  // A link's client / lead / project (release 1's "Show mail for" left the screen): one removable chip naming them
  // ("Linked records" while the names load, or for a record the meta does not list).
  const metaCompany = meta?.companies.find((c) => c.id === filter.company);
  const companyName = metaCompany ? clientName(metaCompany) : undefined;
  const leadNumber = meta?.leads.find((l) => l.id === filter.lead)?.number;
  const metaProject = meta?.projects.find((p) => p.id === filter.project);
  const linked = filter.company || filter.lead || filter.project;
  const chipName = [companyName, leadNumber, metaProject ? `${metaProject.number} · ${metaProject.name}` : undefined].filter(Boolean).join(' · ');
  const teamView = mailOf !== undefined;

  return (
    <div className="wm">
      <MailTopBar meta={meta} mailOf={mailOf} filter={filter} onSearch={(s) => setQuery({ s: s || undefined })} onFilters={applySearch} />

      {meta && !mailbox ? (
        <div className="mail-connect">
          <span>
            <strong>{t('Connect your mailbox to send and receive from the CRM.')}</strong>{' '}
            {t('Your Microsoft 365 Business Basic account works out of the box; sign in once and the CRM syncs mail and calendar through Microsoft Graph.')}
          </span>
          <div className="grow" />
          <Link className="btn primary" to="/settings/connections">
            {t('Connect Microsoft 365')}
          </Link>
        </div>
      ) : null}

      {/* The command bar's slot: Compose until the full command bar arrives. */}
      <div className="wm-cmdbar">
        <button
          type="button"
          className="btn sm primary"
          onClick={() => setCompose({ companyId: filter.company, companyName, leadId: filter.lead, projectId: filter.project })}
        >
          {t('+ Compose')}
        </button>
      </div>

      <div className="wm-panes">
        <FolderPane
          view={view}
          meta={meta}
          mailOf={mailOf}
          team={teamRight}
          collapsed={foldersClosed}
          onToggle={() => setFoldersClosed(!foldersClosed)}
          href={(change) => href(change)}
        />

        <section className="msglist" aria-label={t('Message list')}>
          <div className="msglist-head">
            <strong>{viewLabel(t, view, teamView)}</strong> · {total === 1 ? t('1 message') : t('{n} messages', { n: total })}
            {linked ? (
              <Link className="chip wm-linkchip" to={href({ company: undefined, lead: undefined, project: undefined })} title={t('Clear')}>
                {chipName || t('Linked records')} ✕
              </Link>
            ) : null}
          </div>
          {/* The rows scroll on their own on desktop. */}
          <div className="msglist-rows" ref={rowsRef}>
            {items.map((m) => (
              <MessageRow
                key={m.id}
                m={opened?.id === m.id && opened.isRead ? { ...m, isRead: true } : m}
                on={m.id === selectedId}
                team={teamView}
                to={`/email/${m.id}${params.toString() ? `?${params.toString()}` : ''}`}
              />
            ))}
            {!isLoading && items.length === 0 ? (
              <div className="empty">
                {linked ? t('No messages for this filter in {folder}.', { folder: viewLabel(t, view, teamView) }) : t('Nothing here.')}
              </div>
            ) : null}
            {hasNextPage ? (
              <div className="msglist-more" ref={moreRef} role="status">
                {t('Loading…')}
              </div>
            ) : null}
          </div>
        </section>

        {selectedId !== null ? (
          <Reader
            id={selectedId}
            peek={num(id ?? null) === undefined}
            connected={connected}
            onReply={(start) => setCompose(start)}
            onArchived={() => navigate(href({}, false))}
          />
        ) : (
          <div className="reader empty">{t('Select a message.')}</div>
        )}
      </div>

      {compose ? <ComposeModal start={compose} connected={connected} from={mailbox?.address ?? null} onClose={() => setCompose(null)} /> : null}
    </div>
  );
}

/** `team`: the team view, where each row shows whose mailbox it is in (mockup state 5). */
function MessageRow({ m, on, to, team }: { m: MailItem; on: boolean; to: string; team: boolean }) {
  const t = useT();
  const { relative } = useFormatDate();
  // Prototype list row: rel(e.at).replace(/, /, ' ') — "Today 09:05", no comma.
  const outbound = m.status !== 'received';
  const who = outbound ? t('To: {to}', { to: m.toAddresses.join(', ') }) : m.fromName || m.fromAddress;
  return (
    <Link className={`msg${on ? ' on' : ''}${m.isRead ? '' : ' unread'}`} to={to} aria-current={on ? 'true' : undefined}>
      <span className="av" aria-hidden="true">{initials(m.fromName || m.fromAddress)}</span>
      <span className="msg-main">
        <span className="who">
          <span className="msg-who">{who}</span> <span className="t">{relative(m.occurredAt).replace(', ', ' ')}</span>
        </span>
        <span className="sub">{m.subject || t('(no subject)')}</span>
        <span className="pre">{m.preview}</span>
        <span className="msg-tags">
          {m.leadRestricted && m.leadNumber ? (
            <span className="badge b-grey">{t("{lead} · another owner's lead", { lead: m.leadNumber })}</span>
          ) : m.leadNumber ? (
            <span className="badge b-purple">{m.leadNumber}</span>
          ) : (
            <span className="badge b-warn">{t('Unlinked · create lead?')}</span>
          )}
          {m.projectNumber ? <span className="badge b-ok">{m.projectNumber}</span> : null}
          {m.status === 'failed' ? <span className="badge b-bad">{t('Failed')}</span> : null}
          {m.status === 'queued' || m.status === 'sending' ? <span className="badge b-grey">{t('Sending')}</span> : null}
          {team ? <span className="mail-mbx">{m.viewOnly ? t("{name}'s mailbox", { name: firstName(m.owner.name) }) : t('Your mailbox')}</span> : null}
        </span>
      </span>
    </Link>
  );
}
